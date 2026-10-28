// Feature 3004 AC9 -- the account offer on customer messages
//
// AC9  every listed customer email and text carries "Want to track all your jobs? Set a password"
//      (link to /set-password) while the customer is a guest, and "Log in to see all your jobs"
//      (link to /account) once she has a password; the site-contact wording, the enquiry
//      confirmation, and ops, contractor and account mail carry neither.
//
// The dispatcher adds the footer; the templates here are stand-ins so the test pins the module's
// rule for each type, not each template's own wording.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, seedCast, setProviders } from "./helpers/notifications.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { OFFER_FOOTER_TYPES } from "../src/notifications/templates/footer.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let sarahId: string;
let bobId: string;

const email = recordingAdapter("test-email-3004b", "email");
const sms = recordingAdapter("test-sms-3004b", "sms");

const UNLISTED_CUSTOMER_TYPES = ["enquiry_confirmation", "password_reset", "customer_set_password", "account_exists"];

function stand(type: string, channel: "email" | "sms") {
  registerTemplate({
    type,
    channel,
    category: "transactional",
    render: () => (channel === "email" ? { subject: `${type} subject`, text: "Body.", html: "<p>Body.</p>" } : { text: "Body." }),
  });
}

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  registerProvider(sms);
});

beforeEach(async () => {
  await truncateAll(db);
  ({ sarahId, bobId } = await seedCast(db));
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  email.reset();
  sms.reset();
  resetTemplates();
  for (const type of [...OFFER_FOOTER_TYPES, ...UNLISTED_CUSTOMER_TYPES, "job_dispatched"]) {
    stand(type, "email");
    stand(type, "sms");
  }
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

async function send(type: string, channel: "email" | "sms", recipientType: "customer" | "contractor", context: Record<string, string> = {}): Promise<void> {
  await sendNotification(
    {
      type,
      channel,
      recipientType,
      recipientId: recipientType === "customer" ? sarahId : bobId,
      idempotencyKey: `${type}:${channel}:${recipientType}:${Math.random().toString(36).slice(2)}`,
      context,
    },
    db,
  );
}

async function makeSarahHaveALogin(): Promise<void> {
  const user = await db.user.create({ data: { name: "Sarah Chen", email: "sarah@idelta.com.au", role: "customer" } });
  await db.account.create({ data: { userId: user.id, accountId: user.id, providerId: "credential", password: "x" } });
  await db.customer.update({ where: { id: sarahId }, data: { userId: user.id } });
}

describe("AC9 -- the footer by state", () => {
  test("a guest: every listed type, both channels, carries the Set a password offer with the link", async () => {
    for (const type of OFFER_FOOTER_TYPES) {
      await send(type, "email", "customer");
      await send(type, "sms", "customer");
    }
    await drainOnce(db, 100);
    expect(email.sent).toHaveLength(OFFER_FOOTER_TYPES.size);
    expect(sms.sent).toHaveLength(OFFER_FOOTER_TYPES.size);
    for (const sent of email.sent) {
      expect(sent.message.text).toContain("Want to track all your jobs? Set a password: https://idelta.com.au/set-password");
      expect(sent.message.html).toContain('href="https://idelta.com.au/set-password"');
    }
    for (const sent of sms.sent) {
      expect(sent.message.text).toContain("https://idelta.com.au/set-password");
      expect(sent.message.text.length).toBeLessThan(160);
    }
  });

  test("once she has a password: Log in to see all your jobs, with the /account link", async () => {
    await makeSarahHaveALogin();
    await send("slot_confirmed", "email", "customer");
    await send("slot_confirmed", "sms", "customer");
    await drainOnce(db, 100);
    expect(email.sent[0]?.message.text).toContain("Log in to see all your jobs: https://idelta.com.au/account");
    expect(email.sent[0]?.message.text).not.toContain("Set a password");
    expect(sms.sent[0]?.message.text).toContain("https://idelta.com.au/account");
  });

  test("a customer with a login row but no password still reads as a guest", async () => {
    const user = await db.user.create({ data: { name: "Sarah Chen", email: "sarah@idelta.com.au", role: "customer" } });
    await db.customer.update({ where: { id: sarahId }, data: { userId: user.id } });
    await send("invoice", "email", "customer");
    await drainOnce(db, 100);
    expect(email.sent[0]?.message.text).toContain("Set a password");
  });

  test("the enquiry confirmation and account mail carry neither offer", async () => {
    for (const type of UNLISTED_CUSTOMER_TYPES) await send(type, "email", "customer");
    await drainOnce(db, 100);
    expect(email.sent).toHaveLength(UNLISTED_CUSTOMER_TYPES.length);
    for (const sent of email.sent) expect(sent.message.text).toBe("Body.");
  });

  test("the site-contact wording and contractor mail carry neither offer", async () => {
    await send("slot_confirmed", "email", "customer", { audience: "site_contact" });
    await send("slot_confirmed", "email", "contractor");
    await send("job_dispatched", "sms", "contractor");
    await drainOnce(db, 100);
    expect(email.sent.map((sent) => sent.message.text)).toEqual(["Body.", "Body."]);
    expect(sms.sent.map((sent) => sent.message.text)).toEqual(["Body."]);
  });
});
