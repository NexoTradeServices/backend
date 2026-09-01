// Test helpers -- Feature 1004, notification module.
//
// Two things the criteria need that the shipped module deliberately does not
// carry:
//
//   1. STAND-IN TEMPLATES. This feature ships one template -- the password
//      reset, so feature 1003 has something to call. Every other message's
//      wording belongs to the feature that sends it, so a criterion about Bob's
//      dispatch SMS or about a marketing send uses a stand-in here rather than
//      putting words in feature 4002's mouth (or Phase 2's).
//
//   2. RECORDING ADAPTERS. A test must never post to Mailjet or ClickSend. An
//      adapter that records what it was handed proves the same thing better:
//      it can be counted, made to throw, and made slow.
//
// Both go in through the module's own registries, which is exactly the seam the
// design describes -- a provider swap is a change inside the module.
import { seedBase } from "../../src/db/seed/base.js";
import { seedFixtures } from "../../src/db/seed/fixtures.js";
import type { PrismaClient } from "../../src/db/client.js";
import type {
  NotificationChannel,
  NotificationTemplate,
  OutboundMessage,
  ProviderAdapter,
} from "../../src/notifications/types.js";

export interface RecordingAdapter extends ProviderAdapter {
  /** every message this adapter was handed, in order */
  sent: OutboundMessage[];
  /** make the next sends throw with this message; null sends normally */
  failWith: string | null;
  /** hold each send open this long, so two loops can genuinely overlap */
  delayMs: number;
  /**
   * Mutable, unlike the constructor option it starts from -- a test proves a
   * provider RECOVERING mid-retry-window (Feature 1009 AC4) by flipping this
   * to true between two `drainOnce` calls, no re-registration needed.
   */
  configured: boolean;
  reset(): void;
}

export function recordingAdapter(
  name: string,
  channel: NotificationChannel,
  options: { configured?: boolean } = {},
): RecordingAdapter {
  const adapter: RecordingAdapter = {
    name,
    channel,
    sent: [],
    failWith: null,
    delayMs: 0,
    configured: options.configured ?? true,
    isConfigured: () => adapter.configured,
    async send(outbound) {
      if (adapter.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, adapter.delayMs));
      }
      if (adapter.failWith !== null) throw new Error(adapter.failWith);
      adapter.sent.push(outbound);
      return { providerMessageId: `${name}-${String(adapter.sent.length)}` };
    },
    reset() {
      adapter.sent = [];
      adapter.failWith = null;
      adapter.delayMs = 0;
      adapter.configured = options.configured ?? true;
    },
  };
  return adapter;
}

/** Bob's dispatch SMS -- stand-in for the wording feature 4002 will ship. */
export const dispatchedSms: NotificationTemplate = {
  type: "dispatched",
  channel: "sms",
  category: "transactional",
  render: (context) => ({ text: `New job ${String(context["jobReference"] ?? "")} - respond now` }),
};

/** Bob's dispatch EMAIL -- the design sends dispatch on both legs, email + SMS. */
export const dispatchedEmail: NotificationTemplate = {
  type: "dispatched",
  channel: "email",
  category: "transactional",
  render: (context) => ({
    subject: `New job ${String(context["jobReference"] ?? "")}`,
    text: `A job is waiting for you: ${String(context["jobReference"] ?? "")}`,
  }),
};

/** Sarah's invoice email -- stand-in for the wording feature 6001 will ship. */
export const invoiceEmail: NotificationTemplate = {
  type: "invoice",
  channel: "email",
  category: "transactional",
  render: (context) => ({
    subject: `Invoice ${String(context["invoiceReference"] ?? "")}`,
    text: `Your invoice is ready: ${String(context["payUrl"] ?? "")}`,
  }),
};

/** A marketing message. Sending tooling is Phase 2; the gates around it are not. */
export const promoEmail: NotificationTemplate = {
  type: "promo",
  channel: "email",
  category: "marketing",
  render: () => ({ subject: "Winter plumbing offer", text: "Ten percent off this month." }),
};

export const promoSms: NotificationTemplate = {
  type: "promo",
  channel: "sms",
  category: "marketing",
  render: () => ({ text: "Ten percent off plumbing this month. Reply STOP to opt out." }),
};

export interface CastIds {
  /** Sarah Chen, CUS-1050 */
  sarahId: string;
  /** Bob Reilly, CON-014 */
  bobId: string;
}

/** The base seed plus the cast, and the two ids every criterion here names. */
export async function seedCast(client: PrismaClient): Promise<CastIds> {
  await seedBase(client);
  await seedFixtures(client);
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
  return { sarahId: sarah.id, bobId: bob.id };
}

/** Point the one settings row at a provider, and set (or clear) the per-type exceptions. */
export async function setProviders(
  client: PrismaClient,
  values: { emailProvider?: string; smsProvider?: string; providerOverrides?: unknown },
): Promise<void> {
  const settings = await client.platformSettings.findFirstOrThrow();
  await client.platformSettings.update({
    where: { id: settings.id },
    data: {
      ...(values.emailProvider === undefined ? {} : { emailProvider: values.emailProvider }),
      ...(values.smsProvider === undefined ? {} : { smsProvider: values.smsProvider }),
      ...(values.providerOverrides === undefined
        ? {}
        : { providerOverrides: values.providerOverrides as never }),
    },
  });
}

/**
 * Move a row's clock back so the next attempt is due now.
 *
 * The dispatcher measures backoff from `createdAt`, so this is how a test
 * watches three attempts and a give-up without waiting six real minutes.
 */
export async function backdate(
  client: PrismaClient,
  id: string,
  minutes: number,
): Promise<void> {
  await client.notification.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - minutes * 60_000) },
  });
}
