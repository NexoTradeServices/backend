// Feature 7001 -- bounced emails
//
// AC1  a Mailjet hard-bounce report lists the address bounced on email, marks the row failed, and sends
//      the office one "Email bouncing - Sarah Chen" naming the address, "Job booked - JOB-1042" and a
//      button "Open JOB-1042"
// AC2  the next email to that address is not sent (suppressed); the next text still sends
// AC3  a second bounce for the same address sends no second notice
// AC4  a bounce for Bob names Bob Reilly and links to his record; one for Lena names her as the site
//      contact on JOB-1042 and links to the job page
// AC5  a soft bounce, a block or a spam report marks the row failed and lists nothing; no notice
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { dispatchedEmail, dispatchedSms, recordingAdapter } from "./helpers/notifications.js";
import { acceptJob1042, buildOpsApp, freshWorld } from "./helpers/ops-app.js";
import { drainOnce, notificationWebhooks, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { setProviders } from "./helpers/notifications.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let opsApp: Express;
let hooks: Express;
let jobId: string;

const email = recordingAdapter("test-email-7001", "email");
const sms = recordingAdapter("test-sms-7001", "sms");
const SECRET_URL = `/webhooks/mailjet/${process.env["MAILJET_WEBHOOK_SECRET"] ?? ""}`;

beforeAll(() => {
  db = testClient();
  opsApp = buildOpsApp(db);
  hooks = express();
  hooks.use("/webhooks", notificationWebhooks(db));
  resetProviders();
  registerProvider(email);
  registerProvider(sms);
  registerTemplate(dispatchedEmail);
  registerTemplate(dispatchedSms);
});

afterAll(async () => {
  resetProviders();
  resetTemplates();
  await db.$disconnect();
});

beforeEach(async () => {
  await freshWorld(db, email);
  await setProviders(db, { smsProvider: sms.name });
  sms.reset();
  ({ jobId } = await acceptJob1042(db, opsApp));
  await drainOnce(db);
});

/** The row Sarah's (or Lena's) Job booked email left, handed Mailjet's id the way a real send would. */
async function mailjetRow(recipientType: "customer" | "site_contact", guid: string) {
  const row = await db.notification.findFirstOrThrow({
    where: { jobId, type: "slot_confirmed", channel: "email", recipientType },
  });
  await db.notification.update({ where: { id: row.id }, data: { provider: "mailjet", providerMessageId: guid, status: "sent" } });
  return row;
}

function report(guid: string, address: string, extra: Record<string, unknown> = {}) {
  return request(hooks)
    .post(SECRET_URL)
    .send([{ event: "bounce", Message_GUID: guid, email: address, hard_bounce: true, error: "user unknown", ...extra }]);
}

async function opsNotices() {
  await drainOnce(db);
  return email.sent.filter((m) => (m.message.subject ?? "").startsWith("Email bouncing")).map((m) => ({ to: m.to, subject: m.message.subject, text: m.message.text, html: m.message.html }));
}

describe("AC1 -- a hard bounce lists the address and tells the office once", () => {
  test("AC1: listed bounced on email, row failed, one office notice with the exact parts", async () => {
    const row = await mailjetRow("customer", "guid-sarah-1");
    email.sent = [];

    await report("guid-sarah-1", "Sarah@Idelta.com.au").expect(200);

    const listed = await db.suppression.findMany();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ channel: "email", address: "sarah@idelta.com.au", reason: "bounced" });
    const failed = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed.status).toBe("failed");

    const notices = await opsNotices();
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice?.subject).toBe("Email bouncing - Sarah Chen");
    expect(notice?.to).toBe("ops@idelta.com.au");
    expect(notice?.text).toContain("Sarah Chen's email address sarah@idelta.com.au is bouncing - it is misspelt or no longer exists.");
    expect(notice?.text).toContain("What did not arrive: Job booked - JOB-1042.");
    expect(notice?.text).toContain("Nothing more will be emailed to this address. Texts still go to Sarah's phone. Ring Sarah, check the address and correct it on the job page.");
    expect(notice?.text).toContain("Open JOB-1042: https://idelta.com.au/ops/jobs/JOB-1042");
    expect(notice?.html).toContain('<a href="https://idelta.com.au/ops/jobs/JOB-1042">Open JOB-1042</a>');
    expect(notice?.text).not.toContain("$");
  });
});

describe("AC2 -- nothing more is emailed to a bounced address; texts carry on", () => {
  test("AC2: the next email to Sarah is suppressed and her next text sends", async () => {
    await mailjetRow("customer", "guid-sarah-2");
    await report("guid-sarah-2", "sarah@idelta.com.au").expect(200);
    await drainOnce(db);
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    email.sent = [];
    sms.sent = [];

    const mail = await sendNotification({ type: "dispatched", channel: "email", recipientType: "customer", recipientId: sarah.id, idempotencyKey: "dispatched:job:ac2-mail", context: { jobReference: "JOB-1042" } }, db);
    const text = await sendNotification({ type: "dispatched", channel: "sms", recipientType: "customer", recipientId: sarah.id, idempotencyKey: "dispatched:job:ac2-text", context: { jobReference: "JOB-1042" } }, db);
    await drainOnce(db);

    expect(email.sent.filter((m) => m.to === "sarah@idelta.com.au")).toHaveLength(0);
    expect((await db.notification.findUniqueOrThrow({ where: { id: mail.id } })).error).toContain("suppressed");
    expect(sms.sent).toHaveLength(1);
    expect((await db.notification.findUniqueOrThrow({ where: { id: text.id } })).status).not.toBe("failed");
  });
});

describe("AC3 -- one notice per address", () => {
  test("AC3: a second bounce for the same address sends no second notice", async () => {
    await mailjetRow("customer", "guid-sarah-3");
    await report("guid-sarah-3", "sarah@idelta.com.au").expect(200);
    await report("guid-sarah-3", "sarah@idelta.com.au").expect(200);
    await report("guid-sarah-3", "SARAH@idelta.com.au").expect(200);

    expect(await db.suppression.count()).toBe(1);
    expect(await db.notification.count({ where: { type: "email_bouncing" } })).toBe(1);
    expect(await opsNotices()).toHaveLength(1);
  });
});

describe("AC4 -- who it is", () => {
  test("AC4: Bob Reilly, linked to his contractor record", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await db.notification.create({
      data: {
        recipientType: "contractor", recipientId: bob.id, channel: "email", type: "job_dispatched", category: "transactional",
        status: "sent", provider: "mailjet", providerMessageId: "guid-bob-1", jobId, idempotencyKey: "job_dispatched:job:ac4-bob",
      },
    });
    email.sent = [];
    await report("guid-bob-1", "bob@idelta.com.au").expect(200);

    const [notice] = await opsNotices();
    expect(notice?.subject).toBe("Email bouncing - Bob Reilly");
    expect(notice?.text).toContain("Bob Reilly's email address bob@idelta.com.au is bouncing");
    expect(notice?.text).toContain("What did not arrive: Job dispatched - JOB-1042.");
    expect(notice?.text).toContain("correct it on Bob's record.");
    expect(notice?.text).toContain(`Open Bob's record: https://idelta.com.au/ops/contractors/${bob.code}`);
  });

  test("AC4: Lena Park, the site contact on JOB-1042, linked to the job page", async () => {
    await mailjetRow("site_contact", "guid-lena-1");
    email.sent = [];
    await report("guid-lena-1", "lena@idelta.com.au").expect(200);

    const [notice] = await opsNotices();
    expect(notice?.subject).toBe("Email bouncing - Lena Park");
    expect(notice?.text).toContain("Lena Park, the site contact on JOB-1042, has an email address lena@idelta.com.au that is bouncing");
    expect(notice?.text).toContain("Texts still go to Lena's phone.");
    expect(notice?.text).toContain("Open JOB-1042: https://idelta.com.au/ops/jobs/JOB-1042");
  });

  test("AC4: a login's own mail with no job: the person by name, no button", async () => {
    const user = await db.user.findFirstOrThrow({ orderBy: { email: "asc" } });
    await db.notification.create({
      data: {
        recipientType: "user", recipientId: user.id, channel: "email", type: "password_reset", category: "transactional",
        status: "sent", provider: "mailjet", providerMessageId: "guid-user-1", idempotencyKey: "password_reset:user:ac4-user",
      },
    });
    email.sent = [];
    await report("guid-user-1", user.email).expect(200);
    const [notice] = await opsNotices();
    expect(notice?.text).not.toContain("Open ");
    expect(notice?.text).toContain("What did not arrive: Password reset.");
  });
});

describe("AC5 -- only a hard bounce lists", () => {
  for (const [label, body] of [
    ["a soft bounce", { event: "bounce", hard_bounce: false }],
    ["a block", { event: "blocked", hard_bounce: false }],
    ["a spam report", { event: "spam" }],
    ["a hard-flagged block", { event: "blocked", hard_bounce: true }],
  ] as const) {
    test(`AC5: ${label} marks the row failed and lists nothing`, async () => {
      const row = await mailjetRow("customer", "guid-sarah-5");
      email.sent = [];
      await request(hooks).post(SECRET_URL).send([{ Message_GUID: "guid-sarah-5", email: "sarah@idelta.com.au", error: "x", ...body }]).expect(200);

      expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("failed");
      expect(await db.suppression.count()).toBe(0);
      expect(await opsNotices()).toHaveLength(0);
    });
  }

  test("AC5: a text that fails lists nothing", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    await db.notification.create({
      data: {
        recipientType: "customer", recipientId: sarah.id, channel: "sms", type: "slot_confirmed", category: "transactional",
        status: "sent", provider: "clicksend", providerMessageId: "CS-7001", idempotencyKey: "slot_confirmed:job:ac5-sms",
      },
    });
    await request(hooks).post(`/webhooks/clicksend/${process.env["CLICKSEND_WEBHOOK_SECRET"] ?? ""}`).send({ message_id: "CS-7001", status: "Undeliverable" }).expect(200);
    expect(await db.suppression.count()).toBe(0);
  });
});
