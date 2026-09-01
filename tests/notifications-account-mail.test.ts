// Feature 1011 -- account mail to the account holder
//
// AC1  Mike (ops) and the owner request a password reset: the notification
//      row is recipientType user, addressed to their own idelta.com.au login
//      email, and sends
// AC2  see tests/auth.test.ts's AC5 -- Bob's reset re-pointed through user,
//      no regression for a role that worked before
// AC3  the recipientType enum migration applies to a database already
//      holding notification rows, without touching them
// AC4  an SMS send request naming a user recipient fails its row with the
//      no-phone reason; nothing crashes
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll, migrateDeploy } from "./helpers/database.js";
import { dispatchedSms, recordingAdapter, seedCast } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email", "email");
const sms = recordingAdapter("test-sms", "sms");

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  registerTemplate(dispatchedSms);
  registerProvider(email);
  registerProvider(sms);
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await db.platformSettings.updateMany({ data: { emailProvider: email.name, smsProvider: sms.name } });
  email.reset();
  sms.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

async function requestReset(emailAddress: string): Promise<void> {
  const res = await request(app)
    .post("/api/auth/request-password-reset")
    .send({ email: emailAddress, redirectTo: "https://idelta.com.au/reset-password" });
  expect(res.status).toBe(200);
}

describe("AC1 -- ops and owner resets are account mail, addressed and sent", () => {
  test("AC1: Mike's reset is recipientType user, addressed to mike@idelta.com.au, and sends", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    await requestReset("mike@idelta.com.au");

    const notification = await db.notification.findFirstOrThrow({ where: { type: "password_reset" } });
    expect(notification.recipientType).toBe("user");
    expect(notification.recipientId).toBe(mike.id);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("mike@idelta.com.au");
  });

  test("AC1: the owner's reset is recipientType user, addressed to owner@idelta.com.au, and sends", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@idelta.com.au" } });

    await requestReset("owner@idelta.com.au");

    const notification = await db.notification.findFirstOrThrow({ where: { type: "password_reset" } });
    expect(notification.recipientType).toBe("user");
    expect(notification.recipientId).toBe(owner.id);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("owner@idelta.com.au");
  });
});

describe("AC3 -- the enum migration is additive, existing rows untouched", () => {
  test("AC3: a pre-existing contractor-addressed row survives a re-run of migrate deploy, and `user` is usable alongside it", async () => {
    const cast = await seedCast(db);
    const existing = await db.notification.create({
      data: {
        recipientType: "contractor",
        recipientId: cast.bobId,
        channel: "sms",
        type: "dispatched",
        category: "transactional",
        idempotencyKey: "dispatched:assignment:pre-existing-1",
      },
    });

    // Re-applying the migration set (this feature's included) must not touch
    // a row already sitting on an old recipientType value.
    migrateDeploy();

    const after = await db.notification.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.recipientType).toBe("contractor");
    expect(after.recipientId).toBe(cast.bobId);
    expect(after.status).toBe(existing.status);

    // And the new value the migration added is usable right alongside it.
    const fresh = await db.notification.create({
      data: {
        recipientType: "user",
        recipientId: cast.bobId,
        channel: "email",
        type: "password_reset",
        category: "transactional",
        idempotencyKey: "password_reset:user:pre-existing-check",
      },
    });
    expect(fresh.recipientType).toBe("user");
  });
});

describe("AC4 -- SMS to a user recipient refuses, never crashes", () => {
  test("AC4: an SMS asked for a user recipient fails its row with the no-phone reason", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });

    const row = await sendNotification(
      {
        type: "dispatched",
        channel: "sms",
        recipientType: "user",
        recipientId: mike.id,
        idempotencyKey: `dispatched:user:${mike.id}`,
        context: { jobReference: "JOB-1042" },
      },
      db,
    );

    const handled = await drainOnce(db);
    expect(handled).toBe(1);

    const after = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toContain("no phone");
    expect(sms.sent).toHaveLength(0);
  });
});
