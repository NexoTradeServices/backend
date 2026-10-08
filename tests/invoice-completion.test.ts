// Feature 6001 -- invoice at completion, with the Stripe pay link and its backups
//
// AC1  Complete issues the invoice in the same moment: lines, splits, INV number, status, due date, the two links
// AC2  the assignment keeps the snapshot; a platform part is on the invoice but not repaid
// AC3  a 1.0h job has only Tier 1; a 3.0h job has Tier 2 for 2.0h
// AC4  weekend / emergency Tuesday / emergency stamped on a Saturday; the earliest entry decides Bob's multiplier
// AC5  GST off and on, the PDF heading and totals, a flip after issue changes nothing
// AC6  billed to: Nina's business, Sarah alone, a later customer change changes nothing
// AC7  the PDF header is the legal identity; references, dates, lines, pay link; no bank account
// AC8  one Payment Link: amount, AUD, one payment, no method list, metadata, idempotency key; stored; asked twice = one
// AC9  email (attached PDF) and SMS queued once each to the customer, never the site contact
// AC10 Stripe unreachable: Complete still succeeds, invoice waits, nothing goes, every pass asks again, then once
// AC11 no STRIPE_SECRET_KEY: boots with one warning, invoices issue and wait
// AC12 (back half) Bob's read carries the pay link / waiting, no amount; Dave never sees it
// AC13 (back half) the ops job read carries the invoice, with GST by its own stamp
// AC14 Resend: a fresh pair to the customer as she is now; refused when waiting / paid / void / zero-dollar / by a contractor
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { pdfText } from "./helpers/agreements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { contractorJobRoutes, type ContractorJobView } from "../src/contractors/job-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { mountTestDataRoutes } from "../src/test-data/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { nextReference } from "../src/db/reference.js";
import { mailjetEmail } from "../src/notifications/providers/mailjet.js";
import { consoleEmail } from "../src/notifications/providers/console.js";
import {
  completionArithmetic,
  contractorMultiplierOf,
  customerMultiplierOf,
  gstWithin,
  labourTotal,
} from "../src/invoices/arithmetic.js";
import { buildInvoicePdf } from "../src/invoices/pdf.js";
import { issueInvoice } from "../src/invoices/issue.js";
import { payLinkPass, startPayLinkLoop } from "../src/invoices/pay-link.js";
import {
  idempotencyKeyFor,
  payLinkParams,
  setPayLinkProvider,
  warnIfStripeMissing,
  type PayLinkProvider,
  type PayLinkRequest,
} from "../src/invoices/stripe.js";
import type { InvoiceView } from "../src/invoices/view.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-6001", "email");
const sms = recordingAdapter("test-sms-6001", "sms");

// ---------------------------------------------------------------------------
// A fake Stripe behind the adapter's seam -- no test ever reaches the network
// ---------------------------------------------------------------------------

interface FakeStripe extends PayLinkProvider {
  calls: PayLinkRequest[];
  failWith: string | null;
  delayMs: number;
}

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    calls: [],
    failWith: null,
    delayMs: 0,
    async createPayLink(req) {
      fake.calls.push(req);
      if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
      if (fake.failWith !== null) throw new Error(fake.failWith);
      return { url: `https://pay.test/${req.invoiceReference}`, id: `plink_${req.invoiceReference}` };
    },
  };
  return fake;
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
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/contractor/jobs", contractorJobRoutes(db));
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
  // Complete's own first try does nothing unless a test turns Stripe on.
  setPayLinkProvider(null);
});

afterEach(() => {
  setPayLinkProvider(undefined);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The cast's job, ready to complete
// ---------------------------------------------------------------------------

const PERTH = "Australia/Perth";

interface MakeJob {
  /** The visit's date; 2026-10-07 is a Wednesday, 2026-10-06 a Tuesday, 2026-10-10 a Saturday. */
  date?: string;
  level?: "normal" | "weekend" | "emergency" | null;
  customerCode?: string;
  customer?: { name: string; email: string; businessName?: string; billingAddress?: Record<string, string | number | null> };
  siteContact?: { name: string; phone: string; email?: string };
}

async function acceptedJob(opts: MakeJob = {}): Promise<{ jobId: string; assignmentId: string; reference: string; customerId: string }> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("fixture Bob has no Plumbing specialty");
  const customer = opts.customer
    ? await db.customer.create({
        data: {
          code: await nextReference("CUS", db),
          name: opts.customer.name,
          email: opts.customer.email,
          businessName: opts.customer.businessName ?? null,
          ...(opts.customer.billingAddress ? { billingAddress: opts.customer.billingAddress } : {}),
        },
      })
    : await db.customer.findUniqueOrThrow({ where: { code: opts.customerCode ?? "CUS-1050" } });
  const slot = new Date(`${opts.date ?? "2026-10-07"}T00:00:00.000Z`);
  const reference = await nextReference("JOB", db);
  const job = await db.job.create({
    data: {
      reference,
      customerId: customer.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteAddress: { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      ...(opts.siteContact ? { siteContact: opts.siteContact } : {}),
      timezone: PERTH,
      description: "The mixer tap in the kitchen leaks.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: "scheduled",
      ...(opts.level === null ? {} : { serviceLevel: opts.level ?? "normal" }),
    },
  });
  const assignment = await db.assignment.create({
    data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: new Date() },
  });
  return { jobId: job.id, assignmentId: assignment.id, reference, customerId: customer.id };
}

async function receiptFor(assignmentId: string, jobId: string): Promise<string> {
  const row = await db.attachment.create({
    data: { jobId, assignmentId, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/abc123", fileName: "receipt.jpg" },
  });
  return row.id;
}

/** 08:00 - 11:00 on `date` bills 3.0h. */
function threeHours(date = "2026-10-07") {
  return [{ date, start: "08:00", end: "11:00", note: "" }];
}

async function complete(cookie: string, reference: string, body: object): Promise<request.Response> {
  return request(app).post(`/api/contractor/jobs/${reference}/complete`).set("Cookie", cookie).send(body);
}

/** Bob completes the job: 3.0h and a $45 part he bought, unless told otherwise. */
async function bobCompletes(
  made: { jobId: string; assignmentId: string; reference: string },
  options: { entries?: object[]; withPart?: boolean } = {},
): Promise<void> {
  const bob = await signInCookie("bob@idelta.com.au");
  const parts =
    options.withPart === false
      ? []
      : [{ name: "Tap cartridge", description: "Ceramic", qty: 1, unitPrice: 4500, receiptAttachmentId: await receiptFor(made.assignmentId, made.jobId) }];
  const res = await complete(bob, made.reference, {
    timeEntries: options.entries ?? threeHours(),
    completionNotes: "Replaced the cartridge.\nTested for leaks.",
    parts,
  });
  expect(res.status).toBe(200);
}

async function invoiceOf(jobId: string) {
  return db.invoice.findFirstOrThrow({ where: { jobId }, include: { lines: { orderBy: { id: "asc" } } } });
}

async function turnGstOn(): Promise<void> {
  await db.platformSettings.updateMany({ data: { gstRegistered: true, businessAbn: "12 345 678 901" } });
}

// ---------------------------------------------------------------------------
// The arithmetic, pure
// ---------------------------------------------------------------------------

const SARAH_RATES = { calloutRate: 25_000, standardRate: 18_000 };
const BOB_RATES = { calloutRate: 20_000, standardRate: 15_000 };

describe("AC3 / AC4 -- the completion arithmetic", () => {
  test("AC3: a 1.0h job has only Tier 1; a 3.0h job has Tier 2 for 2.0h", () => {
    expect(labourTotal(SARAH_RATES, 1, 1)).toMatchObject({ tier1Rate: 25_000, extraHours: 0, tier2Total: 0, total: 25_000 });
    expect(labourTotal(SARAH_RATES, 1, 3)).toMatchObject({ tier1Rate: 25_000, tier2Rate: 18_000, extraHours: 2, tier2Total: 36_000, total: 61_000 });
  });

  test("AC4: weekend 3.0h -- the customer pays $375 + 2.0h @ $270, Bob is paid $300 + 2.0h @ $225", () => {
    const result = completionArithmetic({
      hours: 3,
      customerBase: SARAH_RATES,
      contractorBase: BOB_RATES,
      customerMultiplier: 1.5,
      contractorMultiplier: 1.5,
      contractorPartTotals: [],
    });
    expect(result.customer).toMatchObject({ tier1Rate: 37_500, tier2Rate: 27_000, tier2Total: 54_000, total: 91_500 });
    expect(result.contractor).toMatchObject({ tier1Rate: 30_000, tier2Rate: 22_500, tier2Total: 45_000, total: 75_000 });
  });

  test("AC4: the customer's ladder follows the stamped level; Bob's follows only the visit's date", () => {
    const multipliers = { normal: 1, emergency: 1.5, weekend: 1.5 };
    const tuesday = new Date("2026-10-06T01:00:00.000Z"); // Tue 9:00am Perth
    const saturday = new Date("2026-10-10T01:00:00.000Z"); // Sat 9:00am Perth
    // Emergency on a Tuesday: the customer pays the emergency multiplier, Bob gets 1.0.
    expect(customerMultiplierOf(multipliers, "emergency", PERTH, tuesday)).toEqual({ level: "emergency", multiplier: 1.5 });
    expect(contractorMultiplierOf(PERTH, tuesday)).toBe(1);
    // Emergency stamped ON a Saturday: Bob is paid 1.5.
    expect(customerMultiplierOf(multipliers, "emergency", PERTH, saturday).multiplier).toBe(1.5);
    expect(contractorMultiplierOf(PERTH, saturday)).toBe(1.5);
    // No stamped level: the visit's date decides.
    expect(customerMultiplierOf(multipliers, null, PERTH, saturday)).toEqual({ level: "weekend", multiplier: 1.5 });
    expect(customerMultiplierOf(multipliers, null, PERTH, tuesday)).toEqual({ level: "normal", multiplier: 1 });
  });

  test("AC4: the zone decides the day -- Sunday 11pm UTC is already Monday in Perth", () => {
    expect(contractorMultiplierOf(PERTH, new Date("2026-10-11T17:00:00.000Z"))).toBe(1); // Mon 1:00am Perth
    expect(contractorMultiplierOf(PERTH, new Date("2026-10-10T17:00:00.000Z"))).toBe(1.5); // Sun 1:00am Perth
  });

  test("rounding: each rate times its multiplier to the cent, Tier 2 = extra hours x that rate to the cent", () => {
    // $333.33/h x 1.5 = $499.995 -> 50000 (rounded rate); 1.25 extra hours x 50000 = 62500
    const result = labourTotal({ calloutRate: 10_001, standardRate: 33_333 }, 1.5, 2.25);
    expect(result.tier1Rate).toBe(15_002); // 15001.5 rounds up
    expect(result.tier2Rate).toBe(50_000); // 49999.5 rounds up
    expect(result.tier2Total).toBe(62_500);
  });

  test("materialsReimbursement is the contractor-supplied part totals only", () => {
    const result = completionArithmetic({
      hours: 1,
      customerBase: SARAH_RATES,
      contractorBase: BOB_RATES,
      customerMultiplier: 1,
      contractorMultiplier: 1,
      contractorPartTotals: [4_500, 1_000],
    });
    expect(result.materialsReimbursement).toBe(5_500);
  });

  test("GST is amount x rate / (100 + rate), to the cent: $655.00 -> $59.55", () => {
    expect(gstWithin(65_500, 10, true)).toBe(5_955);
    expect(gstWithin(65_500, 10, false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Complete issues the invoice
// ---------------------------------------------------------------------------

describe("AC1 / AC2 -- Complete issues the invoice and keeps the snapshot", () => {
  test("AC1: 3.0h and a $45 part -> one invoice, INV-2042, lines $250 + $360 + $45, labour $610, materials $45, total $655", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);

    const invoice = await invoiceOf(made.jobId);
    expect(await db.invoice.count()).toBe(1);
    expect(invoice.reference).toBe("INV-2042");
    expect(invoice.lines.map((l) => [l.kind, l.description, Number(l.qty), l.unitPrice, l.lineTotal])).toEqual([
      ["labour", "Call-out + first hour - Plumbing, normal", 1, 25_000, 25_000],
      ["labour", "Additional 2.0h @ $180/h", 2, 18_000, 36_000],
      ["part", "Tap cartridge - Ceramic", 1, 4_500, 4_500],
    ]);
    expect(invoice).toMatchObject({ labourAmount: 61_000, materialsAmount: 4_500, amount: 65_500, status: "sent", isZeroDollar: false });
    expect(invoice.sentAt).not.toBeNull();
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(invoice.dueAt.getTime() - (invoice.sentAt ?? new Date(0)).getTime()).toBe(settings.paymentTermsDays * 24 * 60 * 60 * 1000);

    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(assignment.invoiceId).toBe(invoice.id);
    expect(invoice.assignmentId).toBe(assignment.id);
    expect(assignment.status).toBe("completed");
  });

  test("AC1: a second Complete is refused, so there is never a second invoice", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const bob = await signInCookie("bob@idelta.com.au");
    const again = await complete(bob, made.reference, { timeEntries: threeHours(), completionNotes: "Done." });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await db.invoice.count()).toBe(1);
  });

  test("AC1: the invoice and the freeze are one transaction -- a failure after the invoice rolls Complete back whole", async () => {
    const made = await acceptedJob();
    // A reference clash makes issuing fail AFTER the visit was frozen inside the same transaction.
    await db.$executeRawUnsafe(`ALTER SEQUENCE invoice_reference_seq MAXVALUE 2042`);
    await db.$queryRawUnsafe(`SELECT nextval('invoice_reference_seq')`);
    const bob = await signInCookie("bob@idelta.com.au");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await complete(bob, made.reference, { timeEntries: threeHours(), completionNotes: "Done." });
    await db.$executeRawUnsafe(`ALTER SEQUENCE invoice_reference_seq NO MAXVALUE`);
    expect(res.status).toBe(500);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } })).status).toBe("accepted");
    expect((await db.job.findUniqueOrThrow({ where: { id: made.jobId } })).status).toBe("scheduled");
    expect(await db.invoice.count()).toBe(0);
  });

  test("AC2: the assignment keeps all four rates, the level, the customer's labour, Bob's pay and the parts he is owed", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(a).toMatchObject({
      customerCalloutRate: 25_000,
      customerStandardRate: 18_000,
      contractorCalloutRate: 20_000,
      contractorStandardRate: 15_000,
      serviceLevel: "normal",
      customerTotal: 61_000,
      contractorPay: 50_000,
      materialsReimbursement: 4_500,
    });
  });

  test("AC2: a platform-supplied part shows on the invoice but is not in materialsReimbursement", async () => {
    const made = await acceptedJob();
    const receipt = await receiptFor(made.assignmentId, made.jobId);
    await db.assignmentPart.createMany({
      data: [
        { assignmentId: made.assignmentId, suppliedBy: "contractor", name: "Tap cartridge", qty: 1, unitPrice: 4_500, lineTotal: 4_500, receiptAttachmentId: receipt },
        { assignmentId: made.assignmentId, suppliedBy: "platform", name: "Mixer tap", qty: 1, unitPrice: 12_000, lineTotal: 12_000, quoteAcceptNote: "Sarah agreed by phone" },
      ],
    });
    // Straight to the issuing step: the visit's own Save rewrites the parts list as Bob typed it.
    const issued = await db.$transaction((tx) =>
      issueInvoice(tx, { assignmentId: made.assignmentId, entryStarts: [new Date("2026-10-07T00:00:00.000Z")], billedHours: 3, now: new Date("2026-10-07T04:00:00.000Z") }),
    );
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: issued.id }, include: { lines: true } });
    expect(invoice.materialsAmount).toBe(16_500);
    expect(invoice.amount).toBe(77_500);
    expect(invoice.lines.filter((l) => l.kind === "part").map((l) => l.description).sort()).toEqual(["Mixer tap", "Tap cartridge"]);
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(a.materialsReimbursement).toBe(4_500);
  });

  test("AC3: a 1.0h job has only the Tier 1 line", async () => {
    const made = await acceptedJob();
    await bobCompletes(made, { withPart: false, entries: [{ date: "2026-10-07", start: "08:00", end: "08:30", note: "" }] });
    const invoice = await invoiceOf(made.jobId);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.amount).toBe(25_000);
  });
});

describe("AC4 -- weekend and emergency, through Complete", () => {
  test("AC4: a 3.0h Saturday job bills $375 + 2.0h @ $270 and pays Bob $300 + 2.0h @ $225", async () => {
    const made = await acceptedJob({ date: "2026-10-10", level: "weekend" });
    await bobCompletes(made, { withPart: false, entries: threeHours("2026-10-10") });
    const invoice = await invoiceOf(made.jobId);
    expect(invoice.lines.map((l) => [l.description, l.unitPrice, l.lineTotal])).toEqual([
      ["Call-out + first hour - Plumbing, weekend", 37_500, 37_500],
      ["Additional 2.0h @ $270/h", 27_000, 54_000],
    ]);
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(a).toMatchObject({ customerTotal: 91_500, contractorPay: 75_000, serviceLevel: "weekend" });
  });

  test("AC4: an emergency on a Tuesday -- the customer pays the emergency multiplier, Bob is paid 1.0", async () => {
    const made = await acceptedJob({ date: "2026-10-06", level: "emergency" });
    await bobCompletes(made, { withPart: false, entries: threeHours("2026-10-06") });
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(a).toMatchObject({ customerTotal: 91_500, contractorPay: 50_000, serviceLevel: "emergency" });
  });

  test("AC4: an emergency stamped ON a Saturday pays Bob 1.5", async () => {
    const made = await acceptedJob({ date: "2026-10-10", level: "emergency" });
    await bobCompletes(made, { withPart: false, entries: threeHours("2026-10-10") });
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    expect(a.contractorPay).toBe(75_000);
  });

  test("AC4: Bob's multiplier follows the EARLIEST entry's date, whatever order the entries were typed in", async () => {
    const made = await acceptedJob({ date: "2026-10-09", level: "normal" });
    await bobCompletes(made, {
      withPart: false,
      entries: [
        { date: "2026-10-10", start: "09:00", end: "10:00", note: "" }, // Saturday, typed first
        { date: "2026-10-09", start: "08:00", end: "09:00", note: "" }, // Friday, earliest
      ],
    });
    const a = await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } });
    // Earliest is a Friday: 1.0 for Bob. 1h + 1h = 2.0h billed.
    expect(a.contractorPay).toBe(20_000 + 15_000);
  });

  test("AC4: a job with no stamped level reads weekend off the first entry's date", async () => {
    const made = await acceptedJob({ date: "2026-10-10", level: null });
    await bobCompletes(made, { withPart: false, entries: threeHours("2026-10-10") });
    expect((await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } })).serviceLevel).toBe("weekend");
  });
});

describe("AC5 / AC6 / AC7 -- GST, billed to, the PDF", () => {
  test("AC5: GST off -- gstApplied false, gstAmount 0, the PDF is headed Invoice with a Total only", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const invoice = await invoiceOf(made.jobId);
    expect(invoice).toMatchObject({ gstApplied: false, gstAmount: 0 });
    const text = pdfText((await buildInvoicePdf(db, invoice.id)).content);
    expect(text).toContain("Invoice");
    expect(text).not.toContain("Tax invoice");
    expect(text).not.toContain("Includes GST");
    expect(text).not.toContain("Subtotal");
    expect(text).toContain("Total");
    expect(text).toContain("$655.00");
  });

  test("AC5: GST on -- gstAmount $59.55 on $655, a Tax invoice with Subtotal / Includes GST / Total; flipping the switch later changes nothing", async () => {
    await turnGstOn();
    const made = await acceptedJob();
    await bobCompletes(made);
    const invoice = await invoiceOf(made.jobId);
    expect(invoice).toMatchObject({ gstApplied: true, gstAmount: 5_955 });
    const before = pdfText((await buildInvoicePdf(db, invoice.id)).content);
    expect(before).toContain("Tax invoice");
    expect(before).toContain("Subtotal");
    expect(before).toContain("$595.45");
    expect(before).toContain("Includes GST");
    expect(before).toContain("$59.55");

    await db.platformSettings.updateMany({ data: { gstRegistered: false } });
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after).toMatchObject({ gstApplied: true, gstAmount: 5_955 });
    expect(pdfText((await buildInvoicePdf(db, invoice.id)).content)).toContain("Tax invoice");
  });

  test("AC6: Nina's invoice is billed to Rossi's Cafe, Attn: Nina Rossi, with her address; Sarah's is billed to Sarah Chen; a later change changes nothing", async () => {
    const address = { street: "12 Marine Terrace", suburb: "Fremantle", state: "WA", country: "Australia", postcode: "6160", lat: -32.05, lng: 115.74, placeId: null };
    const nina = await acceptedJob({ customer: { name: "Nina Rossi", email: "nina@idelta.com.au", businessName: "Rossi's Cafe", billingAddress: address } });
    await bobCompletes(nina, { withPart: false });
    const sarah = await acceptedJob();
    await bobCompletes(sarah, { withPart: false });

    const ninas = await invoiceOf(nina.jobId);
    expect(ninas.billedTo).toMatchObject({ name: "Nina Rossi", businessName: "Rossi's Cafe", address: { street: "12 Marine Terrace" } });
    const sarahs = await invoiceOf(sarah.jobId);
    expect(sarahs.billedTo).toMatchObject({ name: "Sarah Chen" });
    expect(sarahs.billedTo).not.toHaveProperty("businessName");

    await db.customer.update({ where: { id: nina.customerId }, data: { name: "Nina R.", businessName: "New Name Pty Ltd" } });
    expect((await invoiceOf(nina.jobId)).billedTo).toMatchObject({ name: "Nina Rossi", businessName: "Rossi's Cafe" });
    const text = pdfText((await buildInvoicePdf(db, ninas.id)).content);
    expect(text).toContain("Rossi's Cafe");
    expect(text).toContain("Attn: Nina Rossi");
    expect(text).toContain("12 Marine Terrace");
    expect(pdfText((await buildInvoicePdf(db, sarahs.id)).content)).not.toContain("Attn:");
  });

  test("AC7: the PDF header is the legal identity -- never the display name alone -- with references, dates in the job's zone, the lines, the pay link, and no bank account", async () => {
    await turnGstOn();
    const made = await acceptedJob();
    await bobCompletes(made);
    const invoice = await invoiceOf(made.jobId);
    await db.invoice.update({ where: { id: invoice.id }, data: { stripePaymentLinkUrl: "https://pay.test/INV-2042", stripePaymentLinkId: "plink_1" } });
    const settings = await db.platformSettings.findFirstOrThrow();

    const pdf = await buildInvoicePdf(db, invoice.id);
    expect(pdf.fileName).toBe("INV-2042.pdf");
    const text = pdfText(pdf.content);
    expect(text).toContain(settings.legalEntityName);
    expect(text).toContain("ABN 12 345 678 901");
    expect(text).toContain("1 Hay Street, Perth WA 6000, Australia");
    expect(text).not.toContain(settings.displayName);
    expect(text).toContain("INV-2042");
    expect(text).toContain(made.reference);
    // Issued today, due paymentTermsDays later -- both in the job's zone ("15 Oct 2026").
    const day = (d: Date) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: PERTH }).format(d);
    expect(text).toContain(day(invoice.sentAt ?? invoice.createdAt));
    expect(text).toContain(day(invoice.dueAt));
    expect(text).toContain("Call-out + first hour - Plumbing, normal");
    expect(text).toContain("Additional 2.0h @ $180/h");
    expect(text).toContain("Tap cartridge - Ceramic");
    expect(text).toContain("Pay online: https://pay.test/INV-2042");
    expect(text).toContain(`Call ${settings.operatorPhone}`);
    expect(text.toLowerCase()).not.toMatch(/bank|bsb|account number/);
  });
});

// ---------------------------------------------------------------------------
// Stripe and the pay-link loop
// ---------------------------------------------------------------------------

describe("AC8 -- one Payment Link", () => {
  test("AC8: the link is for the amount in AUD, limited to one payment, with no payment-method list and the invoice in its metadata", () => {
    const params = payLinkParams({ invoiceId: "inv-uuid", invoiceReference: "INV-2042", jobReference: "JOB-1043", amount: 65_500 });
    expect(params.line_items).toEqual([
      { quantity: 1, price_data: { currency: "aud", unit_amount: 65_500, product_data: { name: "INV-2042 - JOB-1043" } } },
    ]);
    expect(params.restrictions).toEqual({ completed_sessions: { limit: 1 } });
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params.metadata).toEqual({ invoiceId: "inv-uuid", invoiceReference: "INV-2042" });
    expect(params.payment_intent_data).toEqual({ metadata: { invoiceId: "inv-uuid", invoiceReference: "INV-2042" } });
    // Stripe's idempotency key comes from the invoice id alone: the same invoice never makes a second link.
    expect(idempotencyKeyFor("inv-uuid")).toBe(idempotencyKeyFor("inv-uuid"));
    expect(idempotencyKeyFor("inv-uuid")).not.toBe(idempotencyKeyFor("other"));
  });

  test("AC8: after Complete one link is made for the invoice and its URL and id are stored; a second pass makes none", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const stripe = fakeStripe();
    expect(await payLinkPass(db, { provider: stripe })).toBe(1);
    expect(await payLinkPass(db, { provider: stripe })).toBe(0);
    expect(stripe.calls).toEqual([{ invoiceId: (await invoiceOf(made.jobId)).id, invoiceReference: "INV-2042", jobReference: made.reference, amount: 65_500 }]);
    const invoice = await invoiceOf(made.jobId);
    expect(invoice).toMatchObject({ stripePaymentLinkUrl: "https://pay.test/INV-2042", stripePaymentLinkId: "plink_INV-2042" });
  });

  test("AC8: Complete's own first try makes the link straight after the commit, without the response waiting", async () => {
    const stripe = fakeStripe();
    stripe.delayMs = 150;
    const made = await acceptedJob();
    setPayLinkProvider(stripe);
    await bobCompletes(made);
    // The response came back before Stripe answered ...
    expect((await invoiceOf(made.jobId)).stripePaymentLinkUrl).toBeNull();
    // ... and the link lands moments later.
    await vi.waitFor(async () => {
      expect((await invoiceOf(made.jobId)).stripePaymentLinkUrl).toBe("https://pay.test/INV-2042");
    });
    expect(stripe.calls).toHaveLength(1);
  });
});

describe("AC9 -- the email and the text", () => {
  test("AC9: once the link exists the invoice email and SMS are queued once each to Sarah, the email carries INV-2042.pdf, and the site contact gets nothing", async () => {
    const made = await acceptedJob({ siteContact: { name: "Lena Park", phone: "0400 111 222", email: "lena@idelta.com.au" } });
    await bobCompletes(made);
    expect(await db.notification.count({ where: { type: "invoice" } })).toBe(0); // no link yet, nothing asked

    await payLinkPass(db, { provider: fakeStripe() });
    await payLinkPass(db, { provider: fakeStripe() });
    const rows = await db.notification.findMany({ where: { type: "invoice" }, orderBy: { channel: "asc" } });
    expect(rows.map((r) => [r.channel, r.recipientType])).toEqual([["email", "customer"], ["sms", "customer"]]);
    const invoice = await invoiceOf(made.jobId);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([`invoice:invoice:${invoice.id}:email`, `invoice:invoice:${invoice.id}:sms`]);
    expect(rows.every((r) => r.relatedType === "invoice" && r.relatedId === invoice.id && r.jobId === made.jobId)).toBe(true);

    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    const mail = email.sent[0];
    const sarah = await db.customer.findUniqueOrThrow({ where: { id: made.customerId } });
    expect(mail?.to).toBe(sarah.email);
    expect(mail?.message.subject).toMatch(/^Invoice INV-2042 for your plumbing job - \$655 due \d{1,2} \w{3} \d{4}$/);
    expect(mail?.message.text).toContain("Hi Sarah,");
    expect(mail?.message.text).toContain("Bob has finished your plumbing job, " + made.reference);
    expect(mail?.message.text).toContain("Replaced the cartridge.\nTested for leaks.");
    expect(mail?.message.text).toContain("Total: $655");
    expect(mail?.message.text).not.toContain("includes GST");
    expect(mail?.message.text).toContain("Pay now: https://pay.test/INV-2042");
    expect(mail?.message.text).toContain("Your invoice INV-2042 is attached as a PDF.");
    expect(mail?.message.html).toContain('href="https://pay.test/INV-2042"');
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments?.[0]).toMatchObject({ fileName: "INV-2042.pdf", contentType: "application/pdf" });
    expect(pdfText(mail?.attachments?.[0]?.content ?? new Uint8Array())).toContain("INV-2042");
    expect(sms.sent[0]?.to).toBe(sarah.phone);
    expect(sms.sent[0]?.message.text).toMatch(/^Perth Trades & Services: invoice INV-2042 for JOB-\d+ - \$655, due \d{1,2} \w{3} \d{4}\. Pay now: https:\/\/pay\.test\/INV-2042$/);
    expect(sms.sent[0]?.attachments).toBeUndefined();
    // Never the site contact.
    expect([...email.sent, ...sms.sent].some((m) => m.to === "lena@idelta.com.au" || m.to === "0400 111 222")).toBe(false);
  });

  test("AC9: a GST invoice says so in the email", async () => {
    await turnGstOn();
    const made = await acceptedJob();
    await bobCompletes(made);
    await payLinkPass(db, { provider: fakeStripe() });
    await drainOnce(db);
    expect(email.sent[0]?.message.text).toContain("Total: $655 (includes GST of $59.55)");
  });

  test("AC9: the console adapter logs the attachment's name and size; Mailjet sends it as Attachments, base64", async () => {
    const attachments = [{ fileName: "INV-2042.pdf", contentType: "application/pdf", content: new Uint8Array([37, 80, 68, 70]) }];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await consoleEmail.send({ to: "sarah@idelta.com.au", fromName: "x", message: { subject: "s", text: "t" }, attachments });
    expect(String(log.mock.calls[0]?.[0])).toContain("attachment: INV-2042.pdf (4 bytes)");

    process.env["MAILJET_API_KEY"] = "k";
    process.env["MAILJET_API_SECRET"] = "s";
    process.env["MAILJET_FROM_EMAIL"] = "from@idelta.com.au";
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "uuid-1" }] }] }), { status: 200 })),
      );
    await mailjetEmail.send({ to: "sarah@idelta.com.au", fromName: "x", message: { subject: "s", text: "t" }, attachments });
    const body = JSON.parse((fetched.mock.calls[0]?.[1] as { body: string }).body) as { Messages: { Attachments?: unknown[] }[] };
    expect(body.Messages[0]?.Attachments).toEqual([{ ContentType: "application/pdf", Filename: "INV-2042.pdf", Base64Content: Buffer.from("%PDF").toString("base64") }]);
    await mailjetEmail.send({ to: "sarah@idelta.com.au", fromName: "x", message: { subject: "s", text: "t" } });
    const plain = JSON.parse((fetched.mock.calls[1]?.[1] as { body: string }).body) as { Messages: object[] };
    expect(plain.Messages[0]).not.toHaveProperty("Attachments");
  });

  test("AC9: a PDF that cannot be built fails that attempt like any send error; nothing is sent without its attachment", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    await payLinkPass(db, { provider: fakeStripe() });
    const row = await db.notification.findFirstOrThrow({ where: { type: "invoice", channel: "email" } });
    // The row's context points at an invoice that is not there: the build at send time cannot read it.
    await db.notification.update({ where: { id: row.id }, data: { context: { ...(row.context as object), invoiceId: "no-such-invoice" } } });
    await drainOnce(db);
    const after = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("queued"); // attempts remain
    expect(after.attempts).toBe(1);
    expect(after.error ?? "").toContain("attachment failed");
    expect(email.sent).toHaveLength(0);
  });
});

describe("AC10 / AC11 -- Stripe unreachable, and no key", () => {
  test("AC10: Stripe down -- Complete still succeeds, the invoice issues, nothing goes, each pass asks again, and once Stripe answers the messages go once", async () => {
    const made = await acceptedJob();
    const stripe = fakeStripe();
    stripe.failWith = "stripe unreachable";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await bobCompletes(made);

    for (let pass = 1; pass <= 4; pass += 1) {
      expect(await payLinkPass(db, { provider: stripe })).toBe(0);
      expect(stripe.calls).toHaveLength(pass); // no attempt limit: every pass asks again
    }
    const waiting = await invoiceOf(made.jobId);
    expect(waiting).toMatchObject({ status: "sent", stripePaymentLinkUrl: null });
    expect(await db.notification.count({ where: { type: "invoice" } })).toBe(0);

    stripe.failWith = null;
    expect(await payLinkPass(db, { provider: stripe })).toBe(1);
    expect(await payLinkPass(db, { provider: stripe })).toBe(0);
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    expect((await invoiceOf(made.jobId)).stripePaymentLinkUrl).toBe("https://pay.test/INV-2042");
  });

  test("AC10: two loops at once never make two links", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const stripe = fakeStripe();
    stripe.delayMs = 200;
    const [a, b] = await Promise.all([payLinkPass(db, { provider: stripe }), payLinkPass(db, { provider: stripe })]);
    expect(a + b).toBe(1);
    expect(stripe.calls).toHaveLength(1);
    expect(await db.notification.count({ where: { type: "invoice", channel: "email" } })).toBe(1);
  });

  test("AC10: a zero-dollar or void or paid invoice is never sent to Stripe", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const invoice = await invoiceOf(made.jobId);
    for (const data of [{ isZeroDollar: true }, { isZeroDollar: false, status: "void" as const }, { status: "paid" as const }]) {
      await db.invoice.update({ where: { id: invoice.id }, data });
      const stripe = fakeStripe();
      expect(await payLinkPass(db, { provider: stripe })).toBe(0);
      expect(stripe.calls).toHaveLength(0);
    }
  });

  test("AC11: no STRIPE_SECRET_KEY -- one warning, the loop boots, invoices issue and wait", async () => {
    setPayLinkProvider(undefined); // read the real environment: the test setup removed the key
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loop = startPayLinkLoop({ client: db, intervalMs: 3_600_000 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("STRIPE_SECRET_KEY");
    await loop.stop();
    warnIfStripeMissing();
    expect(warn).toHaveBeenCalledTimes(2); // the helper itself is the single place that warns

    const made = await acceptedJob();
    await bobCompletes(made);
    expect(await payLinkPass(db)).toBe(0);
    expect(await invoiceOf(made.jobId)).toMatchObject({ status: "sent", stripePaymentLinkUrl: null });
    expect(await db.notification.count({ where: { type: "invoice" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What Bob and Mike see
// ---------------------------------------------------------------------------

describe("AC12 -- Bob's payment", () => {
  test("AC12: after Complete Bob's read carries the customer's total and waits for the link; once the link exists and the messages have gone it says so; never his own pay; Dave sees nothing of it", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const bob = await signInCookie("bob@idelta.com.au");
    const waiting = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
    expect((waiting.body as ContractorJobView).payment).toEqual({ amount: 65_500, payLinkUrl: null, messages: "sending" });

    await payLinkPass(db, { provider: fakeStripe() });
    const queued = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
    expect((queued.body as ContractorJobView).payment).toEqual({ amount: 65_500, payLinkUrl: "https://pay.test/INV-2042", messages: "sending" });

    await drainOnce(db);
    const sent = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
    expect((sent.body as ContractorJobView).payment).toEqual({ amount: 65_500, payLinkUrl: "https://pay.test/INV-2042", messages: "sent" });
    // The customer's total is his to quote; his own pay never is.
    const json = JSON.stringify(sent.body);
    expect(json).not.toContain("50000");
    expect(json).not.toContain("contractorPay");

    const dave = await signInCookie("dave@idelta.com.au");
    expect((await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", dave)).status).toBe(404);
  });

  test("AC12: a message that failed shows as failed to Bob until one has gone", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    await payLinkPass(db, { provider: fakeStripe() });
    await db.notification.updateMany({ where: { type: "invoice", channel: "email" }, data: { status: "failed", error: "mailbox full" } });
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
    expect((res.body as ContractorJobView).payment).toMatchObject({ amount: 65_500, messages: "failed" });
  });

  test("AC12: payment is null before Complete, and for a zero-dollar or paid or void invoice", async () => {
    const made = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const before = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
    expect((before.body as ContractorJobView).payment).toBeNull();
    await bobCompletes(made);
    const invoice = await invoiceOf(made.jobId);
    for (const data of [{ isZeroDollar: true }, { isZeroDollar: false, status: "paid" as const }, { status: "void" as const }]) {
      await db.invoice.update({ where: { id: invoice.id }, data });
      const res = await request(app).get(`/api/contractor/jobs/${made.reference}`).set("Cookie", bob);
      expect((res.body as ContractorJobView).payment).toBeNull();
    }
  });
});

interface OpsDetail {
  invoice: InvoiceView | null;
  messages: { what: string; channel: string; to: string }[];
}

async function opsDetail(cookie: string, reference: string): Promise<OpsDetail> {
  const res = await request(app).get(`/api/jobs/${reference}`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as OpsDetail;
}

describe("AC13 -- Mike's Invoice card", () => {
  test("AC13: no invoice before Complete; then reference, status, billed to, issued, due, total and the lines; waiting while there is no link", async () => {
    const made = await acceptedJob({ customer: { name: "Nina Rossi", email: "nina@idelta.com.au", businessName: "Rossi's Cafe" } });
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await opsDetail(mike, made.reference)).invoice).toBeNull();

    await bobCompletes(made);
    const waiting = (await opsDetail(mike, made.reference)).invoice;
    expect(waiting).toMatchObject({
      reference: "INV-2042",
      status: "sent",
      waitingForPayLink: true,
      payLinkUrl: null,
      canResend: false,
      billedTo: { name: "Nina Rossi", businessName: "Rossi's Cafe", address: null },
      amount: 65_500,
      gstApplied: false,
      gstAmount: 0,
    });
    expect(waiting?.lines.map((l) => [l.description, l.lineTotal])).toEqual([
      ["Call-out + first hour - Plumbing, normal", 25_000],
      ["Additional 2.0h @ $180/h", 36_000],
      ["Tap cartridge - Ceramic", 4_500],
    ]);
    expect(waiting?.issuedLabel).toMatch(/^\d{1,2} \w{3} \d{4}$/);
    expect(waiting?.dueLabel).toMatch(/^\d{1,2} \w{3} \d{4}$/);

    await payLinkPass(db, { provider: fakeStripe() });
    expect((await opsDetail(mike, made.reference)).invoice).toMatchObject({ waitingForPayLink: false, payLinkUrl: "https://pay.test/INV-2042", canResend: true });
  });

  test("AC13: GST comes from the invoice's own stamp, not the live switch", async () => {
    await turnGstOn();
    const made = await acceptedJob();
    await bobCompletes(made);
    await db.platformSettings.updateMany({ data: { gstRegistered: false } });
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await opsDetail(mike, made.reference)).invoice).toMatchObject({ gstApplied: true, gstAmount: 5_955 });
  });
});

describe("AC14 -- Resend invoice", () => {
  async function linkedJob(): Promise<{ reference: string; jobId: string; customerId: string }> {
    const made = await acceptedJob();
    await bobCompletes(made);
    await payLinkPass(db, { provider: fakeStripe() });
    await drainOnce(db);
    email.reset();
    sms.reset();
    return made;
  }

  test("AC14: Resend sends the email and SMS again, to the customer's details as they are now; each press is a new pair in the Messages card", async () => {
    const made = await linkedJob();
    const mike = await signInCookie("mike@idelta.com.au");
    await db.customer.update({ where: { id: made.customerId }, data: { email: "sarah.fixed@idelta.com.au" } });

    const first = await request(app).post(`/api/jobs/${made.reference}/invoice/resend`).set("Cookie", mike);
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await request(app).post(`/api/jobs/${made.reference}/invoice/resend`).set("Cookie", mike);
    expect(second.status).toBe(200);
    await drainOnce(db);
    expect(email.sent.map((m) => m.to)).toEqual(["sarah.fixed@idelta.com.au", "sarah.fixed@idelta.com.au"]);
    expect(sms.sent).toHaveLength(2);
    expect(email.sent[0]?.attachments?.[0]?.fileName).toBe("INV-2042.pdf");

    const messages = (await opsDetail(mike, made.reference)).messages.filter((m) => m.what === "Invoice");
    expect(messages).toHaveLength(6); // the original pair and two resent pairs
  });

  test("AC14: refused while waiting for the pay link, and when the invoice is paid, void or zero-dollar", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const mike = await signInCookie("mike@idelta.com.au");
    const refused = async (): Promise<number> => (await request(app).post(`/api/jobs/${made.reference}/invoice/resend`).set("Cookie", mike)).status;
    expect(await refused()).toBe(409); // waiting
    await payLinkPass(db, { provider: fakeStripe() });
    const invoice = await invoiceOf(made.jobId);
    for (const data of [{ status: "paid" as const }, { status: "void" as const }, { status: "sent" as const, isZeroDollar: true }]) {
      await db.invoice.update({ where: { id: invoice.id }, data });
      expect(await refused()).toBe(409);
    }
    expect(await db.notification.count({ where: { type: "invoice", idempotencyKey: { contains: "resend" } } })).toBe(0);
    expect((await request(app).post("/api/jobs/JOB-0000/invoice/resend").set("Cookie", mike)).status).toBe(404);
  });

  test("AC14: a contractor cannot call it", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const bob = await signInCookie("bob@idelta.com.au");
    expect((await request(app).post(`/api/jobs/${made.reference}/invoice/resend`).set("Cookie", bob)).status).toBe(403);
    expect((await request(app).post(`/api/jobs/${made.reference}/invoice/resend`)).status).toBe(401);
  });
});

describe("the browser tests' pay-link hook", () => {
  test("it gives one waiting invoice a fake pay link and sends its messages once; production does not have it", async () => {
    const made = await acceptedJob();
    await bobCompletes(made);
    const hooked = express();
    hooked.use(express.json());
    mountTestDataRoutes(hooked, db);

    const first = await request(hooked).post(`/api/test-data/jobs/${made.reference}/pay-link`);
    expect(first.body).toEqual({ made: 1, linked: true });
    expect((await invoiceOf(made.jobId)).stripePaymentLinkUrl).toBe("https://pay.test/INV-2042");
    expect(await db.notification.count({ where: { type: "invoice" } })).toBe(2);
    expect((await request(hooked).post(`/api/test-data/jobs/${made.reference}/pay-link`)).body).toEqual({ made: 0, linked: true });
    expect((await request(hooked).post("/api/test-data/jobs/JOB-0000/pay-link")).status).toBe(404);

    vi.stubEnv("NODE_ENV", "production");
    const production = express();
    mountTestDataRoutes(production, db);
    vi.unstubAllEnvs();
    expect((await request(production).post(`/api/test-data/jobs/${made.reference}/pay-link`)).status).toBe(404);
  });
});
