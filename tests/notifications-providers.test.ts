// Feature 1004, notification module
//
// AC6  changing the default is config -- a settings row, not a deploy
// AC7  a cutover moves one message type only, and rolls back by deleting a line
// AC9  no credentials: dev logs it, production still boots (behaviour changed
//      by Feature 1009 -- notifications never block boot; see
//      notifications-boot-resilience.test.ts for that feature's own AC1-AC6)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  dispatchedEmail,
  dispatchedSms,
  invoiceEmail,
  recordingAdapter,
  seedCast,
  setProviders,
  type CastIds,
} from "./helpers/notifications.js";
import { drainOnce, sendNotification, startNotifications } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let cast: CastIds;

// Two interchangeable email providers, which is the whole point of the registry:
// "brevo" and "resend" in the design's own example are just two names in here.
const emailA = recordingAdapter("test-email-a", "email");
const emailB = recordingAdapter("test-email-b", "email");
const sms = recordingAdapter("test-sms", "sms");

async function sendInvoice(key: string): Promise<void> {
  await sendNotification(
    {
      type: "invoice",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      idempotencyKey: key,
      context: { invoiceReference: "INV-2042", payUrl: "https://pay.example/INV-2042" },
    },
    db,
  );
}

async function sendPasswordReset(key: string): Promise<void> {
  await sendNotification(
    {
      type: "password_reset",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      idempotencyKey: key,
      context: { name: "Sarah", resetUrl: "https://idelta.com.au/reset/abc123" },
    },
    db,
  );
}

beforeAll(() => {
  db = testClient();
  registerTemplate(dispatchedSms);
  registerTemplate(dispatchedEmail);
  registerTemplate(invoiceEmail);
  registerProvider(emailA);
  registerProvider(emailB);
  registerProvider(sms);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  await setProviders(db, {
    emailProvider: emailA.name,
    smsProvider: sms.name,
    providerOverrides: null,
  });
  emailA.reset();
  emailB.reset();
  sms.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC6 -- the default is config", () => {
  test("AC6: changing PlatformSettings.emailProvider routes the next email through the other adapter", async () => {
    await sendInvoice("invoice:invoice:INV-2042");
    await drainOnce(db);
    expect(emailA.sent).toHaveLength(1);
    expect(emailB.sent).toEqual([]);

    // The ONLY thing that changes between the two halves of this test is one
    // column in one row. No deploy, no code.
    await setProviders(db, { emailProvider: emailB.name });

    await sendInvoice("invoice:invoice:INV-2043");
    await drainOnce(db);
    expect(emailA.sent).toHaveLength(1);
    expect(emailB.sent).toHaveLength(1);

    const rows = await db.notification.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.provider)).toEqual(["test-email-a", "test-email-b"]);
  });
});

describe("AC7 -- a cutover moves one message type only", () => {
  test("AC7: with the override set, password reset goes to the other adapter and the invoice does not", async () => {
    await setProviders(db, { providerOverrides: { password_reset: emailB.name } });

    await sendPasswordReset(`password_reset:customer:${cast.sarahId}:1`);
    await sendInvoice("invoice:invoice:INV-2042");
    await drainOnce(db);

    expect(emailB.sent).toHaveLength(1);
    expect(emailB.sent[0]?.message.subject).toBe("Reset your password");
    expect(emailA.sent).toHaveLength(1);
    expect(emailA.sent[0]?.message.subject).toBe("Invoice INV-2042");
  });

  test("AC7: deleting the entry puts password reset straight back on the default", async () => {
    await setProviders(db, { providerOverrides: { password_reset: emailB.name } });
    await sendPasswordReset(`password_reset:customer:${cast.sarahId}:1`);
    await drainOnce(db);
    expect(emailB.sent).toHaveLength(1);

    // The rollback is deleting one line, exactly as the design frames it.
    await setProviders(db, { providerOverrides: {} });
    await sendPasswordReset(`password_reset:customer:${cast.sarahId}:2`);
    await drainOnce(db);

    expect(emailB.sent).toHaveLength(1);
    expect(emailA.sent).toHaveLength(1);
  });

  test("AC7: the provider named implies the channel -- an email override leaves that type's SMS alone", async () => {
    await setProviders(db, { providerOverrides: { dispatched: emailB.name } });

    await sendNotification(
      {
        type: "dispatched",
        channel: "email",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: "dispatched:assignment:a-1042",
        context: { jobReference: "JOB-1042" },
      },
      db,
    );
    await sendNotification(
      {
        type: "dispatched",
        channel: "sms",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: "dispatched:assignment:a-1042:sms",
        context: { jobReference: "JOB-1042" },
      },
      db,
    );
    await drainOnce(db);

    expect(emailB.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    const smsRow = await db.notification.findFirstOrThrow({ where: { channel: "sms" } });
    expect(smsRow.provider).toBe("test-sms");
  });
});

describe("AC9 -- credentials decide the environment", () => {
  const CLICKSEND_ENV = ["CLICKSEND_USERNAME", "CLICKSEND_API_KEY"] as const;
  let saved: (string | undefined)[];

  beforeEach(() => {
    saved = CLICKSEND_ENV.map((name) => process.env[name]);
    for (const name of CLICKSEND_ENV) delete process.env[name];
    // The real, shipped adapter -- exactly what a fresh clone has configured.
    resetProviders();
  });

  afterEach(() => {
    CLICKSEND_ENV.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    delete process.env["NODE_ENV"];
    registerProvider(emailA);
    registerProvider(emailB);
    registerProvider(sms);
  });

  test("AC9: with no ClickSend credentials and NODE_ENV not production, Bob's SMS is logged and still reaches sent", async () => {
    // clicksend is what the base seed names, and it has no credentials here.
    await setProviders(db, { smsProvider: "clicksend" });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const row = await sendNotification(
        {
          type: "dispatched",
          channel: "sms",
          recipientType: "contractor",
          recipientId: cast.bobId,
          idempotencyKey: "dispatched:assignment:a-1042",
          context: { jobReference: "JOB-1042" },
        },
        db,
      );
      await drainOnce(db);

      const after = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("sent");
      expect(after.provider).toBe("console");
      expect(after.sentAt).toBeInstanceOf(Date);

      const output = logged.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("0400 000 014"); // Bob's number
      expect(output).toContain("New job JOB-1042");
    } finally {
      logged.mockRestore();
    }
  });

  test("AC9: in production the same missing credentials do not refuse the boot (Feature 1009)", async () => {
    await setProviders(db, { emailProvider: "mailjet", smsProvider: "clicksend" });
    process.env["NODE_ENV"] = "production";

    const dispatcher = await startNotifications({ client: db, intervalMs: 3_600_000 });
    await dispatcher.stop();
  });

  test("AC9: in production WITH credentials the boot goes through", async () => {
    await setProviders(db, { emailProvider: "mailjet", smsProvider: "clicksend" });
    process.env["NODE_ENV"] = "production";
    process.env["CLICKSEND_USERNAME"] = "test-user";
    process.env["CLICKSEND_API_KEY"] = "test-key";
    const mailjetEnv = ["MAILJET_API_KEY", "MAILJET_API_SECRET", "MAILJET_FROM_EMAIL"] as const;
    const savedMailjet = mailjetEnv.map((name) => process.env[name]);
    for (const name of mailjetEnv) process.env[name] = "test";

    try {
      const dispatcher = await startNotifications({ client: db, intervalMs: 3_600_000 });
      await dispatcher.stop();
    } finally {
      mailjetEnv.forEach((name, index) => {
        const value = savedMailjet[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });
});
