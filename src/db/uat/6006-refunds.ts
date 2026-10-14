// UAT data for feature 6006, Refunds.
//
// Three of Bob's Plumbing jobs, completed and invoiced the way Complete does it (the same issue
// step), each invoice PAID by a REAL Stripe sandbox payment (a PaymentIntent confirmed with Stripe's
// test card), so Mike's refund on it is a real sandbox refund:
//   1. Sarah's leaking-tap job: $610, no GST, paid in full, no refunds yet (AC1 to AC5, AC11).
//   2. Margaret's job: $610 WITH GST, paid, plus a second stray $150 payment on the same invoice
//      (paid twice) (AC6, AC9).
//   3. Sarah's second job: $610, paid, with three refunds already on it -- $200 refunded, $100
//      pending, $50 failed -- so the Refunds list shows all three statuses (AC10). Those three are
//      written straight in (no Stripe call, nothing sent), made by Mike.
// The payments are written straight in too (no receipt, no office notice), so nothing is sent when
// these are made. Only cast people are used: Sarah, Margaret, Bob and Mike. Needs STRIPE_SECRET_KEY
// (the sandbox key) in the backend .env. Nothing changes a cast record, so there is no restoreCast.
//
// topUp: a job whose refunds the owner has used up (Sarah's first, Margaret's) is remade fresh; the
// others stay as they are.
import Stripe from "stripe";
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, zonedDateTimeToUtc } from "../../time/index.js";
import { issueInvoice } from "../../invoices/issue.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const SARAHS_SITE = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const APPLECROSS = { street: "8 Ardross Street", suburb: "Applecross", state: "WA", country: "AU", postcode: "6153", lat: -32.0178, lng: 115.8394, placeId: null };

const FIRST = "UAT 6006: Sarah's tap, ready to refund.";
const MARGARET = "UAT 6006: Margaret's job, paid twice.";
const LIST = "UAT 6006: Sarah's second tap, refunds already made.";

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

function lastWeekday(now: Date): string {
  for (let back = 1; back < 14; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (!isWeekend(ZONE, day)) return ymdIn(day);
  }
  throw new Error("no weekday in the last fortnight");
}

function stripeClient(): Stripe {
  const key = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT payments need the Stripe sandbox");
  return new Stripe(key, { timeout: 20_000, maxNetworkRetries: 1 });
}

/** A real sandbox payment, paid with Stripe's test card. Returns the payment intent id. */
async function sandboxPayment(stripe: Stripe, amount: number, invoiceId: string, invoiceReference: string): Promise<string> {
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "aud",
    payment_method: "pm_card_visa",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { invoiceId, invoiceReference },
  });
  if (intent.status !== "succeeded") throw new Error(`Stripe's sandbox did not take the test payment (${intent.status})`);
  return intent.id;
}

async function makeJob(
  client: PrismaClient,
  stripe: Stripe,
  customerCode: string,
  description: string,
  site: Omit<typeof SARAHS_SITE, "placeId"> & { placeId: string | null },
  options: { gst: boolean; strayAmount?: number },
): Promise<{ jobReference: string; invoiceId: string; invoiceReference: string }> {
  const customer = await client.customer.findUniqueOrThrow({ where: { code: customerCode } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const slot = zonedDateTimeToUtc(ZONE, lastWeekday(now), 8, 0);
  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: customer.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: site.postcode,
      serviceLocation: { suburb: site.suburb, state: site.state, country: site.country, lat: site.lat, lng: site.lng, placeId: site.placeId },
      siteAddress: site,
      serviceLevel: "normal",
      timezone: ZONE,
      description,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: "scheduled",
    },
  });
  const assignment = await client.assignment.create({
    data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
  });
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment.id, startedAt: slot, endedAt: new Date(slot.getTime() + 3 * 60 * 60_000), note: null },
  });
  const invoice = await client.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { completionNotes: "Replaced the washer and re-sealed the base.\nTested for leaks -- all dry.", billedHours: 3, completedAt: now, status: "completed" },
    });
    await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
    return issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [slot], billedHours: 3, now });
  });
  const row = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  if (options.gst) {
    await client.invoice.update({ where: { id: row.id }, data: { gstApplied: true, gstAmount: Math.round(row.amount / 11) } });
  }
  // Paid in full by a real sandbox payment; written straight in, so no receipt or notice is sent.
  const paidAt = new Date(now.getTime() - 60 * 60_000);
  const intent = await sandboxPayment(stripe, row.amount, row.id, row.reference);
  await client.payment.create({
    data: { invoiceId: row.id, customerId: customer.id, stripePaymentIntentId: intent, amount: row.amount, status: "succeeded", method: "card", paidAt },
  });
  if (options.strayAmount !== undefined) {
    const stray = await sandboxPayment(stripe, options.strayAmount, row.id, row.reference);
    await client.payment.create({
      data: { invoiceId: row.id, customerId: customer.id, stripePaymentIntentId: stray, amount: options.strayAmount, status: "succeeded", method: "card", paidAt },
    });
  }
  await client.invoice.update({ where: { id: row.id }, data: { status: "paid", paidAt } });
  return { jobReference: job.reference, invoiceId: row.id, invoiceReference: row.reference };
}

async function firstJob(client: PrismaClient, stripe: Stripe): Promise<string> {
  const made = await makeJob(client, stripe, "CUS-1050", FIRST, SARAHS_SITE, { gst: false });
  return `${made.jobReference} / ${made.invoiceReference} - Sarah's leaking-tap job, completed by Bob: $610, no GST, paid by card through the Stripe sandbox, no refunds yet`;
}

async function margaretsJob(client: PrismaClient, stripe: Stripe): Promise<string> {
  const made = await makeJob(client, stripe, "CUS-1053", MARGARET, APPLECROSS, { gst: true, strayAmount: 15_000 });
  return `${made.jobReference} / ${made.invoiceReference} - Margaret's job, completed by Bob: $610 including GST, paid, plus a second stray $150 payment on the same invoice`;
}

async function listJob(client: PrismaClient, stripe: Stripe): Promise<string> {
  const made = await makeJob(client, stripe, "CUS-1050", LIST, SARAHS_SITE, { gst: false });
  const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId }, select: { customerId: true, jobId: true, payments: { select: { id: true } } } });
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const rows: { amount: number; status: "succeeded" | "pending" | "failed"; reason: string; hoursAgo: number }[] = [
    { amount: 20_000, status: "succeeded", reason: "UAT 6006: part of the job was not done", hoursAgo: 3 },
    { amount: 10_000, status: "pending", reason: "UAT 6006: goodwill", hoursAgo: 2 },
    { amount: 5_000, status: "failed", reason: "UAT 6006: the card was closed", hoursAgo: 1 },
  ];
  for (const row of rows) {
    const reference = await nextReference("CN", client);
    await client.refund.create({
      data: {
        reference,
        invoiceId: made.invoiceId,
        customerId: invoice.customerId,
        jobId: invoice.jobId,
        paymentId: invoice.payments[0]?.id ?? null,
        amount: row.amount,
        reason: row.reason,
        approvedByUserId: mike.id,
        approvedAt: new Date(Date.now() - row.hoursAgo * 60 * 60_000),
        stripeRefundId: `re_uat_6006_${reference}`,
        status: row.status,
      },
    });
  }
  return `${made.jobReference} / ${made.invoiceReference} - Sarah's second leaking-tap job: $610, paid, with three refunds already made by Mike -- $200 refunded, $100 pending, $50 failed`;
}

export async function make(client: PrismaClient): Promise<string[]> {
  const stripe = stripeClient();
  return [await firstJob(client, stripe), await margaretsJob(client, stripe), await listJob(client, stripe)];
}

/** Remake the starting jobs the owner has used up (a refund on them that did not fail); leave the rest. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const stripe = stripeClient();
  const lines: string[] = [];
  // Sarah's first job is for the many steps on one invoice (part refund, then the rest): it is
  // remade only once every one of its invoices is refunded in full. Margaret's is for one fresh
  // refund: it is remade as soon as none is left without a refund.
  const firstInvoices = await client.invoice.findMany({
    where: { job: { description: FIRST } },
    select: { amount: true, refunds: { where: { status: { in: ["succeeded", "pending"] } }, select: { amount: true } } },
  });
  const hasRoom = firstInvoices.some((i) => i.refunds.reduce((sum, r) => sum + r.amount, 0) < i.amount);
  if (!hasRoom) lines.push(await firstJob(client, stripe));
  const unused = await client.job.findMany({
    where: { description: MARGARET, invoices: { some: { refunds: { none: {} } } } },
    select: { id: true },
  });
  if (unused.length === 0) lines.push(await margaretsJob(client, stripe));
  return lines;
}
