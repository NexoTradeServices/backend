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
import { assertProvidersConfigured } from "./providers/registry.js";
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
 * IN PRODUCTION A MISSING CREDENTIAL STOPS THE PROCESS HERE, the same way the
 * app already treats WEB_ORIGIN and DATABASE_URL. Outside production the same
 * gap is only reported -- the console adapter takes over and the whole flow
 * stays provable on a laptop with no provider accounts at all.
 */
export async function startNotifications(options: DispatcherOptions = {}): Promise<Dispatcher> {
  const client: PrismaClient = options.client ?? getPrisma();

  const settings = await client.platformSettings.findFirst();
  if (settings === null) {
    throw new Error("no PlatformSettings row -- run the base seed before starting the API");
  }

  const problems = assertProvidersConfigured(settings);
  for (const problem of problems) {
    console.warn(`notifications: ${problem} -- falling back to the console adapter`);
  }

  return startDispatcher({ ...options, client });
}
