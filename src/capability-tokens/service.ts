// The token service -- Feature 1005, capability tokens.
//
// Mint, validate, consume, revoke. The design's route table (Identity &
// Access / Passwordless capability links) is the single source for types,
// lifespans and revocation triggers; ADR 0004 is the single source for the
// token's shape. Both are read-only here -- this is where they are built,
// never where they are decided.
import { createHash, randomBytes } from "node:crypto";
import { CapabilityTokenType } from "../generated/prisma/client.js";
import type { CapabilityTokenDb, CapabilityTokenResult, LinkSpec, MintedLink } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Decision 4: singleUse is decided by type, never by the caller. */
const SINGLE_USE_BY_TYPE: Record<CapabilityTokenType, boolean> = {
  [CapabilityTokenType.respond]: true,
  [CapabilityTokenType.track]: false,
  [CapabilityTokenType.review]: true,
  [CapabilityTokenType.approve]: true,
};

/** The route table's paths (Passwordless capability links). */
const PATH_BY_TYPE: Record<CapabilityTokenType, string> = {
  [CapabilityTokenType.respond]: "/a",
  [CapabilityTokenType.track]: "/track",
  [CapabilityTokenType.review]: "/review",
  [CapabilityTokenType.approve]: "/approve",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set -- see .env.example`);
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Decision 5, the outer ceilings and the send-time clock: respond is the only
 * type the caller stamps -- it is checked here defensively, but the real gate
 * is `assertLinkSpec`, run at ASK time (AC9) so a bad spec never reaches a
 * queued row that cannot mint.
 */
function expiryFor(spec: LinkSpec, mintedAt: Date): Date {
  switch (spec.type) {
    case CapabilityTokenType.respond: {
      if (spec.expiresAt === undefined) {
        throw new Error('capability link type "respond" requires an expiresAt');
      }
      return new Date(spec.expiresAt);
    }
    case CapabilityTokenType.review:
      return new Date(mintedAt.getTime() + 30 * DAY_MS);
    case CapabilityTokenType.track:
      return new Date(mintedAt.getTime() + 365 * DAY_MS);
    case CapabilityTokenType.approve:
      return new Date(mintedAt.getTime() + 60 * DAY_MS);
  }
}

/**
 * AC9: a link spec that names a type needing a caller expiry but carries none
 * is refused HERE, in the caller's own stack trace -- before any row is ever
 * written. `sendNotification` calls this at ask time; `mintCapabilityLink`
 * calls it again, defensively, since it also builds the same expiry.
 */
export function assertLinkSpec(spec: LinkSpec): void {
  if (spec.type === CapabilityTokenType.respond && spec.expiresAt === undefined) {
    throw new Error(
      'capability link type "respond" requires an expiresAt (the caller knows the proposed slot start; the module does not)',
    );
  }
}

/**
 * Mint one token and build its URL. Decision 3: this runs inside the
 * dispatcher's send attempt, every attempt -- a retry mints a fresh token,
 * and the raw value of an earlier attempt is unrecoverable by design.
 *
 * MODULE-INTERNAL BY CONVENTION: only the notification dispatcher calls this,
 * at send time (ADR 0004, "minting belongs to the Notification module") -- a
 * link can never exist outside a delivered message. It is exported (not
 * hidden inside the notifications module) only so this feature's own tests
 * can prove AC1, AC4, AC5 and AC7 directly against the service.
 */
export async function mintCapabilityLink(
  client: CapabilityTokenDb,
  spec: LinkSpec,
): Promise<MintedLink> {
  assertLinkSpec(spec);
  const mintedAt = new Date();
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(raw);

  const row = await client.capabilityToken.create({
    data: {
      tokenHash,
      type: spec.type,
      jobId: spec.jobId ?? null,
      assignmentId: spec.assignmentId ?? null,
      singleUse: SINGLE_USE_BY_TYPE[spec.type],
      expiresAt: expiryFor(spec, mintedAt),
    },
  });

  const origin = requireEnv("WEB_ORIGIN");
  return { url: `${origin}${PATH_BY_TYPE[spec.type]}/${raw}`, tokenId: row.id };
}

/**
 * Decision 6: read-only and repeatable. Opening a page never burns a token --
 * checks hash exists, not expired, not used, and the type matches the route
 * asking.
 */
export async function validateCapabilityToken(
  client: CapabilityTokenDb,
  rawToken: string,
  expectedType: CapabilityTokenType,
): Promise<CapabilityTokenResult> {
  const row = await client.capabilityToken.findUnique({
    where: { tokenHash: sha256Hex(rawToken) },
  });
  if (row === null) return { ok: false, reason: "not found" };
  if (row.type !== expectedType) return { ok: false, reason: "wrong type" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, tokenId: row.id, jobId: row.jobId, assignmentId: row.assignmentId };
}

/**
 * Decision 6: consuming (usedAt stamped) happens in the same transaction as
 * the action it gates -- the caller passes that transaction's client in.
 *
 * REFUSED FOR A MULTI-USE TYPE (review finding R1.2): decision 6 says
 * consuming happens "only for single-use types" -- track is meant to work
 * from two phones in one household, repeatedly, so burning it on a stray
 * `consumeCapabilityToken` call (a validate/consume mix-up has the same
 * signature) would silently and permanently kill Sarah's track link.
 */
export async function consumeCapabilityToken(
  client: CapabilityTokenDb,
  rawToken: string,
  expectedType: CapabilityTokenType,
): Promise<CapabilityTokenResult> {
  const row = await client.capabilityToken.findUnique({
    where: { tokenHash: sha256Hex(rawToken) },
  });
  if (row === null) return { ok: false, reason: "not found" };
  if (row.type !== expectedType) return { ok: false, reason: "wrong type" };
  if (!row.singleUse) return { ok: false, reason: "not single-use -- validate instead of consume" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  await client.capabilityToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return { ok: true, tokenId: row.id, jobId: row.jobId, assignmentId: row.assignmentId };
}

/**
 * Decision 7, revocation hook: reassigning or cancelling an assignment kills
 * its respond token (the old SMS goes dead). Row deletion IS revocation
 * (ADR 0004). Returns how many rows were deleted.
 */
export async function revokeByAssignment(
  client: CapabilityTokenDb,
  assignmentId: string,
  types?: CapabilityTokenType[],
): Promise<number> {
  const { count } = await client.capabilityToken.deleteMany({
    where: { assignmentId, ...(types === undefined ? {} : { type: { in: types } }) },
  });
  return count;
}

/**
 * Decision 7, revocation hook: cancelling a job kills its track token.
 * Returns how many rows were deleted.
 */
export async function revokeByJob(
  client: CapabilityTokenDb,
  jobId: string,
  types?: CapabilityTokenType[],
): Promise<number> {
  const { count } = await client.capabilityToken.deleteMany({
    where: { jobId, ...(types === undefined ? {} : { type: { in: types } }) },
  });
  return count;
}

/**
 * Decision 7, revocation hook: the outer ceilings this module stamps on
 * track/approve are event-expired in the design, so the event feature (job
 * closing, settlement re-sweep) tightens the clock once it knows the real
 * terminal date. Returns how many rows were tightened.
 */
export async function tightenExpiryByJob(
  client: CapabilityTokenDb,
  jobId: string,
  type: CapabilityTokenType,
  at: Date,
): Promise<number> {
  const { count } = await client.capabilityToken.updateMany({
    where: { jobId, type },
    data: { expiresAt: at },
  });
  return count;
}
