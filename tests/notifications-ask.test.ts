// Feature 1004, notification module
//
// AC1   asking returns before any provider is called, and writes ONE queued row
// AC2   the same idempotency key sends once
// AC11  the password-reset email renders from its template plus variables
// AC12  marketing with no consent on that channel is never sent, and says why
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  dispatchedSms,
  invoiceEmail,
  promoEmail,
  promoSms,
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
const sms = recordingAdapter("test-sms", "sms");

beforeAll(() => {
  db = testClient();
  registerTemplate(dispatchedSms);
  registerTemplate(invoiceEmail);
  registerTemplate(promoEmail);
  registerTemplate(promoSms);
  registerProvider(email);
  registerProvider(sms);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name });
  email.reset();
  sms.reset();
});

afterEach(() => {
  email.reset();
  sms.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC1 -- asking the module is not sending", () => {
  test("AC1: Bob's dispatch SMS returns before any provider is called", async () => {
    const row = await sendNotification(
      {
        type: "dispatched",
        channel: "sms",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: "dispatched:assignment:a-1042",
        relatedType: "assignment",
        relatedId: "a-1042",
        context: { jobReference: "JOB-1042" },
      },
      db,
    );

    // The whole point of the module being async: the caller is already back.
    expect(sms.sent).toEqual([]);
    expect(row.status).toBe("queued");
  });

  test("AC1: it writes exactly one row, and the row says who, how and what kind", async () => {
    await sendNotification(
      {
        type: "dispatched",
        channel: "sms",
        recipientType: "contractor",
        recipientId: cast.bobId,
        idempotencyKey: "dispatched:assignment:a-1042",
        relatedType: "assignment",
        relatedId: "a-1042",
        context: { jobReference: "JOB-1042" },
      },
      db,
    );

    const rows = await db.notification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: "contractor",
      recipientId: cast.bobId,
      channel: "sms",
      category: "transactional",
      status: "queued",
      attempts: 0,
    });
  });

  test("AC1: category comes from the message, so a caller cannot claim marketing is transactional", async () => {
    const row = await sendNotification(
      {
        type: "promo",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: "promo:customer:winter-2026",
      },
      db,
    );
    expect(row.category).toBe("marketing");
  });
});

describe("AC2 -- the same key sends once", () => {
  test("AC2: two calls keyed dispatched:assignment:<id> leave exactly one row", async () => {
    const ask = {
      type: "dispatched",
      channel: "sms",
      recipientType: "contractor",
      recipientId: cast.bobId,
      idempotencyKey: "dispatched:assignment:a-1042",
      context: { jobReference: "JOB-1042" },
    } as const;

    const first = await sendNotification(ask, db);
    const second = await sendNotification(ask, db);

    expect(await db.notification.count()).toBe(1);
    // The second call gets the row that already exists -- a double-trigger is
    // indistinguishable from the first ask, from the caller's side.
    expect(second.id).toBe(first.id);
  });

  test("AC2: and exactly one provider call comes out the other end", async () => {
    const ask = {
      type: "dispatched",
      channel: "sms",
      recipientType: "contractor",
      recipientId: cast.bobId,
      idempotencyKey: "dispatched:assignment:a-1042",
      context: { jobReference: "JOB-1042" },
    } as const;

    await sendNotification(ask, db);
    await sendNotification(ask, db);
    await drainOnce(db);

    expect(sms.sent).toHaveLength(1);
  });

  test("AC2: the key's shape is enforced, so a caller cannot invent one that cannot collide", async () => {
    await expect(
      sendNotification(
        {
          type: "dispatched",
          channel: "sms",
          recipientType: "contractor",
          recipientId: cast.bobId,
          idempotencyKey: "just-a-string",
        },
        db,
      ),
    ).rejects.toThrow(/idempotency key/);
  });
});

describe("AC11 -- the password-reset email", () => {
  const resetUrl = "https://idelta.com.au/reset/abc123";

  async function sendSarahsReset(): Promise<void> {
    await sendNotification(
      {
        type: "password_reset",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `password_reset:customer:${cast.sarahId}:2026-08-30T10:00`,
        relatedType: "customer",
        relatedId: cast.sarahId,
        context: { name: "Sarah", resetUrl },
      },
      db,
    );
    await drainOnce(db);
  }

  test("AC11: it renders from the template plus her name and the reset link", async () => {
    await sendSarahsReset();

    expect(email.sent).toHaveLength(1);
    const message = email.sent[0]?.message;
    expect(email.sent[0]?.to).toBe("sarah@idelta.com.au");
    expect(message?.subject).toBe("Reset your password");
    expect(message?.text).toContain("Hi Sarah,");
    expect(message?.text).toContain(resetUrl);
    expect(message?.html).toContain(`href="${resetUrl}"`);
  });

  test("AC11: and the row carries password_reset / transactional / email / customer, at sent", async () => {
    await sendSarahsReset();

    const row = await db.notification.findFirstOrThrow();
    expect(row).toMatchObject({
      type: "password_reset",
      category: "transactional",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      status: "sent",
    });
  });

  test("AC11: values are escaped into the HTML part and left alone in the text part", async () => {
    // Sarah types her own name into the enquiry form, so every template variable
    // is somebody's free text. Review finding R1.2.
    await sendNotification(
      {
        type: "password_reset",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `password_reset:customer:${cast.sarahId}:escaping`,
        context: { name: "Bob & Sons <plumbing>", resetUrl },
      },
      db,
    );
    await drainOnce(db);

    const message = email.sent[0]?.message;
    expect(message?.html).toContain("Hi Bob &amp; Sons &lt;plumbing&gt;,");
    expect(message?.html).not.toContain("<plumbing>");
    // The sign-off carries an ampersand of its own, and it is markup too.
    expect(message?.html).toContain("Perth Trades &amp; Services");
    // Plain text is not markup and must not be mangled.
    expect(message?.text).toContain("Hi Bob & Sons <plumbing>,");
    expect(message?.text).toContain("-- Perth Trades & Services");
  });

  test("AC11: a missing variable stops the message rather than sending a blank link", async () => {
    const row = await sendNotification(
      {
        type: "password_reset",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `password_reset:customer:${cast.sarahId}:no-link`,
        context: { name: "Sarah" },
      },
      db,
    );
    await drainOnce(db);

    const after = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(email.sent).toEqual([]);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("resetUrl");
  });
});

describe("AC12 -- marketing needs consent, per channel", () => {
  test("AC12: with no marketingConsent at all, Sarah's promo is never sent and the row says why", async () => {
    const row = await sendNotification(
      {
        type: "promo",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: "promo:customer:winter-2026",
      },
      db,
    );
    await drainOnce(db);

    const after = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(email.sent).toEqual([]);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("no marketing consent for email");
  });

  test("AC12: consent is per channel -- email opted in, SMS not, so only the email goes", async () => {
    await db.customer.update({
      where: { id: cast.sarahId },
      data: { marketingConsent: { email: true, sms: false, optedInAt: "2026-08-30" } },
    });

    await sendNotification(
      {
        type: "promo",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: "promo:customer:winter-2026",
      },
      db,
    );
    await sendNotification(
      {
        type: "promo",
        channel: "sms",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: "promo:customer:winter-2026:sms",
      },
      db,
    );
    await drainOnce(db);

    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toEqual([]);
    const blocked = await db.notification.findFirstOrThrow({ where: { channel: "sms" } });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toBe("no marketing consent for sms");
  });

  test("AC12: a transactional message to the same customer ignores consent entirely", async () => {
    await sendNotification(
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

    expect(email.sent).toHaveLength(1);
    const row = await db.notification.findFirstOrThrow();
    expect(row.status).toBe("sent");
  });
});
