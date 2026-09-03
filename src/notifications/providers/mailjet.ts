// The Mailjet adapter -- Feature 1004, notification module.
//
// Transactional email (ADR 0000, moved from MailerSend on 30/08/26). Mailjet is
// email-only; SMS goes to ClickSend.
//
// CREDENTIALS COME FROM THE ENVIRONMENT, never from the database. The settings
// row names WHICH provider -- that is config the owner can change on a screen --
// and the secret behind it is a deploy-time secret the owner sets once.
// `idelta.com.au` is authenticated at Mailjet (SPF, DKIM), and which ADDRESS
// on it signs the mail is a deployment fact, not a design one -- but the NAME
// on the From line is brand truth (Foundations / Brand identity; ADR 0005),
// handed in per send as `fromName` rather than read from an env var (feature
// 1014 retires the one that used to hold it).
import type { ProviderAdapter } from "../types.js";

export const MAILJET_PROVIDER = "mailjet";

const SEND_URL = "https://api.mailjet.com/v3.1/send";

/**
 * A send runs inside the dispatcher's transaction, holding the row lock and a
 * connection, so the HTTP call is not allowed to hang indefinitely. A provider
 * that has not answered in this long has failed as far as we are concerned; the
 * row keeps its remaining attempts.
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface MailjetResponse {
  Messages?: { Status?: string; To?: { MessageID?: number; MessageUUID?: string }[] }[];
}

/**
 * MessageUUID, NOT MessageID.
 *
 * Mailjet's numeric MessageID is a 64-bit integer well past what a JSON number
 * survives: 576460752303423999 comes back out of JSON.parse as
 * 576460752303424000. The UUID beside it is a string and loses nothing, and the
 * webhook quotes it too (as Message_GUID), so both ends of the delivery log
 * agree on one exact value.
 */
function messageIdOf(sent: { MessageID?: number; MessageUUID?: string }): string | undefined {
  if (sent.MessageUUID) return sent.MessageUUID;
  return sent.MessageID === undefined ? undefined : String(sent.MessageID);
}

function credentials(): { apiKey: string; apiSecret: string; fromEmail: string } | null {
  const apiKey = process.env["MAILJET_API_KEY"];
  const apiSecret = process.env["MAILJET_API_SECRET"];
  const fromEmail = process.env["MAILJET_FROM_EMAIL"];
  if (!apiKey || !apiSecret || !fromEmail) return null;
  return { apiKey, apiSecret, fromEmail };
}

export const mailjetEmail: ProviderAdapter = {
  name: MAILJET_PROVIDER,
  channel: "email",
  isConfigured: () => credentials() !== null,

  async send({ to, fromName, message }) {
    const auth = credentials();
    if (auth === null) {
      throw new Error("mailjet is not configured -- MAILJET_API_KEY, MAILJET_API_SECRET and MAILJET_FROM_EMAIL are required");
    }

    const response = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${auth.apiKey}:${auth.apiSecret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: auth.fromEmail, Name: fromName },
            To: [{ Email: to }],
            Subject: message.subject,
            TextPart: message.text,
            ...(message.html ? { HTMLPart: message.html } : {}),
          },
        ],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as MailjetResponse;
    if (!response.ok) {
      throw new Error(`mailjet refused the message (HTTP ${String(response.status)}): ${JSON.stringify(body)}`);
    }

    const sent = body.Messages?.[0];
    const recipient = sent?.To?.[0];
    const messageId = recipient === undefined ? undefined : messageIdOf(recipient);
    if (sent?.Status !== "success" || messageId === undefined) {
      throw new Error(`mailjet did not accept the message: ${JSON.stringify(body)}`);
    }
    return { providerMessageId: messageId };
  },
};
