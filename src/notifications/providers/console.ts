// The console adapter -- Feature 1004, notification module.
//
// The design's "environment-aware": in dev, SMS is simulated/logged rather than
// really sent. This adapter is that simulation, and it serves BOTH channels, so
// the whole flow -- ask, queue, claim, render, send, log -- is provable on a
// laptop with no Mailjet account and no ClickSend account at all.
//
// It is never chosen by name. The registry falls back to it when the adapter
// the settings row asks for has no credentials and this is not production; in
// production that same gap refuses the boot instead.
import { randomUUID } from "node:crypto";
import type { NotificationChannel, ProviderAdapter } from "../types.js";

export const CONSOLE_PROVIDER = "console";

function consoleAdapter(channel: NotificationChannel): ProviderAdapter {
  return {
    name: CONSOLE_PROVIDER,
    channel,
    isConfigured: () => true,
    send({ to, message }) {
      const heading = `[notification:${channel}] -> ${to}`;
      const subject = message.subject ? `\nsubject: ${message.subject}` : "";
      console.log(`${heading}${subject}\n${message.text}\n`);
      return Promise.resolve({ providerMessageId: `console-${randomUUID()}` });
    },
  };
}

export const consoleEmail = consoleAdapter("email");
export const consoleSms = consoleAdapter("sms");
