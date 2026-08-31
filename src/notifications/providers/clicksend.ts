// The ClickSend adapter -- Feature 1004, notification module.
//
// SMS (ADR 0000; an Australian provider, and Mailjet is email-only). The
// account itself is deliberately NOT a dependency of this feature: the design
// ties confirming it and its AU pricing to the first real SMS build (dispatch
// and slot confirmation). Until then this adapter exists, is registered, and is
// never reached in dev -- with no credentials the registry falls back to the
// console adapter, which is exactly the behaviour the design asks for.
import type { ProviderAdapter } from "../types.js";

export const CLICKSEND_PROVIDER = "clicksend";

const SEND_URL = "https://rest.clicksend.com/v3/sms/send";

/**
 * A send runs inside the dispatcher's transaction, holding the row lock and a
 * connection, so the HTTP call is not allowed to hang indefinitely. A provider
 * that has not answered in this long has failed as far as we are concerned; the
 * row keeps its remaining attempts.
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface ClickSendResponse {
  response_code?: string;
  response_msg?: string;
  data?: { messages?: { status?: string; message_id?: string; error_text?: string }[] };
}

function credentials(): { username: string; apiKey: string } | null {
  const username = process.env["CLICKSEND_USERNAME"];
  const apiKey = process.env["CLICKSEND_API_KEY"];
  if (!username || !apiKey) return null;
  return { username, apiKey };
}

export const clicksendSms: ProviderAdapter = {
  name: CLICKSEND_PROVIDER,
  channel: "sms",
  isConfigured: () => credentials() !== null,

  async send({ to, message }) {
    const auth = credentials();
    if (auth === null) {
      throw new Error("clicksend is not configured -- CLICKSEND_USERNAME and CLICKSEND_API_KEY are required");
    }

    const from = process.env["CLICKSEND_FROM"];
    const response = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.apiKey}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        messages: [{ to, body: message.text, ...(from ? { from } : {}) }],
      }),
    });

    const body = (await response.json().catch(() => ({}))) as ClickSendResponse;
    if (!response.ok || body.response_code !== "SUCCESS") {
      throw new Error(`clicksend refused the message (HTTP ${String(response.status)}): ${body.response_msg ?? JSON.stringify(body)}`);
    }

    const sent = body.data?.messages?.[0];
    if (sent?.status !== "SUCCESS" || !sent.message_id) {
      throw new Error(`clicksend did not accept the message: ${sent?.error_text ?? JSON.stringify(body)}`);
    }
    return { providerMessageId: sent.message_id };
  },
};
