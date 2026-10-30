// Feature 7001 -- Change email on the job page's Customer card
//
// AC7  while Sarah's email is listed bounced the job read says so; Mike changes it; the read shows the
//      new address and the flag is gone; her next email goes to the new address
// AC8  Change email refuses a non-email, her own email and an email another customer holds (naming the
//      code), each answered with the field it belongs to; nothing changes
// AC9  when Sarah has a login, Change email moves her login email too: the new address signs in, the old one does not
// plus: ops-only (a contractor is 403, logged out 401)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { buildOpsApp, freshWorld, signIn } from "./helpers/ops-app.js";
import { passwordHasher } from "../src/auth/dev-password.js";
import { DEV_PASSWORD } from "../src/db/seed/auth.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { dispatchedEmail } from "./helpers/notifications.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-7001b", "email");

beforeAll(() => {
  db = testClient();
  app = buildOpsApp(db);
  resetProviders();
  registerProvider(email);
  registerTemplate(dispatchedEmail);
});

afterAll(async () => {
  resetProviders();
  resetTemplates();
  await db.$disconnect();
});

beforeEach(async () => {
  await freshWorld(db, email);
});

const change = (cookie: string, address: unknown) =>
  request(app).post("/api/jobs/JOB-1042/customer/email").set("Cookie", cookie).send({ email: address });
const read = (cookie: string) => request(app).get("/api/jobs/JOB-1042").set("Cookie", cookie);
interface Detail {
  customer: { email: string; emailBouncing: boolean };
}
const detailOf = (res: { body: unknown }): Detail => res.body as Detail;

describe("AC7 -- the Bouncing flag and the change", () => {
  test("AC7: flagged while listed, changed, flag gone, her next email goes to the new address", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    expect(detailOf(await read(mike)).customer.emailBouncing).toBe(false);

    await db.suppression.create({ data: { channel: "email", address: "sarah@idelta.com.au", reason: "bounced" } });
    expect(detailOf(await read(mike)).customer.emailBouncing).toBe(true);

    const res = await change(mike, "  Sarah.New@Idelta.com.au ").expect(200);
    expect(detailOf(res).customer.email).toBe("sarah.new@idelta.com.au");
    expect(detailOf(res).customer.emailBouncing).toBe(false);
    expect(detailOf(await read(mike)).customer.emailBouncing).toBe(false);

    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    await sendNotification({ type: "dispatched", channel: "email", recipientType: "customer", recipientId: sarah.id, idempotencyKey: "dispatched:job:ac7-next", context: { jobReference: "JOB-1042" } }, db);
    await drainOnce(db);
    expect(email.sent.map((m) => m.to)).toContain("sarah.new@idelta.com.au");
    expect(email.sent.map((m) => m.to)).not.toContain("sarah@idelta.com.au");
    // The dead address stays listed, harmless.
    expect(await db.suppression.count()).toBe(1);
  });
});

describe("AC8 -- refusals", () => {
  test("AC8: a non-email, her own email and another customer's email, each under the field; nothing changes", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const other = await db.customer.findFirstOrThrow({ where: { code: { not: "CUS-1050" } }, orderBy: { code: "asc" } });

    const bad = await change(mike, "not-an-email").expect(400);
    expect(bad.body).toEqual({ error: "That does not look like an email address.", field: "email" });
    await change(mike, "").expect(400);
    await change(mike, undefined).expect(400);

    const same = await change(mike, " SARAH@idelta.com.au ").expect(409);
    expect(same.body).toEqual({ error: "That is already Sarah's email.", field: "email" });

    const taken = await change(mike, other.email).expect(409);
    expect(taken.body).toEqual({ error: `Another customer, ${other.code}, already uses this email.`, field: "email" });

    const login = await change(mike, "bob@idelta.com.au").expect(409);
    expect(login.body).toEqual({ error: "Another login already uses this email.", field: "email" });

    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.email).toBe("sarah@idelta.com.au");
  });

  test("ops-only: a contractor is 403, logged out is 401", async () => {
    const bob = await signIn(app, "bob@idelta.com.au");
    await change(bob, "x@idelta.com.au").expect(403);
    await request(app).post("/api/jobs/JOB-1042/customer/email").send({ email: "x@idelta.com.au" }).expect(401);
  });
});

describe("AC9 -- her login follows", () => {
  test("AC9: the new address signs in and the old one does not", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const user = await db.user.create({ data: { name: sarah.name, email: sarah.email, role: "customer" } });
    const hash = await passwordHasher().hash(DEV_PASSWORD);
    await db.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash } });
    await db.customer.update({ where: { id: sarah.id }, data: { userId: user.id } });

    const mike = await signIn(app, "mike@idelta.com.au");
    await change(mike, "sarah.new@idelta.com.au").expect(200);

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe("sarah.new@idelta.com.au");
    const attempt = (address: string) => request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
    expect((await attempt("sarah.new@idelta.com.au")).status).toBe(200);
    expect((await attempt("sarah@idelta.com.au")).status).not.toBe(200);
  });
});
