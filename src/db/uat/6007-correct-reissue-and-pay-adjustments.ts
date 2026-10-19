// UAT data for feature 6007, Correct & reissue and pay adjustments.
//
// Completed visits, invoiced the way Complete does it (the same issue step), each unpaid invoice
// with a REAL Stripe sandbox pay link made quietly (no message sent when these are made):
//   1. JOB-a  Sarah's leaking-tap job, Bob, 5h logged, invoice sent and unpaid, Bob's visit not yet
//             swept (AC1 to AC4, AC13, AC14).
//   2. JOB-b  Sarah's second tap job, Bob, 3h, invoice PAID by a real sandbox card payment, so a
//             correction's refund reaches Succeeded through Stripe's refund events (AC5, AC15).
//   3. Nina Rossi (Rossi's Cafe), Bob, 3h last week, invoice unpaid with a sandbox link, the visit
//             on Bob's unapproved DRAFT (AC7 rebuild, AC10 rebuild case, AC12 QR).
//   4. Dave, 2h last week, on his PAID week (the week is written as approved and paid), for a minus
//             correction -- with one $100 visit this week, unswept (AC7, AC8).
//   5. Margaret, a no-show call-out invoice on a job Bob attended (AC9).
//   6. Sarah, a $0 follow-up by Priya -- a goodwill callback on an earlier job of Priya's (AC9).
// Bob's approved week (AC10, "waits for next week") is reached in the steps, by approving his draft.
// Only cast people are used: Sarah, Nina, Margaret, Bob, Dave, Priya and Mike. Nina is made here if
// she is not on file. Nothing changes a cast record, so there is no restoreCast. The drafts and the
// paid week are written without any email. Needs STRIPE_SECRET_KEY (the sandbox key) in the backend .env.
//
// topUp: a record the owner has used up (an invoice replaced, refunded or paid; a correction made) is
// remade fresh; the rest stay as they are.
import Stripe from "stripe";
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, zonedDateTimeToUtc } from "../../time/index.js";
import { issueCalloutInvoice, issueInvoice } from "../../invoices/issue.js";
import { stripeProvider } from "../../invoices/stripe.js";
import { addDays, periodFor, plainDate } from "../../settlements/calendar.js";
import { sweepContractor } from "../../settlements/sweep.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const SARAHS_SITE = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = { street: "14 Marine Terrace", suburb: "Fremantle", state: "WA", country: "AU", postcode: "6160", lat: -32.0569, lng: 115.7439, placeId: null };
const APPLECROSS = { street: "8 Ardross Street", suburb: "Applecross", state: "WA", country: "AU", postcode: "6153", lat: -32.0178, lng: 115.8394, placeId: null };
const LABEL = "uat-6007";

const A = "UAT 6007: Sarah's tap, 5h logged, unpaid.";
const B = "UAT 6007: Sarah's second tap, paid.";
const NINA = "UAT 6007: Rossi's Cafe sink, on Bob's draft.";
const DAVE = "UAT 6007: Dave's switchboard, on his paid week.";
const DAVE_SMALL = "UAT 6007: Dave's small job this week.";
const MARGARET = "UAT 6007: Margaret's no-show call-out.";
const PARENT = "UAT 6007: Sarah's earlier power-point job, Priya.";
const FOLLOW_UP = "UAT 6007: Sarah's power-point follow-up, no charge.";

type Site = Omit<typeof SARAHS_SITE, "placeId"> & { placeId: string | null };

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

/** A weekday in the week the latest Monday run covered (Thursday of it), and a start 8:00am that day. */
async function lastWeekDay(client: PrismaClient, now: Date): Promise<string> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const end = periodFor(settings, now).periodEnd; // the Sunday just ended
  const thursday = addDays(end, -3);
  return thursday;
}

/** Today if it is a weekday; otherwise the last weekday. The visit is already over (it ended an hour ago). */
function thisWeekMoment(now: Date): { day: string; start: Date; completedAt: Date } {
  const completedAt = new Date(now.getTime() - 60 * 60_000);
  let day = ymdIn(completedAt);
  let cursor = completedAt;
  for (let back = 0; back < 7 && isWeekend(ZONE, cursor); back += 1) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    day = ymdIn(cursor);
  }
  return { day, start: new Date(completedAt.getTime() - 5 * 60 * 60_000), completedAt };
}

function stripeClient(): Stripe {
  const key = process.env["STRIPE_SECRET_KEY"]?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT payments need the Stripe sandbox");
  return new Stripe(key, { timeout: 20_000, maxNetworkRetries: 1 });
}

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

interface VisitOptions {
  customerCode: string;
  customer?: { name: string; email: string; businessName: string };
  contractorCode: string;
  trade: string;
  description: string;
  site: Site;
  /** the visit's local day and where it starts, and when Complete was pressed */
  day: string;
  start: Date;
  completedAt: Date;
  hours: number;
  parentJobId?: string;
  goodwill?: boolean;
}

interface Made {
  jobId: string;
  jobReference: string;
  assignmentId: string;
  invoiceId: string;
  invoiceReference: string;
}

async function customerOf(client: PrismaClient, options: VisitOptions): Promise<{ id: string }> {
  if (options.customer === undefined) return client.customer.findUniqueOrThrow({ where: { code: options.customerCode } });
  return (
    (await client.customer.findUnique({ where: { email: options.customer.email } })) ??
    client.customer.create({
      data: {
        code: await nextReference("CUS", client),
        name: options.customer.name,
        email: options.customer.email,
        phone: "0400 002 060",
        businessName: options.customer.businessName,
        billingAddress: FREMANTLE,
      },
    })
  );
}

/** A completed visit, invoiced by the same issue step Complete uses. */
async function completedVisit(client: PrismaClient, options: VisitOptions): Promise<Made> {
  const customer = await customerOf(client, options);
  const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade: options.trade } });
  const contractor = await client.contractor.findUniqueOrThrow({ where: { code: options.contractorCode }, include: { specialties: true } });
  const specialty = contractor.specialties.find((s) => s.trade === options.trade);
  if (!specialty) throw new Error(`${options.contractorCode} has no ${options.trade} specialty`);
  const end = new Date(options.start.getTime() + options.hours * 60 * 60_000);
  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: options.site.postcode,
      serviceLocation: { suburb: options.site.suburb, state: options.site.state, country: options.site.country, lat: options.site.lat, lng: options.site.lng, placeId: options.site.placeId },
      siteAddress: options.site,
      serviceLevel: "normal",
      timezone: ZONE,
      description: options.description,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: plainDate(options.day),
      status: "scheduled",
      ...(options.parentJobId === undefined ? {} : { parentJobId: options.parentJobId }),
    },
  });
  const assignment = await client.assignment.create({
    data: {
      jobId: job.id,
      contractorId: contractor.id,
      specialtyId: specialty.id,
      status: "accepted",
      proposedSlot: options.start,
      confirmedSlot: options.start,
      acceptedAt: options.start,
      ...(options.goodwill === true ? { callbackChargeable: false } : {}),
    },
  });
  await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: options.start, endedAt: end, note: null } });
  const invoice = await client.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { completionNotes: "Done and tested.", billedHours: options.hours, completedAt: options.completedAt, status: "completed" },
    });
    await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
    return issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [options.start], billedHours: options.hours, now: options.completedAt });
  });
  return { jobId: job.id, jobReference: job.reference, assignmentId: assignment.id, invoiceId: invoice.id, invoiceReference: invoice.reference };
}

/** The real sandbox link, with no message sent. */
async function linkQuietly(client: PrismaClient, made: Made): Promise<void> {
  const provider = stripeProvider();
  if (provider === null) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT invoices need real sandbox pay links");
  const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
  const link = await provider.createPayLink({ invoiceId: invoice.id, invoiceReference: invoice.reference, jobReference: made.jobReference, amount: invoice.amount });
  await client.invoice.update({ where: { id: invoice.id }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });
}

async function sarahUnpaid(client: PrismaClient, now: Date): Promise<string> {
  const when = thisWeekMoment(now);
  const made = await completedVisit(client, { customerCode: "CUS-1050", contractorCode: "CON-014", trade: "Plumbing", description: A, site: SARAHS_SITE, hours: 5, ...when });
  await linkQuietly(client, made);
  return `${made.jobReference} / ${made.invoiceReference} - JOB-a: Sarah's leaking-tap job, completed by Bob, 5h logged: $970, UNPAID with a sandbox pay link, Bob's visit not yet swept`;
}

async function sarahPaid(client: PrismaClient, stripe: Stripe, now: Date): Promise<string> {
  const when = thisWeekMoment(now);
  const made = await completedVisit(client, { customerCode: "CUS-1050", contractorCode: "CON-014", trade: "Plumbing", description: B, site: SARAHS_SITE, hours: 3, ...when });
  const invoice = await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
  const paidAt = new Date(now.getTime() - 30 * 60_000);
  const intent = await sandboxPayment(stripe, invoice.amount, invoice.id, invoice.reference);
  // Written straight in, so no receipt or office notice is sent.
  await client.payment.create({
    data: { invoiceId: invoice.id, customerId: invoice.customerId, stripePaymentIntentId: intent, amount: invoice.amount, status: "succeeded", method: "card", paidAt },
  });
  await client.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt } });
  return `${made.jobReference} / ${made.invoiceReference} - JOB-b: Sarah's second tap job, completed by Bob, 3h: $610, PAID by card through the Stripe sandbox, no refunds yet`;
}

/** One contractor's visits of the week the latest run covered, swept into a draft with no email. */
async function draftFor(client: PrismaClient, contractorCode: string, now: Date): Promise<{ id: string; reference: string }> {
  const settings = await client.platformSettings.findFirstOrThrow();
  const periodEnd = periodFor(settings, now).periodEnd;
  const contractor = await client.contractor.findUniqueOrThrow({ where: { code: contractorCode } });
  const swept = await client.$transaction((tx) => sweepContractor(tx, contractor.id, { periodEnd, now, onlyLabel: LABEL }));
  if (swept === null) {
    throw new Error(`${contractorCode} already has a draft that is not this feature's, so no draft could be made for the UAT -- approve or clear it first`);
  }
  return { id: swept.id, reference: swept.reference };
}

async function ninaOnBobsDraft(client: PrismaClient, now: Date): Promise<string> {
  const day = await lastWeekDay(client, now);
  const start = zonedDateTimeToUtc(ZONE, day, 8, 0);
  const made = await completedVisit(client, {
    customerCode: "",
    customer: { name: "Nina Rossi", email: "nina@idelta.com.au", businessName: "Rossi's Cafe" },
    contractorCode: "CON-014",
    trade: "Plumbing",
    description: NINA,
    site: FREMANTLE,
    day,
    start,
    completedAt: new Date(start.getTime() + 4 * 60 * 60_000),
    hours: 3,
  });
  await linkQuietly(client, made);
  const draft = await draftFor(client, "CON-014", now);
  return `${made.jobReference} / ${made.invoiceReference} - Nina Rossi's job at Rossi's Cafe, completed by Bob, 3h: $610, UNPAID with a sandbox pay link; Bob's visit is on his unapproved DRAFT ${draft.reference}`;
}

async function davesPaidWeek(client: PrismaClient, now: Date): Promise<string[]> {
  const day = await lastWeekDay(client, now);
  const start = zonedDateTimeToUtc(ZONE, day, 9, 0);
  const made = await completedVisit(client, {
    customerCode: "CUS-1050",
    contractorCode: "CON-021",
    trade: "Electrical",
    description: DAVE,
    site: SARAHS_SITE,
    day,
    start,
    completedAt: new Date(start.getTime() + 3 * 60 * 60_000),
    hours: 2,
  });
  await linkQuietly(client, made);
  const draft = await draftFor(client, "CON-021", now);
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  // His week is approved and paid: written straight in (no email), so a correction can never reopen it.
  await client.contractorSettlement.update({
    where: { id: draft.id },
    data: { status: "paid", approvedAt: now, contractorGstRegistered: false, paidAt: now, paidByUserId: mike.id, paymentReference: draft.reference },
  });
  // This week: one small job, its pay set to $100 so a deduction is bigger than the week's work.
  const when = thisWeekMoment(now);
  const small = await completedVisit(client, { customerCode: "CUS-1050", contractorCode: "CON-021", trade: "Electrical", description: DAVE_SMALL, site: SARAHS_SITE, hours: 1, ...when });
  await linkQuietly(client, small);
  await client.assignment.update({ where: { id: small.assignmentId }, data: { contractorPay: 10_000 } });
  return [
    `${made.jobReference} / ${made.invoiceReference} - Dave's switchboard job for Sarah, 2h: $${((await client.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } })).amount / 100).toFixed(0)}, unpaid; Dave's pay for it ($365) is on his week ${draft.reference}, which is PAID`,
    `${small.jobReference} / ${small.invoiceReference} - Dave's small job this week, pay set to $100, not yet swept (his next payout)`,
  ];
}

async function margaretsNoShow(client: PrismaClient, now: Date): Promise<string> {
  const when = thisWeekMoment(now);
  const customer = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
  const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const settings = await client.platformSettings.findFirstOrThrow({ select: { calloutFee: true } });
  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: APPLECROSS.postcode,
      serviceLocation: { suburb: APPLECROSS.suburb, state: APPLECROSS.state, country: APPLECROSS.country, lat: APPLECROSS.lat, lng: APPLECROSS.lng, placeId: APPLECROSS.placeId },
      siteAddress: APPLECROSS,
      serviceLevel: "normal",
      timezone: ZONE,
      description: MARGARET,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: plainDate(when.day),
      status: "cancelled",
      cancelReason: "customer_no_show",
      cancelledAt: when.completedAt,
    },
  });
  const assignment = await client.assignment.create({
    data: {
      jobId: job.id,
      contractorId: bob.id,
      specialtyId: specialty.id,
      status: "cancelled",
      proposedSlot: when.start,
      confirmedSlot: when.start,
      acceptedAt: when.start,
      cancelledAt: when.completedAt,
      contractorPay: settings.calloutFee,
    },
  });
  const invoice = await client.$transaction((tx) => issueCalloutInvoice(tx, { assignmentId: assignment.id, now: when.completedAt }));
  await linkQuietly(client, { jobId: job.id, jobReference: job.reference, assignmentId: assignment.id, invoiceId: invoice.id, invoiceReference: invoice.reference });
  return `${job.reference} / ${invoice.reference} - Margaret's job, a customer no-show Bob attended: call-out invoice $${(settings.calloutFee / 100).toFixed(0)}, unpaid with a sandbox pay link; Bob's call-out pay is on his next payout`;
}

async function sarahsFollowUp(client: PrismaClient, now: Date): Promise<string> {
  const day = await lastWeekDay(client, now);
  const start = zonedDateTimeToUtc(ZONE, day, 10, 0);
  const parent = await completedVisit(client, {
    customerCode: "CUS-1050",
    contractorCode: "CON-030",
    trade: "Electrical",
    description: PARENT,
    site: SARAHS_SITE,
    day,
    start,
    completedAt: new Date(start.getTime() + 2 * 60 * 60_000),
    hours: 1,
  });
  const when = thisWeekMoment(now);
  const followUp = await completedVisit(client, {
    customerCode: "CUS-1050",
    contractorCode: "CON-030",
    trade: "Electrical",
    description: FOLLOW_UP,
    site: SARAHS_SITE,
    hours: 1,
    parentJobId: parent.jobId,
    goodwill: true,
    ...when,
  });
  return `${followUp.jobReference} / ${followUp.invoiceReference} - Sarah's follow-up visit by Priya, a goodwill callback on her earlier job ${parent.jobReference}: $0 invoice, Priya paid nothing for it (her own earlier work)`;
}

export async function make(client: PrismaClient): Promise<string[]> {
  const stripe = stripeClient();
  const now = new Date();
  const lines: string[] = [];
  // The drafts first: they sweep only last week's visits, so this week's stay unswept.
  lines.push(await ninaOnBobsDraft(client, now));
  lines.push(...(await davesPaidWeek(client, now)));
  lines.push(await sarahUnpaid(client, now));
  lines.push(await sarahPaid(client, stripe, now));
  lines.push(await margaretsNoShow(client, now));
  lines.push(await sarahsFollowUp(client, now));
  return lines;
}

/** Remake the records the owner has used up; leave every other record exactly as it is. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const stripe = stripeClient();
  const now = new Date();
  const lines: string[] = [];

  // JOB-a: used up once its newest invoice is no longer the unpaid original (replaced, voided or paid).
  const a = await client.job.findMany({ where: { description: A }, select: { invoices: { select: { status: true, replacesInvoiceId: true, createdAt: true }, orderBy: { createdAt: "desc" } } } });
  if (!a.some((job) => job.invoices[0]?.status === "sent" && job.invoices.length === 1)) lines.push(await sarahUnpaid(client, now));

  // JOB-b: used up once any refund is on it.
  const b = await client.job.findMany({ where: { description: B, invoices: { some: { refunds: { none: {} } } } }, select: { id: true } });
  if (b.length === 0) lines.push(await sarahPaid(client, stripe, now));

  // Margaret's no-show: used up once its invoice was replaced or voided.
  const m = await client.job.findMany({ where: { description: MARGARET, invoices: { every: { status: "sent", replacesInvoiceId: null } } }, select: { id: true } });
  if (m.length === 0) lines.push(await margaretsNoShow(client, now));

  // Dave's paid-week job: used up once a correction was made on it (a correction row for the job).
  const dave = await client.job.findMany({ where: { description: DAVE }, select: { id: true, payAdjustments: { select: { id: true } } } });
  if (dave.length > 0 && dave.every((job) => job.payAdjustments.length > 0)) {
    // A new job on a fresh paid week is not possible beside the first (one run per period); his job is
    // put back by `make` after a clear. Say so rather than invent a second week.
    lines.push("Dave's paid-week job already has a correction: ask for a full make again to put it back");
  }
  return lines;
}
