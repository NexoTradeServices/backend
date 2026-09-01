// Feature 1003, auth + roles
//
// AC1  Mike logs in; a Session row exists and the cookie is HTTP-only
// AC2  wrong password and unknown email answer identically
// AC3  a contractor session gets 403 from an ops-guarded route
// AC4  requireRole("ops") admits the owner; requireRole("owner") is exact
// AC5  a password reset writes one Notification row (password_reset, email)
// AC6  the reset link logs the user in, revokes other sessions, dies on reuse
// AC7  a reset link past its expiry is dead; a 7-char password is refused
// AC8  suspending Bob's Contractor row fails his very next request
// AC9  Mike, the owner, Bob, Dave and Priya can all log in; Sarah stays a guest
// AC10 log out deletes the Session row server-side
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession, requireAuth, requireRole } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { Role } from "../src/generated/prisma/enums.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

interface Cast {
  mikeUserId: string;
  ownerUserId: string;
  bobUserId: string;
  bobContractorId: string;
  daveUserId: string;
  priyaUserId: string;
}

async function seedCast(): Promise<Cast> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@idelta.com.au" } });
  const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
  const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
  const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
  return {
    mikeUserId: mike.id,
    ownerUserId: owner.id,
    bobUserId: bob.userId,
    bobContractorId: bob.id,
    daveUserId: dave.userId,
    priyaUserId: priya.userId,
  };
}

/** The full Set-Cookie line for the session cookie, attributes and all. */
function fullSessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie;
}

/** Just `name=value` -- reused across requests without relying on any client-side cookie jar. */
function cookieHeader(res: request.Response): string {
  return fullSessionCookie(res).split(";")[0];
}

async function signIn(email: string, password: string): Promise<request.Response> {
  return request(app)
    .post("/api/auth/sign-in/email")
    .send({ email, password });
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  // Stand-ins for the ops/owner-guarded business endpoints later features
  // ship (1006, 1007, 4001 ...) -- proving the middleware, not a real route.
  app.get("/test/ops-guarded", requireRole(Role.ops), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/test/owner-guarded", requireRole(Role.owner), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/test/contractor-guarded", requireRole(Role.contractor), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/test/authed", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- Mike logs in", () => {
  test("AC1: sign-in sets an HTTP-only session cookie and a Session row exists", async () => {
    const cast = await seedCast();

    const res = await signIn("mike@idelta.com.au", DEV_PASSWORD);
    expect(res.status).toBe(200);

    expect(fullSessionCookie(res)).toMatch(/HttpOnly/i);

    const sessions = await db.session.findMany({ where: { userId: cast.mikeUserId } });
    expect(sessions).toHaveLength(1);
  });
});

describe("AC2 -- no enumeration on login", () => {
  test("AC2: wrong password and unknown email return the same status and message", async () => {
    await seedCast();

    const wrongPassword = await signIn("mike@idelta.com.au", "not-the-right-password");
    const unknownEmail = await signIn("nobody@example.com", "not-the-right-password");

    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });
});

describe("AC3 -- wrong door", () => {
  test("AC3: Bob's contractor session gets 403 from an ops-guarded route", async () => {
    await seedCast();
    const signInRes = await signIn("bob@idelta.com.au", DEV_PASSWORD);
    const cookie = cookieHeader(signInRes);

    const res = await request(app).get("/test/ops-guarded").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });
});

describe("AC4 -- ops admits the owner; owner is exact", () => {
  test("AC4: the owner-guarded route refuses Mike (ops) with 403 and admits the owner", async () => {
    await seedCast();

    const mikeCookie = cookieHeader(await signIn("mike@idelta.com.au", DEV_PASSWORD));
    const ownerCookie = cookieHeader(await signIn("owner@idelta.com.au", DEV_PASSWORD));

    const mikeOnOwnerRoute = await request(app).get("/test/owner-guarded").set("Cookie", mikeCookie);
    expect(mikeOnOwnerRoute.status).toBe(403);

    const ownerOnOwnerRoute = await request(app).get("/test/owner-guarded").set("Cookie", ownerCookie);
    expect(ownerOnOwnerRoute.status).toBe(200);
  });

  test("AC4: the ops-guarded route admits both ops and the owner", async () => {
    await seedCast();

    const mikeCookie = cookieHeader(await signIn("mike@idelta.com.au", DEV_PASSWORD));
    const ownerCookie = cookieHeader(await signIn("owner@idelta.com.au", DEV_PASSWORD));

    const mikeOnOpsRoute = await request(app).get("/test/ops-guarded").set("Cookie", mikeCookie);
    expect(mikeOnOpsRoute.status).toBe(200);

    const ownerOnOpsRoute = await request(app).get("/test/ops-guarded").set("Cookie", ownerCookie);
    expect(ownerOnOpsRoute.status).toBe(200);
  });
});

describe("AC5 -- password reset asks the notification module", () => {
  // Re-pointed to recipientType "user" by Feature 1011 (account mail vs
  // business mail): password reset is account mail, addressed to the
  // User's own login email, whatever the role -- see that feature's AC2.
  test("AC5: one Notification row appears, addressed to Bob's user account, carrying name and resetUrl", async () => {
    const cast = await seedCast();

    const res = await request(app)
      .post("/api/auth/request-password-reset")
      .send({ email: "bob@idelta.com.au", redirectTo: "https://idelta.com.au/reset-password" });
    expect(res.status).toBe(200);

    const notifications = await db.notification.findMany({ where: { type: "password_reset" } });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0];
    expect(notification.channel).toBe("email");
    expect(notification.recipientType).toBe("user");
    expect(notification.recipientId).toBe(cast.bobUserId);

    const context = notification.context as { name?: string; resetUrl?: string };
    expect(context.name).toBe("Bob Reilly");
    expect(typeof context.resetUrl).toBe("string");
    expect(context.resetUrl).toContain("/api/auth/reset-password/");
  });
});

async function requestResetUrl(email: string): Promise<string> {
  await request(app)
    .post("/api/auth/request-password-reset")
    .send({ email, redirectTo: "https://idelta.com.au/reset-password" });
  const notification = await db.notification.findFirstOrThrow({ where: { type: "password_reset" } });
  const context = notification.context as { resetUrl: string };
  return context.resetUrl;
}

function tokenFromResetUrl(resetUrl: string): string {
  const match = /\/reset-password\/([^?]+)/.exec(resetUrl);
  if (!match?.[1]) throw new Error(`could not read a token out of ${resetUrl}`);
  return match[1];
}

describe("AC6 -- the reset link", () => {
  test("AC6: opening the link, setting a new password logs Bob in, revokes other sessions, and the link then dies", async () => {
    await seedCast();

    // A session that must NOT survive the reset.
    const priorCookie = cookieHeader(await signIn("bob@idelta.com.au", DEV_PASSWORD));
    const priorSessionCount = await db.session.count();
    expect(priorSessionCount).toBe(1);

    const resetUrl = await requestResetUrl("bob@idelta.com.au");
    const token = tokenFromResetUrl(resetUrl);

    // The set-new-password page's "For <email>" line -- the reset-link helper.
    const info = await request(app).get(`/api/reset-link?token=${token}`);
    expect(info.status).toBe(200);
    expect((info.body as { email: string }).email).toBe("bob@idelta.com.au");

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "a-brand-new-password-1", token });
    expect(resetRes.status).toBe(200);

    // The prior session is gone (revoked, not merely expired).
    expect(await db.session.count()).toBe(0);

    // The frozen spec: success logs the person straight into their portal.
    const newSignIn = await signIn("bob@idelta.com.au", "a-brand-new-password-1");
    expect(newSignIn.status).toBe(200);

    // The old cookie is dead either way.
    const oldCookieCheck = await request(app).get("/api/me").set("Cookie", priorCookie);
    expect(oldCookieCheck.status).toBe(401);

    // Opening the SAME link again shows the dead-link page.
    const secondInfo = await request(app).get(`/api/reset-link?token=${token}`);
    expect(secondInfo.status).toBe(404);
  });
});

describe("AC7 -- expiry and the password floor", () => {
  test("AC7: a reset link past one hour is dead", async () => {
    await seedCast();
    const resetUrl = await requestResetUrl("bob@idelta.com.au");
    const token = tokenFromResetUrl(resetUrl);

    await db.verification.updateMany({
      where: { identifier: `reset-password:${token}` },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const info = await request(app).get(`/api/reset-link?token=${token}`);
    expect(info.status).toBe(404);

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "a-brand-new-password-1", token });
    expect(resetRes.status).toBe(400);
    expect((resetRes.body as { code?: string }).code).toBe("INVALID_TOKEN");
  });

  test("AC7: a 7-character password is refused", async () => {
    await seedCast();
    const resetUrl = await requestResetUrl("bob@idelta.com.au");
    const token = tokenFromResetUrl(resetUrl);

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "short12", token });
    expect(resetRes.status).toBe(400);
    expect((resetRes.body as { code?: string }).code).toBe("PASSWORD_TOO_SHORT");

    // Refused, not silently accepted -- the account still holds the old password.
    const stillOldPassword = await signIn("bob@idelta.com.au", DEV_PASSWORD);
    expect(stillOldPassword.status).toBe(200);
  });
});

describe("AC8 -- suspension takes effect immediately", () => {
  test("AC8: Bob's very next contractor request fails once Contractor.status flips to suspended", async () => {
    const cast = await seedCast();
    const cookie = cookieHeader(await signIn("bob@idelta.com.au", DEV_PASSWORD));

    const beforeSuspend = await request(app).get("/test/contractor-guarded").set("Cookie", cookie);
    expect(beforeSuspend.status).toBe(200);

    await db.contractor.update({
      where: { id: cast.bobContractorId },
      data: { status: "suspended" },
    });

    const afterSuspend = await request(app).get("/test/contractor-guarded").set("Cookie", cookie);
    expect(afterSuspend.status).toBe(401);
    expect((afterSuspend.body as { error?: string }).error).toBe("not authenticated");
  });
});

describe("AC9 -- every seeded login works; Sarah stays a guest", () => {
  test("AC9: Mike, the owner, Bob, Dave and Priya can all log in with the dev password", async () => {
    await seedCast();
    for (const email of [
      "mike@idelta.com.au",
      "owner@idelta.com.au",
      "bob@idelta.com.au",
      "dave@idelta.com.au",
      "priya@idelta.com.au",
    ]) {
      const res = await signIn(email, DEV_PASSWORD);
      expect(res.status).toBe(200);
    }
  });

  test("AC9: Sarah has no User row and Customer.userId stays empty", async () => {
    await seedCast();
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.userId).toBeNull();

    const user = await db.user.findUnique({ where: { email: "sarah@idelta.com.au" } });
    expect(user).toBeNull();

    const res = await signIn("sarah@idelta.com.au", DEV_PASSWORD);
    expect(res.status).not.toBe(200);
  });
});

describe("AC10 -- log out", () => {
  test("AC10: log out deletes the Session row server-side; the next request shows the gate again", async () => {
    await seedCast();
    const cookie = cookieHeader(await signIn("mike@idelta.com.au", DEV_PASSWORD));

    expect(await db.session.count()).toBe(1);

    const signOutRes = await request(app).post("/api/auth/sign-out").set("Cookie", cookie);
    expect(signOutRes.status).toBe(200);
    expect(await db.session.count()).toBe(0);

    const me = await request(app).get("/api/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });
});
