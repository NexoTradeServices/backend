// Shared shapes for the notification module -- Feature 1004, notification module.
//
// Every component inside the module speaks these types; nothing outside it
// needs them. The dependency rule from the design's Notification module
// (architecture) reads downwards only: channels, templates and the dispatcher
// know about a ProviderAdapter, and no adapter knows about anything above it.
import type {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationRecipientType,
  NotificationRelatedType,
  PlatformSettings,
} from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * The database handle every component inside the module takes.
 *
 * It is the TRANSACTION client shape on purpose: the dispatcher claims a row and
 * keeps it locked for the whole send, so everything reached from there has to
 * run on that one connection. A full PrismaClient satisfies this too, which is
 * what lets `sendNotification` be called with an ordinary client.
 */
export type NotificationDb = Prisma.TransactionClient;

export type {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationRecipientType,
  NotificationRelatedType,
  PlatformSettings,
};

/** Template variables. Stored on the row, because sending is async. */
export type NotificationContext = Record<string, string | number | boolean | null>;

/** What a template turns a context into. `subject` is email-only. */
export interface RenderedMessage {
  subject?: string;
  /** the plain-text body -- the only part SMS has, and email's fallback part */
  text: string;
  html?: string;
}

/** One message type on one channel. Templates are code, not rows (ADR 0002). */
export interface NotificationTemplate {
  /** the `type` a caller asks for: password_reset, dispatched, invoice ... */
  type: string;
  channel: NotificationChannel;
  /**
   * transactional or marketing. It belongs to the MESSAGE, not the caller --
   * the legal line in the design's Notifications section is a property of what
   * is being said, so a caller can never talk a marketing message into being
   * treated as transactional.
   */
  category: NotificationCategory;
  render(context: NotificationContext): RenderedMessage;
}

/** What a provider is handed: an address and a rendered message. */
export interface OutboundMessage {
  to: string;
  message: RenderedMessage;
}

/**
 * A provider, from the module's point of view. Nothing above this interface
 * knows Mailjet or ClickSend exists -- that is the design's dependency rule.
 */
export interface ProviderAdapter {
  /** the name PlatformSettings.emailProvider / .smsProvider / .providerOverrides use */
  name: string;
  channel: NotificationChannel;
  /** credentials present? Drives dev fallback and the production boot refusal. */
  isConfigured(): boolean;
  send(outbound: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/** What the module knows while it is sending one message. */
export interface SendContext {
  client: NotificationDb;
  settings: PlatformSettings;
}

/**
 * An address, or the reason there is not one. A reason is written into
 * `Notification.error` and ends the row -- an address that does not exist will
 * not exist on the next attempt either.
 */
export type AddressLookup = { address: string } | { reason: string };

/** One channel component: how this channel reaches a person, and what it refuses. */
export interface ChannelComponent {
  channel: NotificationChannel;
  /** where a message on this channel goes -- an email address, or a phone number */
  addressFor(
    context: SendContext,
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<AddressLookup>;
  /** what this channel will not send: an email with no subject, an empty SMS */
  check(message: RenderedMessage): string | null;
}

/** What a feature hands the module. Type + recipient + context, and nothing else. */
export interface SendRequest {
  type: string;
  channel: NotificationChannel;
  recipientType: NotificationRecipientType;
  recipientId: string;
  /**
   * `<type>:<relatedType>:<relatedId>`, plus a discriminator where one record
   * can legitimately send the same message twice (the "on my way" tap keys per
   * calendar block). Derivable by the caller without reading the table first --
   * the unique constraint on the column is the guard.
   */
  idempotencyKey: string;
  context?: NotificationContext;
  relatedType?: NotificationRelatedType;
  relatedId?: string;
  /** set whenever the context carries a job, so a job page can list its messages */
  jobId?: string;
}
