// Feature 1005, capability tokens
//
// AC1  minted at send, stored hashed, the raw value nowhere in the database
// AC2  validate returns scope, refuses a mismatched type
// AC3  validate is repeatable; consume burns it once
// AC4  expiry: a past token is refused; review stamps 30 days from send
// AC5  track is multi-use; a re-send mints a second valid token
// AC6  revocation hooks: by assignment, by job
// AC7  a retry mints a fresh token; the delivered URL is the valid one
// AC8  tightenExpiryByJob moves the clock; validation refuses it after
// AC9  a caller-expiry type with none given is refused at ASK time
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { backdate, recordingAdapter, seedCast, setProviders, type CastIds } from "./helpers/notifications.js";
import {
  reviewLinkEmail,
  respondLinkSms,
  seedJob1042,
  trackLinkSms,
  type JobAndAssignment,
} from "./helpers/capability-tokens.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import {
  CapabilityTokenType,
  consumeCapabilityToken,
  mintCapabilityLink,
  revokeByAssignment,
  revokeByJob,
  tightenExpiryByJob,
  validateCapabilityToken,
} from "../src/capability-tokens/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let cast: CastIds;
let refs: JobAndAssignment;

const sms = recordingAdapter("test-sms", "sms");
const email = recordingAdapter("test-email", "email");

const HOUR_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The token is the URL's last path segment -- /a/<token>, /track/<token>, ... */
function extractToken(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

beforeAll(() => {
  db = testClient();
  registerTemplate(respondLinkSms);
  registerTemplate(trackLinkSms);
  registerTemplate(reviewLinkEmail);
  registerProvider(sms);
  registerProvider(email);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  refs = await seedJob1042(db, cast);
  await setProviders(db, { smsProvider: sms.name, emailProvider: email.name });
  sms.reset();
  email.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC1 -- minted at send, stored hashed", () => {
  test("AC1: dispatching Bob's respond link sends a message with the URL, and one hashed row", async () => {
    await sendNotification(
      {
        type: "respond_link_test",
        channel: "sms",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: `respond_link_test:assignment:${refs.assignmentId}`,
        relatedType: "assignment",
        relatedId: refs.assignmentId,
        jobId: refs.jobId,
        context: { jobReference: "JOB-1042" },
        capabilityLink: {
          type: CapabilityTokenType.respond,
          assignmentId: refs.assignmentId,
          expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        },
      },
      db,
    );

    expect(await drainOnce(db)).toBe(1);
    expect(sms.sent).toHaveLength(1);

    const text = sms.sent[0]?.message.text ?? "";
    expect(text).toContain(`${process.env["WEB_ORIGIN"]}/a/`);

    expect(await db.capabilityToken.count()).toBe(1);
    const row = await db.capabilityToken.findFirstOrThrow();
    expect(row.type).toBe("respond");
    expect(row.singleUse).toBe(true);
    expect(row.assignmentId).toBe(refs.assignmentId);
    expect(row.jobId).toBeNull();

    const raw = extractToken(text);
    // the raw token is never stored -- looking it up as if it were the hash finds nothing
    expect(await db.capabilityToken.findUnique({ where: { tokenHash: raw } })).toBeNull();
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);
  });
});

describe("AC2 -- validate returns scope, refuses a mismatched type", () => {
  test("AC2: a respond token validates as respond and returns its assignment id; refused as track", async () => {
    const { url } = await mintCapabilityLink(db, {
      type: CapabilityTokenType.respond,
      assignmentId: refs.assignmentId,
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    const raw = extractToken(url);

    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).toMatchObject({
      ok: true,
      assignmentId: refs.assignmentId,
    });
    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.track)).toEqual({
      ok: false,
      reason: "wrong type",
    });
  });
});

describe("AC3 -- validate is repeatable; consume burns it once", () => {
  test("AC3: an unused token validates twice; after consume, both validate and consume refuse", async () => {
    const { url } = await mintCapabilityLink(db, {
      type: CapabilityTokenType.respond,
      assignmentId: refs.assignmentId,
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    const raw = extractToken(url);

    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);

    expect((await consumeCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);

    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).toEqual({
      ok: false,
      reason: "used",
    });
    expect(await consumeCapabilityToken(db, raw, CapabilityTokenType.respond)).toEqual({
      ok: false,
      reason: "used",
    });
  });

  test("AC3: consuming a multi-use (track) token is refused; it stays valid, usedAt never set", async () => {
    // Review finding R1.2 -- a validate/consume mix-up must not silently and
    // permanently burn a household's shared track link.
    const { url } = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId: refs.jobId });
    const raw = extractToken(url);

    expect(await consumeCapabilityToken(db, raw, CapabilityTokenType.track)).toEqual({
      ok: false,
      reason: "not single-use -- validate instead of consume",
    });
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.track)).ok).toBe(true);

    expect((await db.capabilityToken.findFirstOrThrow()).usedAt).toBeNull();
  });
});

describe("AC4 -- expiry", () => {
  test("AC4: a token past its expiresAt is refused", async () => {
    const { url } = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId: refs.jobId });
    const raw = extractToken(url);

    await db.capabilityToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.track)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("AC4: Sarah's review token is minted with expiresAt exactly 30 days after its send", async () => {
    const before = Date.now();
    await sendNotification(
      {
        type: "review_link_test",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `review_link_test:job:${refs.jobId}`,
        relatedType: "job",
        relatedId: refs.jobId,
        jobId: refs.jobId,
        capabilityLink: { type: CapabilityTokenType.review, jobId: refs.jobId },
      },
      db,
    );
    expect(await drainOnce(db)).toBe(1);
    const after = Date.now();

    const row = await db.capabilityToken.findFirstOrThrow({ where: { type: "review" } });
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
  });

  test("AC4: approve is minted single-use with a 60-day outer ceiling, at the /approve path", async () => {
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    const { url } = await mintCapabilityLink(db, {
      type: CapabilityTokenType.approve,
      assignmentId: refs.assignmentId,
    });
    const after = Date.now();

    expect(url).toContain(`${process.env["WEB_ORIGIN"]}/approve/`);
    const row = await db.capabilityToken.findFirstOrThrow({ where: { type: "approve" } });
    expect(row.singleUse).toBe(true);
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SIXTY_DAYS_MS);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + SIXTY_DAYS_MS);

    const raw = extractToken(url);
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.approve)).ok).toBe(true);
    expect((await consumeCapabilityToken(db, raw, CapabilityTokenType.approve)).ok).toBe(true);
    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.approve)).toEqual({
      ok: false,
      reason: "used",
    });
  });
});

describe("AC5 -- track is multi-use; a re-send mints a second valid token", () => {
  test("AC5: a track token validates repeatedly with usedAt never set; a re-send mints a second, both valid", async () => {
    await sendNotification(
      {
        type: "track_link_test",
        channel: "sms",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `track_link_test:job:${refs.jobId}:1`,
        relatedType: "job",
        relatedId: refs.jobId,
        jobId: refs.jobId,
        capabilityLink: { type: CapabilityTokenType.track, jobId: refs.jobId },
      },
      db,
    );
    expect(await drainOnce(db)).toBe(1);
    const firstRaw = extractToken(sms.sent[0]?.message.text ?? "");

    expect((await validateCapabilityToken(db, firstRaw, CapabilityTokenType.track)).ok).toBe(true);
    expect((await validateCapabilityToken(db, firstRaw, CapabilityTokenType.track)).ok).toBe(true);

    // a re-send -- the second phone in the household
    await sendNotification(
      {
        type: "track_link_test",
        channel: "sms",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `track_link_test:job:${refs.jobId}:2`,
        relatedType: "job",
        relatedId: refs.jobId,
        jobId: refs.jobId,
        capabilityLink: { type: CapabilityTokenType.track, jobId: refs.jobId },
      },
      db,
    );
    expect(await drainOnce(db)).toBe(1);
    const secondRaw = extractToken(sms.sent[1]?.message.text ?? "");

    expect(secondRaw).not.toBe(firstRaw);
    expect((await validateCapabilityToken(db, firstRaw, CapabilityTokenType.track)).ok).toBe(true);
    expect((await validateCapabilityToken(db, secondRaw, CapabilityTokenType.track)).ok).toBe(true);

    const rows = await db.capabilityToken.findMany({ where: { type: "track" } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.usedAt === null)).toBe(true);
  });
});

describe("AC6 -- revocation hooks", () => {
  test("AC6: revokeByAssignment deletes its respond token; the old link is refused afterwards", async () => {
    const { url } = await mintCapabilityLink(db, {
      type: CapabilityTokenType.respond,
      assignmentId: refs.assignmentId,
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    const raw = extractToken(url);
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);

    expect(await revokeByAssignment(db, refs.assignmentId)).toBe(1);

    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).toEqual({
      ok: false,
      reason: "not found",
    });
  });

  test("AC6: revokeByJob deletes only the named types scoped to that job", async () => {
    await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId: refs.jobId });
    await mintCapabilityLink(db, { type: CapabilityTokenType.review, jobId: refs.jobId });
    expect(await db.capabilityToken.count({ where: { jobId: refs.jobId } })).toBe(2);

    expect(await revokeByJob(db, refs.jobId, [CapabilityTokenType.track])).toBe(1);

    const remaining = await db.capabilityToken.findMany({ where: { jobId: refs.jobId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe("review");
  });
});

describe("AC7 -- a retry mints a fresh token", () => {
  test("AC7: a failed attempt then a successful retry leaves the retry's URL valid", async () => {
    sms.failWith = "clicksend said no";
    await sendNotification(
      {
        type: "respond_link_test",
        channel: "sms",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: `respond_link_test:assignment:${refs.assignmentId}`,
        relatedType: "assignment",
        relatedId: refs.assignmentId,
        jobId: refs.jobId,
        context: { jobReference: "JOB-1042" },
        capabilityLink: {
          type: CapabilityTokenType.respond,
          assignmentId: refs.assignmentId,
          expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        },
      },
      db,
    );

    await drainOnce(db); // fails after minting -- token #1 never reaches anyone
    expect(sms.sent).toHaveLength(0);
    expect(await db.capabilityToken.count()).toBe(1);

    sms.failWith = null;
    const row = await db.notification.findFirstOrThrow();
    await backdate(db, row.id, 2);
    await drainOnce(db); // the retry -- mints token #2, delivers it

    expect(sms.sent).toHaveLength(1);
    expect(await db.capabilityToken.count()).toBe(2);

    const raw = extractToken(sms.sent[0]?.message.text ?? "");
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.respond)).ok).toBe(true);
  });
});

describe("AC8 -- tighten expiry", () => {
  test("AC8: tightenExpiryByJob moves the track token's expiry; validation refuses it after", async () => {
    const { url } = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId: refs.jobId });
    const raw = extractToken(url);
    expect((await validateCapabilityToken(db, raw, CapabilityTokenType.track)).ok).toBe(true);

    const tightenedTo = new Date(Date.now() - 1000);
    expect(await tightenExpiryByJob(db, refs.jobId, CapabilityTokenType.track, tightenedTo)).toBe(1);

    expect(await validateCapabilityToken(db, raw, CapabilityTokenType.track)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("AC9 -- ask-time refusal", () => {
  test("AC9: a respond spec with no expiresAt is refused at ask time; no row is ever queued", async () => {
    await expect(
      sendNotification(
        {
          type: "respond_link_test",
          channel: "sms",
          recipientType: "contractor",
          recipientId: cast.bobId,
          idempotencyKey: `respond_link_test:assignment:${refs.assignmentId}`,
          relatedType: "assignment",
          relatedId: refs.assignmentId,
          jobId: refs.jobId,
          capabilityLink: { type: CapabilityTokenType.respond, assignmentId: refs.assignmentId },
        },
        db,
      ),
    ).rejects.toThrow(/expiresAt/);

    expect(await db.notification.count()).toBe(0);
  });
});
