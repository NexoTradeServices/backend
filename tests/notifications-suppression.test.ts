// Feature 1004, notification module
//
// AC8  suppression is scoped by reason -- unsubscribed stops marketing only,
//      bounced stops everything on that address
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  invoiceEmail,
  promoEmail,
  recordingAdapter,
  seedCast,
  setProviders,
  type CastIds,
} from "./helpers/notifications.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let cast: CastIds;

const email = recordingAdapter("test-email", "email");

const SARAH_EMAIL = "sarah@idelta.com.au";

async function listSarah(reason: "unsubscribed" | "bounced" | "stopped"): Promise<void> {
  await db.suppression.create({ data: { channel: "email", address: SARAH_EMAIL, reason } });
}

/** One marketing message and one transactional message, both to Sarah, both drained. */
async function sendBoth(): Promise<{ promo: string; invoice: string }> {
  const promo = await sendNotification(
    {
      type: "promo",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      idempotencyKey: "promo:customer:winter-2026",
    },
    db,
  );
  const invoice = await sendNotification(
    {
      type: "invoice",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      idempotencyKey: "invoice:invoice:INV-2042",
      context: { invoiceReference: "INV-2042", payUrl: "https://pay.example/INV-2042" },
    },
    db,
  );
  await drainOnce(db);
  return { promo: promo.id, invoice: invoice.id };
}

beforeAll(() => {
  db = testClient();
  registerTemplate(invoiceEmail);
  registerTemplate(promoEmail);
  registerProvider(email);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  await setProviders(db, { emailProvider: email.name });
  // Sarah opted in, so the only thing that can stop a promo here is the
  // suppression list -- which is what this file is about.
  await db.customer.update({
    where: { id: cast.sarahId },
    data: { marketingConsent: { email: true, sms: true, optedInAt: "2026-08-30" } },
  });
  email.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC8 -- unsubscribed stops marketing, and nothing else", () => {
  test("AC8: with Sarah listed unsubscribed, the promo never sends", async () => {
    await listSarah("unsubscribed");
    const ids = await sendBoth();

    const promo = await db.notification.findUniqueOrThrow({ where: { id: ids.promo } });
    expect(promo.status).toBe("failed");
    expect(promo.error).toBe(`suppressed: ${SARAH_EMAIL} is listed as unsubscribed on email`);
  });

  test("AC8: and her invoice email still sends -- STOP stops marketing, not operations", async () => {
    await listSarah("unsubscribed");
    const ids = await sendBoth();

    const invoice = await db.notification.findUniqueOrThrow({ where: { id: ids.invoice } });
    expect(invoice.status).toBe("sent");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.subject).toBe("Invoice INV-2042");
  });

  test("AC8: an SMS STOP reads the same way -- stopped blocks marketing only", async () => {
    await listSarah("stopped");
    const ids = await sendBoth();

    const promo = await db.notification.findUniqueOrThrow({ where: { id: ids.promo } });
    const invoice = await db.notification.findUniqueOrThrow({ where: { id: ids.invoice } });
    expect(promo.status).toBe("failed");
    expect(invoice.status).toBe("sent");
  });
});

describe("AC8 -- bounced stops everything on that address", () => {
  test("AC8: with Sarah listed bounced, the promo AND the invoice are both suppressed", async () => {
    await listSarah("bounced");
    const ids = await sendBoth();

    const promo = await db.notification.findUniqueOrThrow({ where: { id: ids.promo } });
    const invoice = await db.notification.findUniqueOrThrow({ where: { id: ids.invoice } });

    expect(email.sent).toEqual([]);
    expect(promo.status).toBe("failed");
    expect(invoice.status).toBe("failed");
    expect(invoice.error).toBe(`suppressed: ${SARAH_EMAIL} is listed as bounced on email`);
  });

  test("AC8: a suppressed row is finished, not resting -- it is never retried", async () => {
    await listSarah("bounced");
    const ids = await sendBoth();

    await db.notification.update({
      where: { id: ids.invoice },
      data: { createdAt: new Date(Date.now() - 600 * 60_000) },
    });
    expect(await drainOnce(db)).toBe(0);
  });

  test("AC8: the list is per address -- Bob's dispatch email is untouched by Sarah's bounce", async () => {
    await listSarah("bounced");
    registerTemplate({
      type: "dispatched",
      channel: "email",
      category: "transactional",
      render: () => ({ subject: "New job JOB-1042", text: "A job is waiting for you." }),
    });

    await sendNotification(
      {
        type: "dispatched",
        channel: "email",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: "dispatched:assignment:a-1042",
      },
      db,
    );
    await drainOnce(db);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("bob@idelta.com.au");
  });
});
