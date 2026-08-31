// Better Auth config -- Feature 1003, auth + roles.
//
// One auth brain, server-side (plan decision 1). Every field here answers a
// plan decision or an acceptance criterion; nothing is default-guessed.
//
// PINNED to better-auth 1.6.30, not the ^1.7 range: 1.7.0 added a required
// `Account.issuer` column (an anti-collision guard between local and OAuth
// providers) that 1001's schema does not carry. Plan decision 2 promises ZERO
// migration -- 1.6.30 is the newest release that still keeps that promise; a
// migration to pick up 1.7's `issuer` column is future work, not this feature's.
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationRecipientType } from "../notifications/types.js";
import { Role } from "../generated/prisma/enums.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set -- see .env.example`);
  }
  return value;
}

/**
 * Which recipient table can this user's password-reset email address be read
 * from. Customers and contractors have one; ops and the owner do not yet --
 * feature 1004's Q1 answered that gap with `PlatformSettings.operatorEmail`,
 * but building it is folded into feature 3001/B-004, not this feature. An
 * ops/owner reset still writes a queued `Notification` row (decision 3 is
 * honoured); the module itself refuses to address it until that lands, and
 * says exactly why on the row rather than silently dropping it.
 */
async function resolveRecipient(
  client: PrismaClient,
  userId: string,
  role: Role,
): Promise<{ recipientType: NotificationRecipientType; recipientId: string }> {
  if (role === Role.customer) {
    const customer = await client.customer.findUnique({ where: { userId } });
    if (customer) return { recipientType: "customer", recipientId: customer.id };
  }
  if (role === Role.contractor) {
    const contractor = await client.contractor.findUnique({ where: { userId } });
    if (contractor) return { recipientType: "contractor", recipientId: contractor.id };
  }
  return { recipientType: "ops", recipientId: userId };
}

export interface BuildAuthOptions {
  client: PrismaClient;
}

/** The Better Auth instance the whole backend shares -- one auth brain. */
export function buildAuth({ client }: BuildAuthOptions) {
  const webOrigin = requireEnv("WEB_ORIGIN");
  const cookieDomain = requireEnv("COOKIE_DOMAIN");
  const secret = requireEnv("BETTER_AUTH_SECRET");
  const baseURL = requireEnv("API_BASE_URL");

  return betterAuth({
    database: prismaAdapter(client, { provider: "postgresql" }),
    secret,
    baseURL,
    basePath: "/api/auth",
    // The frontend is the only site allowed to redirect through the reset
    // flow or complete a state-changing auth request (decision 1).
    trustedOrigins: [webOrigin],
    advanced: {
      // Prisma's default id (uuid(7)) generates the primary key -- Better
      // Auth must not mint its own and overwrite it.
      database: { generateId: false },
      // Caddy terminates TLS in front of this process (setup/01, setup/03);
      // the app itself sees plain HTTP, so this is not optional.
      useSecureCookies: true,
      // First-party across the api./app. subdomains (Authentication &
      // Security: "cross-site cookies are increasingly blocked").
      crossSubDomainCookies: { enabled: true, domain: cookieDomain },
      defaultCookieAttributes: { sameSite: "lax" },
    },
    emailAndPassword: {
      enabled: true,
      // No self-signup at MVP for any role (Authentication & Security).
      disableSignUp: true,
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: 3600, // 1 hour (plan scope; AC7)
      // The revocation teeth for a password reset (plan scope; AC6).
      revokeSessionsOnPasswordReset: true,
      // Decision 3: the notification module, and nothing else, sends this.
      sendResetPassword: async ({ user, url }) => {
        // additionalFields ("role") are not carried in this hook's generic
        // user type, though the column is on every row -- see config below.
        const role = (user as unknown as { role: Role }).role;
        const recipient = await resolveRecipient(client, user.id, role);
        await sendNotification(
          {
            type: "password_reset",
            channel: "email",
            recipientType: recipient.recipientType,
            recipientId: recipient.recipientId,
            idempotencyKey: `password_reset:user:${user.id}:${Date.now().toString()}`,
            context: { name: user.name, resetUrl: url },
          },
          client,
        );
      },
    },
    user: {
      additionalFields: {
        // Never client-settable -- seeded or written by the create-user
        // script directly via Prisma, never through a Better Auth endpoint.
        role: { type: "string", required: true, input: false },
      },
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;
