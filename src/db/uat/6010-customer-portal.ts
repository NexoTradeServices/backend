// UAT data for feature 6010, the customer portal.
//
// Sarah Chen (CUS-1050, sarah@idelta.com.au) gets records to look at, all labelled uat-6010. Her LOGIN is made
// by the UAT steps the 3004 way (Set a password, on her real Customer row), so 3004's own check still finds her
// a guest; restoreCast removes that login again.
//   a. a completed job of Bob's with its invoice PAID by card, her 4-star review, and a partial refund
//      (credit note) -- the Done job, its Paid invoice, the Payments rows, the Receipt (AC1-AC7)
//   b. a second job, Booked with Bob for tomorrow (AC2, AC3: tradie and visit time)
//   c. a third job, Requested (AC2)
//   d. a completed job with an OPEN invoice and a live Stripe sandbox pay link -- Pay now (AC4); it falls back
//      to a placeholder link when the dev Stripe key is not set
//   e. a completed job whose invoice was VOIDED and replaced by a reissue -- "Replaced by" (AC5)
// Tom (CUS-1052) gets a job and an invoice of his own, to try opening from Sarah's login (AC8).
// Mike and Bob are the seeded logins (AC9). AC11 (60 jobs) is proven by the automated test only.
//
// Cast records UAT changes: Sarah's login (made by the steps). restoreCast removes it (with its links and mail).
// Sends nothing by email or text.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { issueInvoice } from "../../invoices/issue.js";
import { stripeProvider } from "../../invoices/stripe.js";
import { isWeekend, todayAt, zonedDateTimeToUtc } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const SITE = { street: "5 Carrington Street", ...HILTON };
const KALAMUNDA = { street: "22 Haynes Street", suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.9747, lng: 116.0581, placeId: "fixture-place-kalamunda" };

const KEYS = ["a", "b", "c", "d", "e", "t"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-6010:${key}]`;

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

function weekdayBack(now: Date, skip: number): string {
  let seen = 0;
  for (let back = 1; back < 30; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (isWeekend(ZONE, day)) continue;
    if (seen === skip) return ymdIn(day);
    seen += 1;
  }
  throw new Error("no weekday in the last month");
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake only what is gone. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: "uat-6010", description: { contains: markerOf(key) } } });
    if (job === null) used.add(key);
  }
  return makeRecords(client, used);
}

/** Sarah is a guest again: the login, its links and mail go. Her Customer row and the seeded cast stay. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  const sarah = await client.customer.findUnique({ where: { code: "CUS-1050" }, select: { id: true, userId: true } });
  if (sarah === null || sarah.userId === null) return;
  const userId = sarah.userId;
  await client.customer.update({ where: { id: sarah.id }, data: { userId: null } });
  await client.verification.deleteMany({ where: { identifier: { startsWith: "reset-password:" }, value: userId } });
  await client.notification.deleteMany({ where: { recipientType: "user", recipientId: userId } });
  await client.user.delete({ where: { id: userId } });
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const lines: string[] = [];
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bobRow = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bobRow.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  let skip = 0;

  async function newJob(key: Key, customerId: string, description: string, status: "new" | "scheduled" | "completed", site: typeof SITE | typeof KALAMUNDA) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: site.postcode,
        serviceLocation: { suburb: site.suburb, state: site.state, country: site.country, lat: site.lat, lng: site.lng, placeId: site.placeId },
        siteAddress: site,
        source: "web",
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  /** A finished, invoiced visit (3.0h) by Bob, priced by the same step Complete uses. */
  async function completedJob(key: Key, customerId: string, description: string, site: typeof SITE | typeof KALAMUNDA, status: "sent" | "paid" | "void") {
    const job = await newJob(key, customerId, description, "completed", site);
    const start = zonedDateTimeToUtc(ZONE, weekdayBack(now, skip), 8, 0);
    skip += 1;
    const end = new Date(start.getTime() + 3 * 60 * 60_000);
    const assignment = await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bobRow.id,
        specialtyId: specialty!.id,
        status: "accepted",
        proposedSlot: start,
        confirmedSlot: start,
        acceptedAt: start,
        completionNotes: "Replaced the cartridge and re-sealed the base.",
        billedHours: 3,
      },
    });
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: start, endedAt: end, note: null } });
    const invoice = await client.$transaction(async (tx) => {
      await tx.assignment.update({ where: { id: assignment.id }, data: { completedAt: end, status: "completed" } });
      const issued = await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [start], billedHours: 3, now: end });
      if (status === "paid") await tx.invoice.update({ where: { id: issued.id }, data: { status: "paid", paidAt: end } });
      if (status === "void") await tx.invoice.update({ where: { id: issued.id }, data: { status: "void", voidReason: "Reissued with a correction", voidedAt: end, voidedByUserId: mike.id } });
      return issued;
    });
    return { job, assignmentId: assignment.id, invoiceId: invoice.id, completedAt: end };
  }

  if (which.has("a")) {
    const made = await completedJob("a", sarah.id, "UAT 6010: the kitchen mixer tap was leaking.", SITE, "paid");
    const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
    const payment = await client.payment.create({
      data: { invoiceId: invoice.id, customerId: sarah.id, stripePaymentIntentId: `pi_uat6010_${made.job.reference}`, amount: invoice.amount, status: "succeeded", method: "card", paidAt: made.completedAt },
    });
    await client.review.create({ data: { jobId: made.job.id, customerId: sarah.id, contractorId: bobRow.id, rating: 4, reviewText: "Tidy work, thank you.", recommendScore: 9, createdAt: new Date(made.completedAt.getTime() + 2 * 60 * 60_000) } });
    const refund = await client.refund.create({
      data: {
        reference: await nextReference("CN", client),
        invoiceId: invoice.id,
        customerId: sarah.id,
        jobId: made.job.id,
        paymentId: payment.id,
        amount: Math.round(invoice.amount / 5),
        reason: "Part not fitted",
        approvedByUserId: mike.id,
        approvedAt: now,
        billedTo: { name: sarah.name },
        stripeRefundId: `re_uat6010_${made.job.reference}`,
        status: "succeeded",
      },
    });
    lines.push(`${made.job.reference} - Sarah's completed job: ${invoice.reference} paid by card, her 4-star review, and a partial refund ${refund.reference} with its receipt`);
  }
  if (which.has("b")) {
    const job = await newJob("b", sarah.id, "UAT 6010: the bathroom basin is dripping.", "scheduled", SITE);
    const slot = new Date(todayAt(ZONE, 9, 0, now).getTime() + DAY_MS);
    await client.assignment.create({ data: { jobId: job.id, contractorId: bobRow.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now } });
    lines.push(`${job.reference} - Sarah's job booked with Bob for tomorrow (Booked, with Bob and the visit time)`);
  }
  if (which.has("c")) {
    const job = await newJob("c", sarah.id, "UAT 6010: the laundry tap will not turn off.", "new", SITE);
    lines.push(`${job.reference} - Sarah's third job, just requested (Requested)`);
  }
  if (which.has("d")) {
    const made = await completedJob("d", sarah.id, "UAT 6010: the shower mixer needed replacing.", SITE, "sent");
    const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
    const provider = stripeProvider();
    const link = provider === null ? { url: `https://pay.test/${invoice.reference}`, id: `plink_${invoice.reference}` } : await provider.createPayLink({ invoiceId: invoice.id, invoiceReference: invoice.reference, jobReference: made.job.reference, amount: invoice.amount });
    await client.invoice.update({ where: { id: invoice.id }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });
    lines.push(`${made.job.reference} - Sarah's completed job with an OPEN invoice ${invoice.reference} and a live ${provider === null ? "placeholder" : "Stripe sandbox"} pay link (Pay now)`);
  }
  if (which.has("e")) {
    const made = await completedJob("e", sarah.id, "UAT 6010: the hot water tap was loose.", SITE, "void");
    const voided = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
    const rest: Record<string, unknown> = { ...voided };
    delete rest["id"];
    const reissue = await client.invoice.create({
      data: { ...rest, reference: await nextReference("INV", client), status: "sent", voidReason: null, voidedAt: null, voidedByUserId: null, replacesInvoiceId: voided.id, billedTo: voided.billedTo as never, stripePaymentLinkUrl: null, stripePaymentLinkId: null } as never,
    });
    const lineRows = await client.invoiceLine.findMany({ where: { invoiceId: voided.id } });
    for (const line of lineRows) {
      await client.invoiceLine.create({ data: { invoiceId: reissue.id, kind: line.kind, description: line.description, qty: line.qty, unitPrice: line.unitPrice, lineTotal: line.lineTotal } });
    }
    lines.push(`${made.job.reference} - Sarah's completed job: ${voided.reference} is VOID and replaced by ${reissue.reference} ("Replaced by")`);
  }
  if (which.has("t")) {
    const made = await completedJob("t", tom.id, "UAT 6010: Tom's blocked drain.", KALAMUNDA, "sent");
    const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
    lines.push(`${made.job.reference} - Tom's own completed job with his own invoice ${invoice.reference}: try opening it from Sarah's login (it must not open)`);
  }
  return lines;
}
