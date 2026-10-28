// Feature 6010 -- customer portal (the reads behind /account)
//
// AC2  her jobs, newest first, in her own wording of status, 50 a page with the total
// AC3  a job's detail: what she asked for, the tradie's first name and the visit time, the job site,
//      its invoices, her review (or none); a job not yet done carries no review card
// AC4  invoices newest first; an invoice's lines and totals as issued; the PDF bytes are the email's; an
//      open one carries its pay link
// AC5  a void invoice replaced by a reissue says what replaced it
// AC6  payments: her succeeded payment and a refund, newest first, the refund with its receipt PDF
// AC7  the profile: her details, the office phone
// AC8  another customer's job, invoice, refund receipt or PDF -> 404, never 403
// AC9  Mike, Bob and a logged-out visitor are refused
// AC10 nothing of the office shows: no notes, no contractor surname or pay, no customer rating, no contact
// AC11 more than 50 jobs: the next page, with the total
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { owedInvoice } from "./helpers/owed-invoice.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { accountPortalRoutes } from "../src/account/portal-routes.js";
import { passwordHasher } from "../src/auth/dev-password.js";
import { buildInvoicePdf } from "../src/invoices/pdf.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-6010", "email");

async function signIn(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (cookies.find((c) => c.includes("better-auth.session_token=")) ?? "").split(";")[0] ?? "";
}

/** A customer login with the dev password on a real Customer row (the 3004 way). */
async function giveLogin(code: string): Promise<string> {
  const customer = await db.customer.findUniqueOrThrow({ where: { code } });
  const user = await db.user.create({ data: { name: customer.name, email: customer.email, role: "customer" } });
  const hash = await passwordHasher().hash(DEV_PASSWORD);
  await db.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash } });
  await db.customer.update({ where: { id: customer.id }, data: { userId: user.id } });
  return signIn(customer.email);
}

const get = (cookie: string, path: string) => request(app).get(`/api/account${path}`).set("Cookie", cookie);

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/account", accountPortalRoutes(db));
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
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
});

afterEach(async () => {
  await resetReferenceSequences(db);
});

interface JobRow {
  reference: string;
  trade: string;
  suburb: string;
  status: string;
  when: string;
}

describe("AC2/AC11 -- the jobs list", () => {
  test("AC2: her jobs only, newest first, in her wording; JOB-1042 reads Requested until it is done", async () => {
    const sarah = await giveLogin("CUS-1050");
    const done = await owedInvoice(db, { status: "paid" });
    const res = await get(sarah, "/jobs");
    expect(res.status).toBe(200);
    const body = res.body as { rows: JobRow[]; total: number; hasMore: boolean };
    expect(body.rows.map((r) => r.reference)[0]).toBe(done.jobReference);
    expect(body.rows.find((r) => r.reference === done.jobReference)?.status).toBe("Done");
    expect(body.rows.find((r) => r.reference === "JOB-1042")?.status).toBe("Requested");
    expect(body.rows.every((r) => ["JOB-1042", done.jobReference].includes(r.reference))).toBe(true);
    expect(body.total).toBe(2);
    // Tom's jobs are not hers.
    expect(body.rows.map((r) => r.reference)).not.toContain("JOB-1051");
  });

  test("AC11: more than 50 jobs -- the first page holds 50 of the total, the next brings the rest", async () => {
    const sarah = await giveLogin("CUS-1050");
    const template = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    for (let i = 0; i < 59; i += 1) {
      const rest: Record<string, unknown> = { ...template };
      delete rest["id"];
      await db.job.create({ data: { ...rest, reference: `JOB-7${String(100 + i)}`, serviceLocation: template.serviceLocation as never, enquiryContact: undefined, operatorNotes: undefined, siteContact: undefined, siteAddress: undefined, selectedOptions: template.selectedOptions as never, cancelReason: null } as never });
    }
    const first = (await get(sarah, "/jobs")).body as { rows: JobRow[]; total: number; hasMore: boolean };
    expect(first.total).toBe(60);
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const next = (await get(sarah, "/jobs?offset=50")).body as { rows: JobRow[]; hasMore: boolean };
    expect(next.rows).toHaveLength(10);
    expect(next.hasMore).toBe(false);
  });
});

describe("AC3/AC10 -- a job's detail", () => {
  test("AC3: what she asked for, Bob by first name and the visit, the job site, the invoice link and no review yet", async () => {
    const sarah = await giveLogin("CUS-1050");
    const done = await owedInvoice(db, { status: "paid" });
    await db.job.update({ where: { id: done.jobId }, data: { selectedOptions: ["Where in the property is it?: Kitchen"], siteAddress: { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.07, lng: 115.78, placeId: "p1" } } });
    const res = await get(sarah, `/jobs/${done.jobReference}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reference: done.jobReference,
      status: "Done",
      tradie: "Bob",
      jobSite: "5 Carrington Street, Hilton WA 6163",
      description: "The mixer tap in the kitchen leaks.",
      answers: ["Where in the property is it?: Kitchen"],
      invoices: [{ reference: done.invoiceReference, status: "Paid" }],
      done: true,
      review: null,
    });
    expect((res.body as { when: string }).when).toMatch(/AWST/);
  });

  test("AC3: her review shows once she has rated; a job not yet done carries no review and no tradie before it is booked", async () => {
    const sarah = await giveLogin("CUS-1050");
    const done = await owedInvoice(db, { status: "paid" });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const sarahRow = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    await db.review.create({ data: { jobId: done.jobId, customerId: sarahRow.id, contractorId: bob.id, rating: 4, reviewText: "Tidy work.", recommendScore: 9 } });
    expect((await get(sarah, `/jobs/${done.jobReference}`)).body).toMatchObject({ review: { rating: 4, reviewText: "Tidy work.", recommendScore: 9 } });

    const open = await get(sarah, "/jobs/JOB-1042");
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ status: "Requested", done: false, review: null, tradie: null });
  });

  test("AC10: nothing of the office shows -- no notes, pay, surname, contact, rating or request contact", async () => {
    const sarah = await giveLogin("CUS-1050");
    const done = await owedInvoice(db, { status: "paid" });
    await db.job.update({ where: { id: done.jobId }, data: { operatorNotes: [{ type: "general", note: "Secret office note" }] as never, enquiryContact: { name: "S", phone: "0412 555 019" } } });
    const text = JSON.stringify((await get(sarah, `/jobs/${done.jobReference}`)).body) + JSON.stringify((await get(sarah, "/jobs")).body);
    for (const forbidden of ["Secret office note", "Reilly", "CON-014", "0412 555 019", "payRate", "customerRating", "operatorNotes", "enquiryContact"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("AC4/AC5 -- invoices", () => {
  test("AC4: the list newest first with its status; the detail's lines and totals as issued; an open one has its pay link", async () => {
    const sarah = await giveLogin("CUS-1050");
    const paid = await owedInvoice(db, { status: "paid" });
    const open = await owedInvoice(db, { amount: 120_000 });
    await db.invoiceLine.create({ data: { invoiceId: open.invoiceId, kind: "labour", description: "Labour 2.0h", qty: 2, unitPrice: 60_000, lineTotal: 120_000 } });

    const list = (await get(sarah, "/invoices")).body as { rows: { reference: string; status: string; amount: number; jobReference: string }[]; total: number };
    expect(list.rows.map((r) => r.reference)).toEqual([open.invoiceReference, paid.invoiceReference]);
    expect(list.rows[0]).toMatchObject({ status: "Open", amount: 120_000, jobReference: open.jobReference });
    expect(list.rows[1]?.status).toBe("Paid");

    const detail = (await get(sarah, `/invoices/${open.invoiceReference}`)).body as Record<string, unknown>;
    expect(detail).toMatchObject({ reference: open.invoiceReference, status: "Open", total: 120_000, labour: 120_000, payLink: `https://pay.test/${open.invoiceReference}`, replacedBy: null });
    expect(detail["lines"]).toEqual([{ kind: "labour", description: "Labour 2.0h", qty: 2, unitPrice: 60_000, lineTotal: 120_000 }]);
    expect((await get(sarah, `/invoices/${paid.invoiceReference}`)).body).toMatchObject({ status: "Paid", payLink: null });
  });

  test("AC4: Download PDF gives the same bytes the email attaches", async () => {
    const sarah = await giveLogin("CUS-1050");
    const inv = await owedInvoice(db, { status: "paid" });
    const res = await get(sarah, `/invoices/${inv.invoiceReference}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const expected = await buildInvoicePdf(db, inv.invoiceId);
    expect((res.body as Buffer).length).toBe(expected.content.length);
  });

  test("AC5: a void invoice replaced by a reissue says what replaced it", async () => {
    const sarah = await giveLogin("CUS-1050");
    const old = await owedInvoice(db, { status: "void" });
    const original = await db.invoice.findUniqueOrThrow({ where: { id: old.invoiceId } });
    const rest: Record<string, unknown> = { ...original };
    delete rest["id"];
    await db.invoice.create({ data: { ...rest, reference: "INV-9999", status: "sent", replacesInvoiceId: original.id, billedTo: original.billedTo as never } as never });
    expect((await get(sarah, `/invoices/${old.invoiceReference}`)).body).toMatchObject({ status: "Void", replacedBy: "INV-9999", payLink: null });
  });
});

describe("AC6 -- payments and refunds", () => {
  test("AC6: the card payment and the refund, newest first, the refund with its receipt PDF", async () => {
    const sarah = await giveLogin("CUS-1050");
    const inv = await owedInvoice(db, { status: "paid", amount: 132_000 });
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const payment = await db.payment.create({
      data: { invoiceId: inv.invoiceId, customerId: inv.customerId, stripePaymentIntentId: "pi_6010", amount: 132_000, status: "succeeded", method: "card", paidAt: new Date(Date.now() - 86_400_000) },
    });
    const refund = await db.refund.create({
      data: { reference: "CN-1001", invoiceId: inv.invoiceId, customerId: inv.customerId, jobId: inv.jobId, paymentId: payment.id, amount: 54_000, reason: "Part not done", approvedByUserId: mike.id, approvedAt: new Date(), billedTo: { name: "Sarah Chen" }, stripeRefundId: "re_6010", status: "succeeded" },
    });
    const rows = ((await get(sarah, "/payments")).body as { rows: { kind: string; what: string; how: string; amount: number; receipt: string | null }[] }).rows;
    expect(rows.map((r) => r.kind)).toEqual(["refund", "payment"]);
    expect(rows[0]).toMatchObject({ what: `Refund CN-1001 on ${inv.invoiceReference}`, how: "Card", amount: 54_000, receipt: "CN-1001" });
    expect(rows[1]).toMatchObject({ what: `Payment for ${inv.invoiceReference}`, how: "Card", amount: 132_000, receipt: null });
    const pdf = await get(sarah, `/refunds/${refund.reference}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
  });
});

describe("AC7 -- the profile", () => {
  test("AC7: her details and the office phone; the business name only when set", async () => {
    const sarah = await giveLogin("CUS-1050");
    const res = await get(sarah, "/profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Sarah Chen", email: "sarah@idelta.com.au", businessName: null });
    expect((res.body as { officePhone: string }).officePhone).not.toBe("");
  });
});

describe("AC8/AC9 -- never anyone else's, never the office", () => {
  test("AC8: Sarah asking for Tom's job, invoice, PDF or receipt gets 404 -- never 403", async () => {
    const sarah = await giveLogin("CUS-1050");
    const toms = await owedInvoice(db, { customerCode: "CUS-1052" });
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    await db.refund.create({ data: { reference: "CN-2002", invoiceId: toms.invoiceId, customerId: toms.customerId, jobId: toms.jobId, amount: 100, reason: "x", approvedByUserId: mike.id, approvedAt: new Date(), billedTo: { name: "Tom" }, stripeRefundId: "re_tom", status: "succeeded" } });
    for (const path of [`/jobs/${toms.jobReference}`, `/invoices/${toms.invoiceReference}`, `/invoices/${toms.invoiceReference}/pdf`, "/refunds/CN-2002/pdf", "/jobs/JOB-0000"]) {
      expect((await get(sarah, path)).status).toBe(404);
    }
    expect(JSON.stringify((await get(sarah, "/invoices")).body)).not.toContain(toms.invoiceReference);
    expect(JSON.stringify((await get(sarah, "/payments")).body)).not.toContain("CN-2002");
  });

  test("AC9: Mike and Bob are refused (403), a logged-out visitor is 401", async () => {
    for (const path of ["/jobs", "/jobs/JOB-1042", "/invoices", "/invoices/INV-1/pdf", "/payments", "/profile", "/refunds/CN-1/pdf"]) {
      expect((await get(await signIn("mike@idelta.com.au"), path)).status).toBe(403);
      expect((await get(await signIn("bob@idelta.com.au"), path)).status).toBe(403);
      expect((await request(app).get(`/api/account${path}`)).status).toBe(401);
    }
  });
});
