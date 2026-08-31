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
// Turning a hard bounce into a Suppression row and an ops alert is feature
// 7001. This feature sets the status and stops there.
import express, { type Request, type Response, type Router } from "express";
import { getPrisma, type PrismaClient } from "../db/client.js";
import { CLICKSEND_PROVIDER } from "./providers/clicksend.js";
import { MAILJET_PROVIDER } from "./providers/mailjet.js";

/** What one provider event means, once the provider's words are taken off it. */
interface DeliveryEvent {
  providerMessageId: string;
  outcome: "delivered" | "failed";
  detail?: string;
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
    select: { id: true },
  });
  if (row === null) return false;

  await client.notification.update({
    where: { id: row.id },
    data:
      event.outcome === "delivered"
        ? { status: "delivered", deliveredAt: new Date(), error: null }
        : { status: "failed", error: event.detail ?? "the provider reported a delivery failure" },
  });
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
      events.push({
        providerMessageId,
        outcome: "failed",
        detail: `mailjet ${name}${hard ? " (hard)" : ""}: ${reason}`,
      });
    }
    // open, click and unsub say nothing about delivery; 7001 owns unsub.
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
  router.use(express.json());

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

  router.post("/mailjet", endpoint(MAILJET_PROVIDER, mailjetEvents));
  router.post("/clicksend", endpoint(CLICKSEND_PROVIDER, clicksendEvents));

  return router;
}
