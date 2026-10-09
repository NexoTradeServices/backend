// Feature 6002 -- Stripe payment, receipt and the Receivables page
//
// AC1  a signed checkout.session.completed (paid, card) turns Sarah's invoice paid, keeps one
//      Payment, and queues one receipt to Sarah and one payment notice to the office inbox
// AC2  the same event again changes nothing and queues nothing more
// AC3  a bad or missing signature is refused (400) and changes nothing; an unknown event type
//      is answered 200 and changes nothing
// AC4  PayTo-style: completed + unpaid leaves it sent; async_payment_succeeded turns it paid
//      (method payto, the receipt says PayTo); async_payment_failed leaves it sent, sends nothing
// AC5  money on a voided invoice: it stays void, the Payment is kept, the office is told; no receipt
// AC6  Check payment with Stripe: paid session -> paid exactly as AC1; none -> not paid, nothing
//      changes; Stripe unreachable -> 502; refused for paid, void, zero-dollar and a contractor
// AC7  the receipt's wording, card and PayTo
// AC8  Receivables: order, count, total, due states on the business clock, billed to, paid /
//      void / zero-dollar left out, paging at 50
// AC11 no STRIPE_WEBHOOK_SECRET: one warning at boot, the webhook refuses every call
//
// No test reaches Stripe: the payment reader is a fake behind the adapter's seam, and every
// webhook call is signed with a secret this file sets.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Stripe from "stripe";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { owedInvoice, type OwedInvoice } from "./helpers/owed-invoice.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { receivablesRoutes } from "../src/payments/routes.js";
import { stripeWebhook } from "../src/payments/webhook.js";
import { dueStateOf, listReceivables, type ReceivablesResult } from "../src/payments/receivables.js";
import { recordConfirmedPayment } from "../src/payments/paid.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { setPaymentReader, warnIfWebhookSecretMissing, type PaymentReader, type StripePayment } from "../src/invoices/stripe.js";
import type { PrismaClient } from "../src/db/client.js";

const SECRET = "whsec_test_only_6002";

interface CheckBody {
  paid: boolean;
  checkedLabel: string;
  job: { invoice: unknown };
}
const PERTH = "Australia/Perth";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-6002", "email");
const sms = recordingAdapter("test-sms-6002", "sms");

// ---------------------------------------------------------------------------
// A fake Stripe behind the reader's seam
// ---------------------------------------------------------------------------

interface FakeReader extends PaymentReader {
  intents: Map<string, StripePayment>;
  /** payment link id -> payment intents of its complete and paid sessions */
  paidSessions: Map<string, string[]>;
  down: boolean;
}

function fakeReader(): FakeReader {
  const fake: FakeReader = {
    intents: new Map(),
    paidSessions: new Map(),
    down: false,
    readPaymentIntent(id) {
      if (fake.down) return Promise.reject(new Error("stripe is down"));
      const intent = fake.intents.get(id);
      return intent ? Promise.resolve(intent) : Promise.reject(new Error(`no such payment intent ${id}`));
    },
    paidPaymentIntentsOfLink(linkId) {
      if (fake.down) return Promise.reject(new Error("stripe is down"));
      return Promise.resolve(fake.paidSessions.get(linkId) ?? []);
    },
  };
  return fake;
}

let stripe: FakeReader;

/** Stripe holds a payment intent for the invoice. */
function intentFor(invoice: OwedInvoice, id: string, method = "card", amount = 65_500): string {
  stripe.intents.set(id, { paymentIntentId: id, invoiceId: invoice.invoiceId, amount, method, chargedAt: new Date("2026-10-15T06:15:00.000Z") });
  return id;
}

// 15 Oct 2026, 2:15pm AWST
const PAID_AT = Math.floor(new Date("2026-10-15T06:15:00.000Z").getTime() / 1000);

function eventOf(type: string, session: Record<string, unknown>, id = `evt_${type}_${String(Math.random()).slice(2)}`): string {
  return JSON.stringify({ id, object: "event", type, created: PAID_AT, data: { object: { object: "checkout.session", ...session } } });
}

function signed(payload: string, secret = SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function post(payload: string, signature: string | null = signed(payload)): Promise<request.Response> {
  const call = request(app).post("/webhooks/stripe").set("Content-Type", "application/json");
  if (signature !== null) call.set("Stripe-Signature", signature);
  return call.send(payload);
}

function completed(intentId: string, paymentStatus = "paid"): string {
  return eventOf("checkout.session.completed", { id: `cs_${intentId}`, payment_status: paymentStatus, payment_intent: intentId });
}

async function state(invoice: OwedInvoice) {
  const row = await db.invoice.findUniqueOrThrow({ where: { id: invoice.invoiceId } });
  const payments = await db.payment.findMany({ where: { invoiceId: invoice.invoiceId } });
  const notifications = await db.notification.findMany({ where: { jobId: invoice.jobId }, orderBy: { type: "asc" } });
  return { invoice: row, payments, notifications };
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  return cookieHeader(res);
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.use("/webhooks/stripe", stripeWebhook(db));
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/receivables", receivablesRoutes(db));
  registerProvider(email);
  registerProvider(sms);
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, smsProvider: sms.name, providerOverrides: null });
  email.reset();
  sms.reset();
  stripe = fakeReader();
  setPaymentReader(stripe);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  setPaymentReader(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

describe("AC1 / AC2 -- a card payment, and Stripe repeating itself", () => {
  test("AC1: completed + paid by card -> the invoice is paid, one Payment is kept, one receipt to Sarah and one notice to the office", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_sarah_card");

    const res = await post(completed(pi));
    expect(res.status).toBe(200);

    const after = await state(sarahs);
    expect(after.invoice.status).toBe("paid");
    expect(after.invoice.paidAt?.toISOString()).toBe("2026-10-15T06:15:00.000Z");
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ status: "succeeded", method: "card", amount: 65_500, stripePaymentIntentId: pi, customerId: sarahs.customerId });
    const payment = after.payments[0];
    expect(after.notifications.map((n) => [n.type, n.channel, n.recipientType, n.idempotencyKey])).toEqual([
      ["payment_receipt", "email", "customer", `payment_receipt:payment:${payment.id}:email`],
      ["payment_received", "email", "ops", `payment_received:payment:${payment.id}:email`],
    ]);
    expect(after.notifications.every((n) => n.relatedType === "payment" && n.relatedId === payment.id && n.jobId === sarahs.jobId)).toBe(true);

    await drainOnce(db);
    expect(email.sent.map((m) => m.to).sort()).toEqual(["ops@idelta.com.au", "sarah@idelta.com.au"]);
    const notice = email.sent.find((m) => m.to === "ops@idelta.com.au");
    expect(notice?.message.subject).toBe(`Payment received - INV-2042, $655 (${sarahs.jobReference})`);
    expect(notice?.message.text).toContain(`Sarah Chen paid INV-2042 for ${sarahs.jobReference}: $655 by card, 15 Oct 2026 at 2:15pm AWST.`);
    expect(notice?.message.text).toContain(`https://idelta.com.au/ops/jobs/${sarahs.jobReference}`);
    expect(sms.sent).toHaveLength(0);
  });

  test("AC2: the same event twice -- and the same payment under a second event id -- changes nothing and queues nothing more", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_sarah_twice");
    const payload = completed(pi);
    expect((await post(payload)).status).toBe(200);
    const once = await state(sarahs);

    expect((await post(payload)).status).toBe(200);
    expect((await post(completed(pi))).status).toBe(200);
    const twice = await state(sarahs);
    expect(twice.payments).toHaveLength(1);
    expect(twice.notifications).toHaveLength(2);
    expect(twice.invoice.paidAt).toEqual(once.invoice.paidAt);
  });

  test("AC2: two copies arriving together still keep one payment and one receipt", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_sarah_race");
    const [a, b] = await Promise.all([post(completed(pi)), post(completed(pi))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await state(sarahs);
    expect(after.payments).toHaveLength(1);
    expect(after.notifications).toHaveLength(2);
  });
});

describe("AC3 -- signatures and event types", () => {
  test("AC3: a bad signature, a signature made with another secret, and no signature are each refused with 400 and change nothing", async () => {
    const sarahs = await owedInvoice(db);
    const payload = completed(intentFor(sarahs, "pi_forged"));
    expect((await post(payload, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await post(payload, signed(payload, "whsec_someone_else"))).status).toBe(400);
    expect((await post(payload, null)).status).toBe(400);
    // A body changed after signing no longer matches its signature.
    expect((await post(payload.replace("paid", "PAID"), signed(payload))).status).toBe(400);

    const after = await state(sarahs);
    expect(after.invoice.status).toBe("sent");
    expect(after.payments).toHaveLength(0);
    expect(after.notifications).toHaveLength(0);
  });

  test("AC3: an unknown event type is answered 200 and changes nothing", async () => {
    const sarahs = await owedInvoice(db);
    const payload = JSON.stringify({ id: "evt_x", object: "event", type: "customer.created", created: PAID_AT, data: { object: { id: "cus_1" } } });
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, handled: "ignored" });
    expect((await state(sarahs)).invoice.status).toBe("sent");
  });

  test("a payment intent naming no invoice we hold is answered 200 and changes nothing", async () => {
    const sarahs = await owedInvoice(db);
    stripe.intents.set("pi_stranger", { paymentIntentId: "pi_stranger", invoiceId: "no-such-invoice", amount: 100, method: "card", chargedAt: null });
    stripe.intents.set("pi_no_meta", { paymentIntentId: "pi_no_meta", invoiceId: null, amount: 100, method: "card", chargedAt: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await post(completed("pi_stranger"))).status).toBe(200);
    expect((await post(completed("pi_no_meta"))).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await db.payment.count()).toBe(0);
    expect((await state(sarahs)).invoice.status).toBe("sent");
  });

  test("Stripe unreachable while reading the payment intent: 500, so Stripe tries again; nothing changes", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_later");
    stripe.down = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await post(completed(pi))).status).toBe(500);
    expect((await state(sarahs)).invoice.status).toBe("sent");
    stripe.down = false;
    expect((await post(completed(pi))).status).toBe(200);
    expect((await state(sarahs)).invoice.status).toBe("paid");
  });
});

describe("AC4 -- a later-settling method (PayTo)", () => {
  test("AC4: completed + unpaid leaves it sent; async_payment_succeeded turns it paid with method payto", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_payto", "payto");

    expect((await post(completed(pi, "unpaid"))).status).toBe(200);
    let now = await state(sarahs);
    expect(now.invoice.status).toBe("sent");
    expect(now.payments).toHaveLength(0);
    expect(now.notifications).toHaveLength(0);

    const succeeded = eventOf("checkout.session.async_payment_succeeded", { id: "cs_payto", payment_status: "paid", payment_intent: pi });
    expect((await post(succeeded)).status).toBe(200);
    now = await state(sarahs);
    expect(now.invoice.status).toBe("paid");
    expect(now.payments).toEqual([expect.objectContaining({ status: "succeeded", method: "payto", amount: 65_500 })]);
    expect(now.notifications.map((n) => n.type)).toEqual(["payment_receipt", "payment_received"]);

    await drainOnce(db);
    expect(email.sent.find((m) => m.to === "sarah@idelta.com.au")?.message.text).toContain("paid by PayTo on 15 Oct 2026");
  });

  test("AC4: async_payment_failed leaves it sent with its link still offered, keeps one failed Payment, sends nothing", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_payto_declined", "payto");
    const failed = eventOf("checkout.session.async_payment_failed", { id: "cs_declined", payment_status: "unpaid", payment_intent: pi });
    expect((await post(failed)).status).toBe(200);
    expect((await post(failed)).status).toBe(200);

    const now = await state(sarahs);
    expect(now.invoice.status).toBe("sent");
    expect(now.invoice.stripePaymentLinkUrl).toBe("https://pay.test/INV-2042");
    expect(now.payments).toEqual([expect.objectContaining({ status: "failed", method: "payto", stripePaymentIntentId: pi })]);
    expect(now.notifications).toHaveLength(0);

    // Mike's card still offers the link's backups.
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await request(app).get(`/api/jobs/${sarahs.jobReference}`).set("Cookie", mike);
    expect((job.body as CheckBody["job"]).invoice).toMatchObject({ status: "sent", canResend: true, canCheckPayment: true, paidLabel: null });
  });

  test("AC4: a failure that arrives after the money was confirmed never undoes it", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_payto_late", "payto");
    await post(eventOf("checkout.session.async_payment_succeeded", { id: "cs_l", payment_status: "paid", payment_intent: pi }));
    await post(eventOf("checkout.session.async_payment_failed", { id: "cs_l", payment_status: "unpaid", payment_intent: pi }));
    const now = await state(sarahs);
    expect(now.invoice.status).toBe("paid");
    expect(now.payments).toEqual([expect.objectContaining({ status: "succeeded" })]);
  });
});

describe("AC5 -- money on a voided invoice", () => {
  test("AC5: the invoice stays void, the Payment is kept, the office gets 'Payment on a closed invoice'; no receipt", async () => {
    const toms = await owedInvoice(db, { customerCode: "CUS-1052", status: "void" });
    const pi = intentFor(toms, "pi_tom_void");
    expect((await post(completed(pi))).status).toBe(200);

    const now = await state(toms);
    expect(now.invoice.status).toBe("void");
    expect(now.invoice.paidAt).toBeNull();
    expect(now.payments).toEqual([expect.objectContaining({ status: "succeeded", amount: 65_500, method: "card" })]);
    expect(now.notifications.map((n) => [n.type, n.recipientType])).toEqual([["payment_closed_invoice", "ops"]]);

    // Repeated, still only the one notice.
    await post(completed(pi));
    expect(await db.notification.count({ where: { jobId: toms.jobId } })).toBe(1);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    const notice = email.sent[0];
    expect(notice?.to).toBe("ops@idelta.com.au");
    expect(notice?.message.subject).toBe(`Payment on a closed invoice - ${toms.invoiceReference}, $655`);
    expect(notice?.message.text).toContain(
      `A payment of $655 by card arrived on ${toms.invoiceReference} (${toms.jobReference}), which is void. Nothing has been booked against the invoice. Decide with the customer whether it stands or is refunded.`,
    );
    expect(notice?.message.text).toContain(`/ops/jobs/${toms.jobReference}`);
  });
});

describe("AC11 -- no STRIPE_WEBHOOK_SECRET", () => {
  test("AC11: one warning, and the webhook refuses every call, however it is signed", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnIfWebhookSecretMissing();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe("payments: STRIPE_WEBHOOK_SECRET is not set -- no payment will be marked paid until it is");

    const sarahs = await owedInvoice(db);
    const payload = completed(intentFor(sarahs, "pi_unset"));
    expect((await post(payload)).status).toBe(400);
    expect((await post(payload, null)).status).toBe(400);
    expect((await state(sarahs)).invoice.status).toBe("sent");

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    warn.mockClear();
    warnIfWebhookSecretMissing();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Check payment with Stripe
// ---------------------------------------------------------------------------

describe("AC6 -- Check payment with Stripe", () => {
  async function check(cookie: string, reference: string): Promise<request.Response> {
    return request(app).post(`/api/jobs/${reference}/invoice/check-payment`).set("Cookie", cookie);
  }

  test("AC6: a paid session at Stripe and no webhook -- Mike's check turns it paid exactly as the webhook would, once", async () => {
    const sarahs = await owedInvoice(db);
    const pi = intentFor(sarahs, "pi_checked");
    stripe.paidSessions.set(sarahs.paymentLinkId!, [pi]);
    const mike = await signInCookie("mike@idelta.com.au");

    const res = await check(mike, sarahs.jobReference);
    expect(res.status).toBe(200);
    expect((res.body as CheckBody).paid).toBe(true);
    expect((res.body as CheckBody).job.invoice).toMatchObject({ status: "paid", canCheckPayment: false, canResend: false, paidLabel: "15 Oct 2026, card" });

    const now = await state(sarahs);
    expect(now.invoice.status).toBe("paid");
    expect(now.payments).toEqual([expect.objectContaining({ status: "succeeded", method: "card", stripePaymentIntentId: pi })]);
    expect(now.notifications.map((n) => n.type)).toEqual(["payment_receipt", "payment_received"]);

    // Stripe's late message afterwards changes nothing.
    expect((await post(completed(pi))).status).toBe(200);
    expect(await db.notification.count({ where: { jobId: sarahs.jobId } })).toBe(2);
    expect(await db.payment.count()).toBe(1);
  });

  test("AC6: no paid session -- 'not paid', nothing changes", async () => {
    const sarahs = await owedInvoice(db);
    const mike = await signInCookie("mike@idelta.com.au");
    const res = await check(mike, sarahs.jobReference);
    expect(res.status).toBe(200);
    expect((res.body as CheckBody).paid).toBe(false);
    // When it was checked, on the job's clock -- for the card's own line.
    expect((res.body as CheckBody).checkedLabel).toMatch(/^\d{1,2}:\d{2}(am|pm) AWST$/);
    const now = await state(sarahs);
    expect(now.invoice.status).toBe("sent");
    expect(now.payments).toHaveLength(0);
    expect(now.notifications).toHaveLength(0);
  });

  test("AC6: Stripe unreachable -- 502 'Couldn't reach Stripe - try again in a minute.', nothing changes", async () => {
    const sarahs = await owedInvoice(db);
    stripe.down = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mike = await signInCookie("mike@idelta.com.au");
    const res = await check(mike, sarahs.jobReference);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Couldn't reach Stripe - try again in a minute." });
    expect((await state(sarahs)).invoice.status).toBe("sent");

    // No STRIPE_SECRET_KEY at all is the same answer.
    setPaymentReader(null);
    expect((await check(mike, sarahs.jobReference)).status).toBe(502);
  });

  test("AC6: refused for a paid, void or zero-dollar invoice and one still waiting for its link; and for a contractor", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    for (const options of [{ status: "paid" as const }, { status: "void" as const }, { isZeroDollar: true }, { withLink: false }]) {
      const made = await owedInvoice(db, options);
      expect((await check(mike, made.jobReference)).status).toBe(409);
    }
    const sarahs = await owedInvoice(db);
    const bob = await signInCookie("bob@idelta.com.au");
    expect((await check(bob, sarahs.jobReference)).status).toBe(403);
    expect((await state(sarahs)).invoice.status).toBe("sent");
  });

  test("a pretend pay link from the browser tests' hook is answered 'not paid' without asking Stripe", async () => {
    const sarahs = await owedInvoice(db);
    await db.invoice.update({ where: { id: sarahs.invoiceId }, data: { stripePaymentLinkId: "plink_test_INV-2042" } });
    setPaymentReader(null); // as in CI: no key
    const mike = await signInCookie("mike@idelta.com.au");
    const res = await check(mike, sarahs.jobReference);
    expect(res.status).toBe(200);
    expect((res.body as CheckBody).paid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

describe("AC7 -- the receipt's wording", () => {
  test("AC7: Sarah's card receipt names INV and JOB, $655, card, the date and time in AWST, nothing further owed, the office number; no attachment, no button", async () => {
    const sarahs = await owedInvoice(db);
    await post(completed(intentFor(sarahs, "pi_receipt")));
    await drainOnce(db);
    const receipt = email.sent.find((m) => m.to === "sarah@idelta.com.au");
    expect(receipt?.message.subject).toBe("Payment received - INV-2042, $655 - thank you");
    expect(receipt?.message.text).toBe(
      [
        "Hi Sarah,",
        "",
        `Thank you - we've received your payment of $655 for invoice INV-2042 (${sarahs.jobReference}), paid by card on 15 Oct 2026 at 2:15pm AWST.`,
        "",
        "Nothing further is owed.",
        "",
        "Questions? Call us on 08 0000 0000.",
        "",
        "-- Perth Trades & Services",
      ].join("\n"),
    );
    expect(receipt?.attachments ?? []).toHaveLength(0);
    expect(receipt?.message.html).not.toContain("<a ");
  });

  test("AC7: a PayTo receipt says PayTo; another method is named as Stripe names it", async () => {
    const one = await owedInvoice(db);
    await recordConfirmedPayment(db, { invoiceId: one.invoiceId, paymentIntentId: "pi_a", amount: 65_500, method: "payto", paidAt: new Date(PAID_AT * 1000) });
    const two = await owedInvoice(db);
    await recordConfirmedPayment(db, { invoiceId: two.invoiceId, paymentIntentId: "pi_b", amount: 65_500, method: "au_becs_debit", paidAt: new Date(PAID_AT * 1000) });
    await drainOnce(db);
    const receipts = email.sent.filter((m) => m.to === "sarah@idelta.com.au").map((m) => m.message.text);
    expect(receipts.some((text) => text.includes("paid by PayTo on 15 Oct 2026"))).toBe(true);
    expect(receipts.some((text) => text.includes("paid by au becs debit on 15 Oct 2026"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------

describe("AC8 -- Receivables", () => {
  const DAY = 86_400_000;

  test("AC8: Tom 12 days overdue first, then Nina due today, then Sarah due in 4 days; count 3 and the total; paid, void and zero-dollar left out", async () => {
    const now = Date.now();
    const sarahs = await owedInvoice(db, { dueAt: new Date(now + 4 * DAY), amount: 65_500 });
    const ninas = await owedInvoice(db, {
      customer: { name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "Rossi's Cafe" },
      dueAt: new Date(now),
      amount: 25_000,
    });
    const toms = await owedInvoice(db, { customerCode: "CUS-1052", dueAt: new Date(now - 12 * DAY), amount: 43_000, withLink: false });
    await owedInvoice(db, { status: "paid", dueAt: new Date(now - 30 * DAY) });
    await owedInvoice(db, { status: "void", dueAt: new Date(now - 30 * DAY) });
    await owedInvoice(db, { isZeroDollar: true, dueAt: new Date(now - 30 * DAY) });

    const mike = await signInCookie("mike@idelta.com.au");
    const res = await request(app).get("/api/receivables").set("Cookie", mike);
    expect(res.status).toBe(200);
    const body = res.body as ReceivablesResult;
    expect(body.count).toBe(3);
    expect(body.total).toBe(65_500 + 25_000 + 43_000);
    expect(body.nextCursor).toBeNull();
    expect(body.rows.map((r) => [r.invoiceReference, r.jobReference, r.due.kind, r.due.label])).toEqual([
      [toms.invoiceReference, toms.jobReference, "overdue", "12 days overdue"],
      [ninas.invoiceReference, ninas.jobReference, "today", "Due today"],
      [sarahs.invoiceReference, sarahs.jobReference, "later", "Due in 4 days"],
    ]);
    expect(body.rows[0]).toMatchObject({ billedTo: { name: "Tom", businessName: null }, phone: "0400 001 052", amount: 43_000, waitingForPayLink: true });
    expect(body.rows[1]).toMatchObject({ billedTo: { name: "Nina Rossi", businessName: "Rossi's Cafe" }, phone: "0400 002 060", waitingForPayLink: false });
    expect(body.rows[2]).toMatchObject({ billedTo: { name: "Sarah Chen", businessName: null }, phone: "0400 001 050" });
    expect(body.rows[2]?.dueLabel).toMatch(/^\d{1,2} \w{3} \d{4}$/);

    // A paid invoice leaves the list by itself.
    await recordConfirmedPayment(db, { invoiceId: sarahs.invoiceId, paymentIntentId: "pi_s", amount: 65_500, method: "card", paidAt: new Date() });
    const after = (await request(app).get("/api/receivables").set("Cookie", mike)).body as ReceivablesResult;
    expect(after.count).toBe(2);
    expect(after.rows.map((r) => r.invoiceReference)).toEqual([toms.invoiceReference, ninas.invoiceReference]);
  });

  test("AC8: nothing owed -- count 0, total 0, no rows; a contractor is refused", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await request(app).get("/api/receivables").set("Cookie", mike)).body).toEqual({ count: 0, total: 0, rows: [], nextCursor: null });
    const bob = await signInCookie("bob@idelta.com.au");
    expect((await request(app).get("/api/receivables").set("Cookie", bob)).status).toBe(403);
    expect((await request(app).get("/api/receivables")).status).toBe(401);
  });

  test("AC8: the due state is read on the business clock, not UTC's", () => {
    // 00:30 on Fri 16 Oct in Perth (16:30 UTC on the 15th).
    const now = new Date("2026-10-15T16:30:00.000Z");
    // Due 11pm Thu 15 Oct Perth: the same UTC date as now, but yesterday on the business clock.
    expect(dueStateOf(new Date("2026-10-15T15:00:00.000Z"), PERTH, now)).toEqual({ kind: "overdue", label: "1 day overdue" });
    // Due 9am Fri 16 Oct Perth.
    expect(dueStateOf(new Date("2026-10-16T01:00:00.000Z"), PERTH, now)).toEqual({ kind: "today", label: "Due today" });
    // Due 11:59pm Sat 17 Oct Perth.
    expect(dueStateOf(new Date("2026-10-17T15:59:00.000Z"), PERTH, now)).toEqual({ kind: "later", label: "Due in 1 day" });
    expect(dueStateOf(new Date("2026-10-20T01:00:00.000Z"), PERTH, now)).toEqual({ kind: "later", label: "Due in 4 days" });
  });

  test("AC8: 50 at a time -- the next page carries on where the first stopped, with no row twice", async () => {
    const start = Date.now() - 60 * DAY;
    for (let i = 0; i < 51; i += 1) {
      await owedInvoice(db, { dueAt: new Date(start + i * 3_600_000), amount: 100 });
    }
    const first = await listReceivables(db, PERTH);
    expect(first.count).toBe(51);
    expect(first.total).toBe(5_100);
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();

    const mike = await signInCookie("mike@idelta.com.au");
    const second = (await request(app).get(`/api/receivables?after=${first.nextCursor ?? ""}`).set("Cookie", mike)).body as ReceivablesResult;
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.rows, ...second.rows].map((r) => r.invoiceReference);
    expect(new Set(all).size).toBe(51);
    expect(all[0]).toBe("INV-2042");
    expect(all[50]).toBe("INV-2092");

    // The page's refresh asks for every row it shows at once.
    const refresh = (await request(app).get("/api/receivables?limit=51").set("Cookie", mike)).body as ReceivablesResult;
    expect(refresh.rows).toHaveLength(51);
    expect(refresh.nextCursor).toBeNull();

    // A cursor this read never made starts from the top.
    const odd = (await request(app).get("/api/receivables?after=nonsense").set("Cookie", mike)).body as ReceivablesResult;
    expect(odd.rows).toHaveLength(50);
  });
});
