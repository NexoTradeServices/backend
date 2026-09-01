// Shared shapes for the capability token service -- Feature 1005, capability
// tokens.
//
// Token shape is ADR 0004; the route table (types, lifespans, revocation) is
// project/design/trades-platform-design.md, Identity & Access / Passwordless
// capability links -- the single source, never restated here.
import { CapabilityTokenType } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";

export { CapabilityTokenType };

/**
 * The client every function in this module takes.
 *
 * A transaction-client shape on purpose: consuming a token has to run in the
 * SAME transaction as the action it gates (the answer, the review submit, the
 * approval) -- decision 6. A full PrismaClient satisfies this too, which is
 * what lets the dispatcher (already inside its own transaction) and a plain
 * request handler (not) both call in.
 */
export type CapabilityTokenDb = Prisma.TransactionClient;

/**
 * What a caller asks for on a `SendRequest` (see the notification module) --
 * decision 2. The module turns this into a minted link at send time; the
 * caller never sees a raw token or a hash.
 *
 * `expiresAt` is an ISO string, not a Date: the spec rides inside
 * `Notification.context`, whose values are the same flat primitives a
 * template can render (see `NotificationContext`), so it has to survive a
 * JSON round-trip un-widened.
 */
export interface LinkSpec {
  type: CapabilityTokenType;
  jobId?: string;
  assignmentId?: string;
  /**
   * REQUIRED for `respond` (the caller knows the proposed slot start; the
   * module does not) -- decision 5. Ignored for every other type: review,
   * track and approve are stamped from the send-time clock instead.
   */
  expiresAt?: string;
}

/** One minted link, ready to drop into a rendered message. */
export interface MintedLink {
  url: string;
  tokenId: string;
}

/** What `validateCapabilityToken` / `consumeCapabilityToken` hand back. */
export type CapabilityTokenResult =
  | { ok: true; tokenId: string; jobId: string | null; assignmentId: string | null }
  | { ok: false; reason: string };

/**
 * The one reserved key inside `Notification.context` that carries a link
 * spec across the async gap to the dispatcher -- decision 2. No feature
 * outside this module and the notification module ever reads or writes it.
 */
export const CAPABILITY_LINK_CONTEXT_KEY = "__capabilityLinkSpec";
