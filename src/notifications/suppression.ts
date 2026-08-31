// Suppression and marketing consent -- Feature 1004, notification module.
//
// Both gates run at SEND, not at ask: a person can unsubscribe between the
// moment a feature queues a message and the moment the dispatcher picks it up,
// and the later answer is the right one. A blocked row is not deleted and not
// retried -- it stays in the delivery log carrying the reason it never left,
// which is what makes "we never sent that" answerable a year later.
//
// CREATING Suppression rows is feature 7001 (the unsubscribe link, inbound SMS
// STOP, and turning a hard bounce into a row plus an ops alert). This feature
// only respects rows that already exist.
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationRecipientType,
  SendContext,
} from "./types.js";

export interface SendGateInput {
  category: NotificationCategory;
  channel: NotificationChannel;
  address: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
}

/**
 * SUPPRESSION IS SCOPED BY REASON, and the scope is the whole point.
 *
 * `unsubscribed` and `stopped` block MARKETING ONLY on that channel: STOP stops
 * marketing, not operations, and replying STOP to a promo must never kill a slot
 * confirmation. `bounced` blocks EVERYTHING on that address, transactional
 * included -- a hard bounce means the address is dead, and every resend damages
 * sender reputation. The fix for a bounce is ops correcting the address on the
 * next call, not a retry.
 */
async function suppressionReason(
  context: SendContext,
  input: SendGateInput,
): Promise<string | null> {
  const listed = await context.client.suppression.findUnique({
    where: { channel_address: { channel: input.channel, address: input.address } },
    select: { reason: true },
  });
  if (listed === null) return null;

  if (listed.reason === "bounced") {
    return `suppressed: ${input.address} is listed as bounced on ${input.channel}`;
  }
  if (input.category === "marketing") {
    return `suppressed: ${input.address} is listed as ${listed.reason} on ${input.channel}`;
  }
  return null;
}

/**
 * Marketing needs opt-in; transactional ignores consent entirely. Consent is
 * per-channel -- a person can opt in to email, SMS, both or neither -- and it
 * is captured on the Customer. No consent is captured for contractors or ops,
 * so no marketing message can be addressed to them at all.
 */
async function marketingConsentReason(
  context: SendContext,
  input: SendGateInput,
): Promise<string | null> {
  if (input.category !== "marketing") return null;

  if (input.recipientType !== "customer") {
    return `no marketing consent: ${input.recipientType} recipients hold none`;
  }

  const customer = await context.client.customer.findUnique({
    where: { id: input.recipientId },
    select: { marketingConsent: true },
  });
  const consent: unknown = customer?.marketingConsent;
  const optedIn =
    consent !== null &&
    typeof consent === "object" &&
    !Array.isArray(consent) &&
    (consent as Record<string, unknown>)[input.channel] === true;

  return optedIn ? null : `no marketing consent for ${input.channel}`;
}

/** Why this message must not be sent, or null when it may go. */
export async function blockedReason(
  context: SendContext,
  input: SendGateInput,
): Promise<string | null> {
  return (
    (await suppressionReason(context, input)) ?? (await marketingConsentReason(context, input))
  );
}
