// POST /api/account/set-password-request -- Feature 3004, guest to account.
//
// Guest by default, account by invitation. Public (she has no login). The Set a
// password page posts her email; this answers the SAME 200 whatever the address,
// after the work is done, so it never reveals which emails we hold:
//   - no Customer for the address         -> nothing is sent
//   - a guest Customer                    -> a User (role customer, no password) is made and
//                                            linked, earlier links are cleared, a fresh Set your
//                                            password link goes out (the 2001 invite pattern)
//   - a Customer who asked and never      -> the same: earlier links cleared, a fresh one sent
//     finished
//   - a Customer with a password, or an address that belongs to a login of another role ->
//     the Already have an account email; a customer is never linked to a contractor or ops login
// reCAPTCHA is the enquiry form's check: a confirmed bot is refused with the call-us words; an
// unreachable check lets it through. One email per address per 60 seconds (a quiet no-op, same
// 200), and a per-client-IP limiter in front.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import type { Auth } from "../auth/config.js";
import { sendNotification } from "../notifications/index.js";
import { verifyRecaptcha, type RecaptchaVerdict } from "../enquiries/recaptcha.js";
import { isTestRun } from "../test-data/label.js";
import { ipLimiter } from "./ip-limit.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOLD_MS = 60_000;
const SAME_ANSWER = { ok: true } as const;

export interface AccountRoutesOptions {
  /** Swappable in tests, like the enquiry endpoint's. */
  verifyRecaptcha?: (token: string | undefined) => Promise<RecaptchaVerdict>;
  /** Requests allowed per client IP per minute; tests lower it. */
  perIpPerMinute?: number;
}

function webOrigin(): string {
  return (process.env["WEB_ORIGIN"] ?? "").replace(/\/+$/, "");
}

export function accountRoutes(client: PrismaClient, auth: Auth, options: AccountRoutesOptions = {}): Router {
  const router = createRouter();
  const checkRecaptcha = options.verifyRecaptcha ?? verifyRecaptcha;
  const limit = ipLimiter(options.perIpPerMinute ?? 10);

  router.post("/set-password-request", (req: Request, res: Response) => {
    void (async () => {
      if (!limit(req)) {
        res.status(429).json({ error: "too many requests -- try again in a minute" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body["email"];
      const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!EMAIL_PATTERN.test(email)) {
        res.status(400).json({ error: "Enter your email address.", field: "email" });
        return;
      }
      const token = typeof body["recaptchaToken"] === "string" ? body["recaptchaToken"] : undefined;
      // A browser test run (never production) skips the live check, like the enquiry endpoint.
      if (!isTestRun() && (await checkRecaptcha(token)) === "bot") {
        const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
        res.status(403).json({ error: "bot", operatorPhone: settings?.operatorPhone ?? "" });
        return;
      }

      await handle(client, auth, email);
      res.json(SAME_ANSWER);
    })().catch((error: unknown) => {
      console.error("POST /api/account/set-password-request failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}

async function handle(client: PrismaClient, auth: Auth, email: string): Promise<void> {
  const customer = await client.customer.findUnique({ where: { email } });
  if (customer === null) return;

  const holder = customer.userId === null
    ? await client.user.findUnique({ where: { email } })
    : await client.user.findUnique({ where: { id: customer.userId } });

  // One email per address per 60 seconds: a quiet no-op inside the window.
  if (holder !== null) {
    const recent = await client.notification.count({
      where: {
        recipientType: "user",
        recipientId: holder.id,
        type: { in: ["customer_set_password", "account_exists"] },
        createdAt: { gt: new Date(Date.now() - HOLD_MS) },
      },
    });
    if (recent > 0) return;
  }

  const origin = webOrigin();
  if (holder !== null) {
    const hasCredential = await client.account.findFirst({ where: { userId: holder.id, providerId: "credential" }, select: { id: true } });
    // A login of another role, or a customer who already has a password: Already have an account.
    if (hasCredential !== null || holder.role !== "customer" || (customer.userId !== null && customer.userId !== holder.id)) {
      await sendNotification(
        {
          type: "account_exists",
          channel: "email",
          recipientType: "user",
          recipientId: holder.id,
          idempotencyKey: `account_exists:user:${holder.id}:${Date.now().toString()}`,
          context: { name: holder.name, loginUrl: `${origin}/account`, forgotUrl: `${origin}/forgot-password` },
        },
        client,
      );
      return;
    }
  }

  // A guest (or one who asked before and never finished): make the login if it is missing, link it.
  let userId = holder?.id ?? null;
  if (userId === null) {
    userId = await client.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name: customer.name, email, role: "customer", emailVerified: false } });
      await tx.customer.update({ where: { id: customer.id }, data: { userId: user.id } });
      return user.id;
    });
  }
  // The earlier link no longer works: Better Auth mints a new token but never voids an older one.
  await client.verification.deleteMany({ where: { identifier: { startsWith: "reset-password:" }, value: userId } });
  await auth.api.requestPasswordReset({ body: { email, redirectTo: `${origin}/reset-password` } });
}
