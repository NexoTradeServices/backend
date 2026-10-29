// Feature 1004, notification module
//
// 7001 AC6  the delivery webhooks answer only at an address ending in their own secret
// AC10  provider delivery webhooks normalise into Notification.status, and an
//       unknown provider message id is ignored without erroring
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedCast, type CastIds } from "./helpers/notifications.js";
import { notificationWebhooks } from "../src/notifications/index.js";
import type { PrismaClient } from "../src/db/client.js";

// Feature 7001: the delivery webhooks answer only at an address ending in their secret (setup-env.ts).
const MAILJET_URL = `/webhooks/mailjet/${process.env["MAILJET_WEBHOOK_SECRET"] ?? ""}`;
const CLICKSEND_URL = `/webhooks/clicksend/${process.env["CLICKSEND_WEBHOOK_SECRET"] ?? ""}`;

let db: PrismaClient;
let app: Express;
let cast: CastIds;

/**
 * A row that has already been sent -- which is the only kind a delivery webhook
 * can be about. Sending is the dispatcher's story (AC3); this file starts where
 * that one ends.
 */
async function sentRow(options: {
  provider: string;
  providerMessageId: string;
  channel: "email" | "sms";
  key: string;
}): Promise<string> {
  const row = await db.notification.create({
    data: {
      recipientType: "customer",
      recipientId: cast.sarahId,
      channel: options.channel,
      type: options.channel === "email" ? "invoice" : "slot_confirmed",
      category: "transactional",
      status: "sent",
      provider: options.provider,
      providerMessageId: options.providerMessageId,
      sentAt: new Date(),
      attempts: 1,
      idempotencyKey: options.key,
    },
  });
  return row.id;
}

beforeAll(() => {
  db = testClient();
  app = express();
  app.use("/webhooks", notificationWebhooks(db));
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC10 -- Mailjet delivery events", () => {
  test("AC10: a delivered event moves the row to delivered with deliveredAt stamped", async () => {
    // The adapter stores Mailjet's string GUID, not its 64-bit MessageID: that
    // number is past what a JSON number holds exactly, and the webhook quotes
    // both. So the GUID is what has to be matched on.
    const id = await sentRow({
      provider: "mailjet",
      providerMessageId: "cb927469-36fd-4c02-bce4-0d199929a207",
      channel: "email",
      key: "invoice:invoice:INV-2042",
    });

    const response = await request(app)
      .post(MAILJET_URL)
      .send([
        {
          event: "delivered",
          MessageID: 70650219165027410,
          Message_GUID: "cb927469-36fd-4c02-bce4-0d199929a207",
          email: "sarah@idelta.com.au",
        },
      ]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: 1, matched: 1 });

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });

  test("AC10: the GUID wins over MessageID -- the row it names is the row that moves", async () => {
    const byGuid = await sentRow({
      provider: "mailjet",
      providerMessageId: "cb927469-36fd-4c02-bce4-0d199929a207",
      channel: "email",
      key: "invoice:invoice:INV-2042",
    });
    const byNumber = await sentRow({
      provider: "mailjet",
      providerMessageId: "70650219165027410",
      channel: "email",
      key: "invoice:invoice:INV-2043",
    });

    await request(app)
      .post(MAILJET_URL)
      .send([
        {
          event: "delivered",
          MessageID: 70650219165027410,
          Message_GUID: "cb927469-36fd-4c02-bce4-0d199929a207",
        },
      ])
      .expect(200);

    expect((await db.notification.findUniqueOrThrow({ where: { id: byGuid } })).status).toBe(
      "delivered",
    );
    expect((await db.notification.findUniqueOrThrow({ where: { id: byNumber } })).status).toBe(
      "sent",
    );
  });

  test("AC10: a hard-bounce event moves the row to failed, carrying the provider's words", async () => {
    const id = await sentRow({
      provider: "mailjet",
      providerMessageId: "12345",
      channel: "email",
      key: "invoice:invoice:INV-2043",
    });

    await request(app)
      .post(MAILJET_URL)
      .send({ event: "bounce", MessageID: 12345, hard_bounce: true, error: "user unknown" })
      .expect(200);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("mailjet bounce (hard): user unknown");
  });

  test("AC10: an unknown providerMessageId is ignored without erroring", async () => {
    const id = await sentRow({
      provider: "mailjet",
      providerMessageId: "12345",
      channel: "email",
      key: "invoice:invoice:INV-2044",
    });

    const response = await request(app)
      .post(MAILJET_URL)
      .send([{ event: "delivered", MessageID: 999999 }]);

    // 200, not 404: a provider retries anything that is not a 2xx, and a public
    // webhook sees noise as often as bugs.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: 1, matched: 0 });

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
  });

  test("AC10: an event that says nothing about delivery moves nothing", async () => {
    const id = await sentRow({
      provider: "mailjet",
      providerMessageId: "12345",
      channel: "email",
      key: "invoice:invoice:INV-2045",
    });

    const response = await request(app)
      .post(MAILJET_URL)
      .send([{ event: "open", MessageID: 12345 }]);

    expect(response.body).toMatchObject({ received: 0, matched: 0 });
    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
  });

  test("AC10: a Mailjet event never touches a ClickSend row that happens to share an id", async () => {
    const smsId = await sentRow({
      provider: "clicksend",
      providerMessageId: "12345",
      channel: "sms",
      key: "slot_confirmed:job:JOB-1042",
    });

    await request(app)
      .post(MAILJET_URL)
      .send([{ event: "delivered", MessageID: 12345 }])
      .expect(200);

    const row = await db.notification.findUniqueOrThrow({ where: { id: smsId } });
    expect(row.status).toBe("sent");
  });
});

describe("AC10 -- ClickSend delivery receipts", () => {
  test("AC10: a Delivered receipt moves the row to delivered", async () => {
    const id = await sentRow({
      provider: "clicksend",
      providerMessageId: "CS-9001",
      channel: "sms",
      key: "slot_confirmed:job:JOB-1042",
    });

    await request(app)
      .post(CLICKSEND_URL)
      .send({ message_id: "CS-9001", status: "Delivered" })
      .expect(200);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });

  test("AC10: an Undeliverable receipt moves the row to failed", async () => {
    const id = await sentRow({
      provider: "clicksend",
      providerMessageId: "CS-9002",
      channel: "sms",
      key: "slot_confirmed:job:JOB-1043",
    });

    await request(app)
      .post(CLICKSEND_URL)
      .send({ message_id: "CS-9002", status: "Undeliverable", error_text: "invalid number" })
      .expect(200);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("clicksend undeliverable: invalid number");
  });

  test("AC10: an unknown ClickSend message id is ignored without erroring", async () => {
    const response = await request(app)
      .post(CLICKSEND_URL)
      .send({ message_id: "CS-nope", status: "Delivered" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: 1, matched: 0 });
  });
});

describe("7001 AC6 -- who may call the delivery webhooks", () => {
  const CASES = [
    { provider: "mailjet", variable: "MAILJET_WEBHOOK_SECRET", body: [{ event: "bounce", Message_GUID: "guid-secret-1", hard_bounce: true, email: "sarah@idelta.com.au" }], id: "guid-secret-1", channel: "email" as const },
    { provider: "clicksend", variable: "CLICKSEND_WEBHOOK_SECRET", body: { message_id: "CS-secret-1", status: "Undeliverable" }, id: "CS-secret-1", channel: "sms" as const },
  ];

  for (const c of CASES) {
    test(`AC6: ${c.provider} -- no secret, a wrong secret and an unset secret answer 404 and change nothing`, async () => {
      const id = await sentRow({ provider: c.provider, providerMessageId: c.id, channel: c.channel, key: `secret-test:${c.provider}` });
      const good = process.env[c.variable] ?? "";

      await request(app).post(`/webhooks/${c.provider}`).send(c.body).expect(404);
      await request(app).post(`/webhooks/${c.provider}/not-the-secret`).send(c.body).expect(404);
      await request(app).post(`/webhooks/${c.provider}/${good}x`).send(c.body).expect(404);

      delete process.env[c.variable];
      try {
        await request(app).post(`/webhooks/${c.provider}/`).send(c.body).expect(404);
        await request(app).post(`/webhooks/${c.provider}/undefined`).send(c.body).expect(404);
        await request(app).post(`/webhooks/${c.provider}/${good}`).send(c.body).expect(404);
      } finally {
        process.env[c.variable] = good;
      }

      const row = await db.notification.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("sent");
      expect(await db.suppression.count()).toBe(0);

      // And with the right secret the same call is believed.
      await request(app).post(`/webhooks/${c.provider}/${good}`).send(c.body).expect(200);
      expect((await db.notification.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
    });
  }
});
