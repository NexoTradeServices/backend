// THE NOTIFICATION MODULE -- Feature 1004, notification module.
//
// This file is the module's ONLY public face. Every other feature on the
// platform imports from here and from nowhere deeper: not a provider, not a
// template, not the dispatcher's internals. That is the design's dependency
// rule -- every feature depends on the module, the module depends on no
// specific provider -- and it is what makes providers, channels and
// environments swappable without touching the rest of the app.
//
// A feature that needs to reach someone does exactly one thing:
//
//     await sendNotification({
//       type: "password_reset",
//       channel: "email",
//       recipientType: "customer",
//       recipientId: sarah.id,
//       idempotencyKey: `password_reset:user:${sarah.userId}:${issuedAt}`,
//       context: { name: sarah.name, resetUrl },
//     })
//
// and stops thinking about it. Rendering, provider choice, retries, suppression
// and the delivery log all happen behind this line.
import { getPrisma, type PrismaClient } from "../db/client.js";
import { assertProvidersConfigured, isProduction } from "./providers/registry.js";
import { startDispatcher, type Dispatcher, type DispatcherOptions } from "./dispatcher.js";

export { sendNotification } from "./send.js";
export { drainOnce, startDispatcher, MAX_ATTEMPTS, RETRY_BACKOFF_MINUTES } from "./dispatcher.js";
export type { Dispatcher, DispatcherOptions } from "./dispatcher.js";
export { notificationWebhooks } from "./webhooks.js";
export type {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationContext,
  NotificationRecipientType,
  NotificationRelatedType,
  SendRequest,
} from "./types.js";

/**
 * Boot the module: check the providers the settings row names, then start the
 * draining loop.
 *
 * A MISSING CREDENTIAL NEVER STOPS THE PROCESS (Feature 1009 -- a missing or
 * broken provider is never an outage, guiding principle 8). It only logs one
 * loud warning per unconfigured channel, here, at startup. Outside production
 * the console adapter takes over per send; in production the send itself
 * fails on its own row instead (see `resolveProvider`) -- either way the app
 * boots and the rest of the business keeps moving.
 */
export async function startNotifications(options: DispatcherOptions = {}): Promise<Dispatcher> {
  const client: PrismaClient = options.client ?? getPrisma();

  const settings = await client.platformSettings.findFirst();
  if (settings === null) {
    throw new Error("no PlatformSettings row -- run the base seed before starting the API");
  }

  const problems = assertProvidersConfigured(settings);
  const suffix = isProduction()
    ? "sends on this channel will fail until it is configured"
    : "falling back to the console adapter";
  for (const problem of problems) {
    console.warn(`notifications: ${problem} -- ${suffix}`);
  }

  return startDispatcher({ ...options, client });
}
