// Feature 3004 -- guest to account upgrade (the endpoint and its mail)
//
// AC2  a known guest asks for a link: a login is made and linked, the Set your password email goes
//      to her own address with "We've already got you - just set a password to finish."
// AC3  the emailed link sets her password and logs her in; still one Customer, her jobs hers
// AC4  asking again once she has a password sends Already have an account instead
// AC5  an unknown address gets the same answer and nothing is sent or created; an address held by a
//      login with no customer record (the owner) gets Already have an account, never a link
// AC6  a confirmed bot is refused with the call-us words, nothing created or sent; an unreachable
//      reCAPTCHA lets the request through
// AC7  asking twice inside a minute sends one email, the answer the same both times
// AC8  asking again before finishing sends a fresh link and the old one stops working
// AC12 Forgot password for a customer with no password gets Set your password, never the contractor welcome
// plus: bad input is 400; the per-client-IP limiter answers 429
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { accountRoutes } from "../src/account/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { RecaptchaVerdict } from "../src/enquiries/recaptcha.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;
let verdict: RecaptchaVerdict;

const email = recordingAdapter("test-email-3004", "email");

function buildApp(perIpPerMinute?: number): Express {
  const a = express();
  a.all("/api/auth/*splat", toNodeHandler(auth));
  a.use(express.json());
  a.use(
    "/api/account",
    accountRoutes(db, auth, { verifyRecaptcha: () => Promise.resolve(verdict), ...(perIpPerMinute === undefined ? {} : { perIpPerMinute }) }),
  );
  return a;
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  app = buildApp(1000);
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  verdict = "human";
  email.reset();
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

function ask(address: string, server: Express = app) {
  return request(server).post("/api/account/set-password-request").send({ email: address, recaptchaToken: "t" });
}

function tokenOf(resetUrl: string): string {
  const match = /\/reset-password\/([^?]+)/.exec(resetUrl);
  if (!match?.[1]) throw new Error(`no token in ${resetUrl}`);
  return match[1];
}

async function latestResetUrl(): Promise<string> {
  const row = await db.notification.findFirstOrThrow({ where: { type: "customer_set_password" }, orderBy: { createdAt: "desc" } });
  return (row.context as { resetUrl: string }).resetUrl;
}

async function expireHold(): Promise<void> {
  await db.notification.updateMany({ data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
}

describe("AC2/AC3 -- a guest sets a password", () => {
  test("AC2: Sarah asks; a login is made and linked, and the Set your password email reaches her with the wording", async () => {
    const sarahBefore = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarahBefore.userId).toBeNull();

    const res = await ask("Sarah@idelta.com.au ");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.userId).not.toBeNull();
    const user = await db.user.findUniqueOrThrow({ where: { id: sarah.userId ?? "" } });
    expect(user.role).toBe("customer");
    expect(user.email).toBe("sarah@idelta.com.au");
    expect(await db.account.count({ where: { userId: user.id } })).toBe(0);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("sarah@idelta.com.au");
    expect(email.sent[0]?.message.subject).toBe("Set your password");
    expect(email.sent[0]?.message.text).toContain("We've already got you - just set a password to finish.");
    expect(email.sent[0]?.message.text).toContain("/reset-password");
  });

  test("AC3: the link sets her password and logs her in; she is still one customer with every job hers", async () => {
    const jobsBefore = await db.job.count({ where: { customer: { code: "CUS-1050" } } });
    const customersBefore = await db.customer.count();
    await ask("sarah@idelta.com.au");
    const token = tokenOf(await latestResetUrl());

    const reset = await request(app).post("/api/auth/reset-password").send({ newPassword: "sarah-a-new-password-1", token });
    expect(reset.status).toBe(200);
    const signIn = await request(app).post("/api/auth/sign-in/email").send({ email: "sarah@idelta.com.au", password: "sarah-a-new-password-1" });
    expect(signIn.status).toBe(200);

    expect(await db.customer.count()).toBe(customersBefore);
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.userId).not.toBeNull();
    expect(await db.job.count({ where: { customerId: sarah.id } })).toBe(jobsBefore);
  });
});

describe("AC4/AC5 -- Already have an account, and the unknown address", () => {
  test("AC4: once she has a password, asking again sends Already have an account with Log in and the Forgot password line", async () => {
    await ask("sarah@idelta.com.au");
    const token = tokenOf(await latestResetUrl());
    await request(app).post("/api/auth/reset-password").send({ newPassword: "sarah-a-new-password-1", token });
    await drainOnce(db);
    email.reset();
    await expireHold();

    const res = await ask("sarah@idelta.com.au");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.subject).toBe("You already have an account");
    expect(email.sent[0]?.message.text).toContain("/account");
    expect(email.sent[0]?.message.text).toContain("/forgot-password");
    expect(await db.notification.count({ where: { type: "customer_set_password" } })).toBe(1);
  });

  test("AC5: an address with no Customer gets the same answer, nothing is sent and nothing is created", async () => {
    const users = await db.user.count();
    const res = await ask("nobody@idelta.com.au");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await drainOnce(db);
    expect(email.sent).toHaveLength(0);
    expect(await db.user.count()).toBe(users);
    expect(await db.notification.count()).toBe(0);
  });

  test("AC5: the owner's address (a login, no customer record) gets the same answer and nothing is sent", async () => {
    const res = await ask("owner@idelta.com.au");
    expect(res.body).toEqual({ ok: true });
    await drainOnce(db);
    expect(email.sent).toHaveLength(0);
  });

  test("a customer record sharing an email with a login of another role gets Already have an account and is never linked", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    await db.customer.update({ where: { code: "CUS-1050" }, data: { email: "mike@idelta.com.au" } });
    await ask("mike@idelta.com.au");
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.subject).toBe("You already have an account");
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.userId).toBeNull();
    expect(mike.role).not.toBe("customer");
  });
});

describe("AC6 -- reCAPTCHA", () => {
  test("AC6: a confirmed bot is refused with the call-us words; nothing is created or sent", async () => {
    verdict = "bot";
    const res = await ask("sarah@idelta.com.au");
    expect(res.status).toBe(403);
    expect((res.body as { operatorPhone: string }).operatorPhone).not.toBe("");
    expect((await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } })).userId).toBeNull();
    await drainOnce(db);
    expect(email.sent).toHaveLength(0);
  });

  test("AC6: an unreachable check lets the request through", async () => {
    verdict = "unreachable";
    const res = await ask("sarah@idelta.com.au");
    expect(res.status).toBe(200);
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
  });
});

describe("AC7/AC8 -- the hold and the fresh link", () => {
  test("AC7: asking twice inside a minute sends one email and answers the same both times", async () => {
    const first = await ask("sarah@idelta.com.au");
    const second = await ask("sarah@idelta.com.au");
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
  });

  test("AC8: a guest who asked and never finished asks again; a fresh link arrives and the old one stops working", async () => {
    await ask("sarah@idelta.com.au");
    const oldToken = tokenOf(await latestResetUrl());
    await expireHold();
    await ask("sarah@idelta.com.au");
    const urls = (await db.notification.findMany({ where: { type: "customer_set_password" }, orderBy: { createdAt: "asc" } })).map(
      (row) => (row.context as { resetUrl: string }).resetUrl,
    );
    expect(urls).toHaveLength(2);
    const newToken = tokenOf(urls[1] ?? "");
    expect(newToken).not.toBe(oldToken);

    const old = await request(app).post("/api/auth/reset-password").send({ newPassword: "sarah-a-new-password-1", token: oldToken });
    expect(old.status).not.toBe(200);
    const fresh = await request(app).post("/api/auth/reset-password").send({ newPassword: "sarah-a-new-password-1", token: newToken });
    expect(fresh.status).toBe(200);
    expect(await db.user.count({ where: { email: "sarah@idelta.com.au" } })).toBe(1);
  });
});

describe("AC12 -- Forgot password for a customer with no password", () => {
  test("AC12: gets Set your password, never the contractor welcome", async () => {
    await ask("sarah@idelta.com.au");
    await drainOnce(db);
    email.reset();
    await expireHold();
    const res = await request(app).post("/api/auth/request-password-reset").send({ email: "sarah@idelta.com.au", redirectTo: "https://idelta.com.au/reset-password" });
    expect(res.status).toBe(200);
    expect(await db.notification.count({ where: { type: "contractor_onboarding" } })).toBe(0);
    expect(await db.notification.count({ where: { type: "customer_set_password" } })).toBe(2);
  });
});

describe("input and the limiter", () => {
  test("a missing or malformed email is 400 on the field email", async () => {
    for (const bad of ["", "not-an-email", undefined]) {
      const res = await request(app).post("/api/account/set-password-request").send({ email: bad });
      expect(res.status).toBe(400);
      expect((res.body as { field: string }).field).toBe("email");
    }
  });

  test("the per-client-IP limiter answers 429 past its allowance", async () => {
    const limited = buildApp(2);
    expect((await ask("nobody@idelta.com.au", limited)).status).toBe(200);
    expect((await ask("nobody@idelta.com.au", limited)).status).toBe(200);
    expect((await ask("nobody@idelta.com.au", limited)).status).toBe(429);
  });
});
