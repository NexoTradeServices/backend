// Feature 2006 -- the "Contractor agreement updated" email
//
// AC6  publishing emails every active contractor, once each per version, with the
//      "Read and accept" button to /contractor/agreement; a deactivated contractor gets nothing
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { fakeStorage, makePdf } from "./helpers/agreements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { agreementRoutes } from "../src/agreements/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
const email = recordingAdapter("test-email-2006", "email");

beforeAll(() => {
  db = testClient();
  const auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use(express.json());
  app.use("/api", agreementRoutes(db, { storage: () => fakeStorage() }));
  registerProvider(email);
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await db.platformSettings.updateMany({ data: { emailProvider: email.name } });
  email.reset();
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

async function ownerCookie(): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: "owner@idelta.com.au", password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (cookies.find((c) => c.includes("better-auth.session_token=")) ?? "").split(";")[0] ?? "";
}

async function publish(label: string): Promise<void> {
  const res = await request(app)
    .post(`/api/agreements?label=${label}`)
    .set("Cookie", await ownerCookie())
    .set("Content-Type", "application/pdf")
    .send(await makePdf(label));
  expect(res.status).toBe(201);
}

describe("AC6 -- the update email", () => {
  test("AC6: one email per active contractor, with the Read and accept button; none to a deactivated one", async () => {
    await db.contractor.update({ where: { code: "CON-030" }, data: { status: "suspended" } });
    await publish("1");

    const rows = await db.notification.findMany({ where: { type: "contractor_agreement_updated" } });
    const active = await db.contractor.findMany({ where: { status: "active" }, select: { userId: true } });
    expect(rows.map((r) => r.recipientId).sort()).toEqual(active.map((c) => c.userId).sort());
    const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
    expect(rows.map((r) => r.recipientId)).not.toContain(priya.userId);

    await drainOnce();
    expect(email.sent.map((m) => m.to).sort()).toEqual(["bob@idelta.com.au", "dave@idelta.com.au"]);
    const bobMail = email.sent.find((m) => m.to === "bob@idelta.com.au")?.message;
    expect(bobMail?.html).toContain("Read and accept");
    expect(bobMail?.html).toContain("/contractor/agreement");
    expect(bobMail?.text).toContain("no new jobs can be sent to you");
    expect(bobMail?.text).toContain("Jobs you have already booked go ahead");
  });

  test("AC6: once per contractor per version - a new version sends again, the same key never twice", async () => {
    await publish("1");
    const first = await db.notification.count({ where: { type: "contractor_agreement_updated" } });
    await new Promise((r) => setTimeout(r, 5));
    await publish("2");
    expect(await db.notification.count({ where: { type: "contractor_agreement_updated" } })).toBe(first * 2);

    const { sendNotification } = await import("../src/notifications/index.js");
    const version = await db.contractorAgreementVersion.findUniqueOrThrow({ where: { version: "2" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await sendNotification(
      {
        type: "contractor_agreement_updated",
        channel: "email",
        recipientType: "user",
        recipientId: bob.userId,
        idempotencyKey: `contractor_agreement_updated:contractor:${bob.id}:${version.id}`,
        context: { name: "Bob Reilly", version: "2", agreementUrl: "x" },
      },
      db,
    );
    expect(await db.notification.count({ where: { type: "contractor_agreement_updated" } })).toBe(first * 2);
  });
});
