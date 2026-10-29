// Delivery webhooks -- Feature 1004, notification module.
//
// The design's "Delivery + log": the module receives provider webhooks and
// NORMALISES them into Notification.status. Every provider words it
// differently -- Mailjet posts an array of events, ClickSend posts one receipt
// with a capitalised status -- and none of that vocabulary is allowed to leak
// past this file. Above it there are only the four statuses the data model has.
//
// An event for a message id we do not hold is IGNORED, not an error. Providers
// retry anything that is not a 2xx, so answering 404 to a stray event buys a
// retry storm and no information; and a webhook is a public endpoint, so an
// unknown id is as likely to be noise as a bug.
//
// A hard bounce also lists the address and tells the office once (Feature 7001, bounce.ts).
//
// WHO MAY CALL (Feature 7001). Neither provider signs its events, so each endpoint answers only at an
// address ending in its own secret -- /webhooks/mailjet/<secret>. A wrong secret, no secret, or a
// secret the server has not been given answers 404 BEFORE the body is read and changes nothing; the
// old secret-less paths answer 404 too.
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { getPrisma, type PrismaClient } from "../db/client.js";
import { listHardBounce } from "./bounce.js";
import { CLICKSEND_PROVIDER } from "./providers/clicksend.js";
import { MAILJET_PROVIDER } from "./providers/mailjet.js";

/** What one provider event means, once the provider's words are taken off it. */
interface DeliveryEvent {
  providerMessageId: string;
  outcome: "delivered" | "failed";
  detail?: string;
  /** a hard bounce, with the address the provider says bounced (Mailjet only) */
  hardBounce?: { address: string };
}

/** The two secrets, by the env var that holds each. */
const SECRET_VARIABLES = { mailjet: "MAILJET_WEBHOOK_SECRET", clicksend: "CLICKSEND_WEBHOOK_SECRET" } as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time: both sides are hashed first so the compare is over equal lengths. */
function secretMatches(variable: string, given: unknown): boolean {
  const expected = process.env[variable];
  if (expected === undefined || expected === "" || typeof given !== "string") return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/** One warning per unset secret at startup; the endpoint stays shut until it is set. */
export function warnIfWebhookSecretsMissing(): void {
  for (const [provider, variable] of Object.entries(SECRET_VARIABLES)) {
    const value = process.env[variable];
    if (value === undefined || value === "") {
      console.warn(`notifications: ${variable} is not set -- the ${provider} delivery webhook refuses every call until it is`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Apply one normalised event. Returns whether a row was actually moved, so the
 * response can say how much of the payload was ours.
 */
async function applyEvent(
  client: PrismaClient,
  provider: string,
  event: DeliveryEvent,
): Promise<boolean> {
  // Matched on provider AS WELL AS id: message ids are a provider's own
  // namespace, and nothing stops two of them minting the same string.
  const row = await client.notification.findFirst({
    where: { provider, providerMessageId: event.providerMessageId },
    select: { id: true, recipientType: true, recipientId: true, type: true, jobId: true, channel: true },
  });
  if (row === null) return false;

  await client.notification.update({
    where: { id: row.id },
    data:
      event.outcome === "delivered"
        ? { status: "delivered", deliveredAt: new Date(), error: null }
        : { status: "failed", error: event.detail ?? "the provider reported a delivery failure" },
  });
  // Feature 7001: a hard bounce on an email lists the address (and asks for the office's notice, once).
  if (event.hardBounce !== undefined && row.channel === "email") {
    await listHardBounce(client, row, event.hardBounce.address);
  }
  return true;
}

/** Mailjet posts one event object, or an array of them. */
function mailjetEvents(payload: unknown): DeliveryEvent[] {
  const raw = Array.isArray(payload) ? payload : [payload];
  const events: DeliveryEvent[] = [];

  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) continue;
    // Message_GUID first, for the reason the adapter prefers MessageUUID: the
    // numeric id is past what a JSON number holds exactly, the string is not.
    const providerMessageId = asText(record["Message_GUID"]) ?? asText(record["MessageID"]);
    const name = asText(record["event"])?.toLowerCase();
    if (providerMessageId === undefined || name === undefined) continue;

    // "sent" is Mailjet's word for accepted by the receiving server, which is
    // the delivery this log cares about; "delivered" is the same news.
    if (name === "delivered" || name === "sent") {
      events.push({ providerMessageId, outcome: "delivered" });
      continue;
    }
    if (name === "bounce" || name === "blocked" || name === "spam") {
      const hard = record["hard_bounce"] === true;
      const reason = asText(record["error"]) ?? name;
      const address = asText(record["email"]);
      events.push({
        providerMessageId,
        outcome: "failed",
        detail: `mailjet ${name}${hard ? " (hard)" : ""}: ${reason}`,
        // Only a hard BOUNCE lists: a block or a spam report says nothing about the address being dead.
        ...(name === "bounce" && hard && address !== undefined ? { hardBounce: { address } } : {}),
      });
    }
    // open, click and unsub say nothing about delivery (unsub comes with the marketing tooling).
  }
  return events;
}

/** ClickSend posts one delivery receipt per message. */
function clicksendEvents(payload: unknown): DeliveryEvent[] {
  const raw = Array.isArray(payload) ? payload : [payload];
  const events: DeliveryEvent[] = [];

  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) continue;
    const providerMessageId = asText(record["message_id"]);
    const status = asText(record["status"])?.toLowerCase();
    if (providerMessageId === undefined || status === undefined) continue;

    if (status === "delivered") {
      events.push({ providerMessageId, outcome: "delivered" });
      continue;
    }
    if (status === "undelivered" || status === "undeliverable" || status === "failed") {
      events.push({
        providerMessageId,
        outcome: "failed",
        detail: `clicksend ${status}: ${asText(record["error_text"]) ?? "no detail given"}`,
      });
    }
    // queued / sent are on the way, not news.
  }
  return events;
}

async function handle(
  client: PrismaClient,
  provider: string,
  events: DeliveryEvent[],
  res: Response,
): Promise<void> {
  let matched = 0;
  for (const event of events) {
    if (await applyEvent(client, provider, event)) matched += 1;
  }
  res.json({ received: events.length, matched });
}

/**
 * The two delivery endpoints, mounted by the API at /webhooks.
 *
 * `client` is injectable so the suite can point them at the test database
 * without booting the whole app.
 */
export function notificationWebhooks(client: PrismaClient = getPrisma()): Router {
  const router = express.Router();

  // The secret check runs BEFORE the body parser: a caller without the secret never gets its body read.
  function guard(variable: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!secretMatches(variable, req.params["secret"])) {
        res.status(404).json({ status: "not found" });
        return;
      }
      next();
    };
  }

  // A webhook that dies mid-handler must still answer: an open request is the
  // one failure a provider cannot tell apart from us being down.
  function endpoint(provider: string, read: (payload: unknown) => DeliveryEvent[]) {
    return (req: Request, res: Response): void => {
      const payload: unknown = req.body;
      handle(client, provider, read(payload), res).catch((error: unknown) => {
        console.error(`${provider} delivery webhook failed`, error);
        res.status(500).json({ status: "error" });
      });
    };
  }

  router.post("/mailjet/:secret", guard(SECRET_VARIABLES.mailjet), express.json(), endpoint(MAILJET_PROVIDER, mailjetEvents));
  router.post("/clicksend/:secret", guard(SECRET_VARIABLES.clicksend), express.json(), endpoint(CLICKSEND_PROVIDER, clicksendEvents));

  return router;
}
