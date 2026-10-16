// UAT data for feature 6015, home and business customers and the invoice and refund documents.
//
// Five of Bob's Plumbing jobs, the invoices made by the same issue step Complete uses:
//   sarah-a1   Sarah's leaking-tap job: completed, invoice SENT and unpaid, not GST, with a real
//              Stripe sandbox pay link (no message sent) -- invoice A1, AC4, AC9 (Resend invoice).
//   sarah-b1   Sarah's second job: completed, paid, invoice stamped GST -- B1 (AC6, AC8, AC10, AC12).
//   nina-open  Nina Rossi's dispatched job at Rossi's Cafe -- the job page fields (AC1, AC2). Her
//              record has no ABN when the owner starts.
//   nina-a2    Nina's completed job, paid, not GST, issued BEFORE her ABN was added (A2 without an
//              ABN, AC3, AC5), ready to refund.
//   nina-b2    Nina's completed job, paid, stamped GST, issued AFTER her ABN 51 824 753 556 was
//              added (B2, AC6, AC8, AC10). Her ABN is put back to none afterwards, so Mike can type
//              it on the dispatched job.
// Paid invoices are paid by a REAL Stripe sandbox payment (written straight in, so no receipt or
// notice is sent): a refund on them is a real sandbox refund. Settings' Accounts phone is made
// blank. Nothing here sends an email or a text; the owner's own steps do (Resend invoice, Refund).
// Only cast people are used: Sarah, Nina, Bob and Mike. Nina is made here when she is not on file
// (labelled, so the clear removes her). Needs STRIPE_SECRET_KEY (the sandbox key) in the backend
// .env.
//
// restoreCast: Accounts phone back to blank; Nina's ABN and GST answer back to none, her business
// name left as it is; Sarah's business name (if the owner tried one) back to none.
//
// topUp: a scenario whose invoice the owner has used up (refunded in full, or Sarah's A1 paid or
// voided) is remade fresh; the rest stay as they are.
import Stripe from "stripe";
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, todayAt, zonedDateTimeToUtc } from "../../time/index.js";
import { issueInvoice } from "../../invoices/issue.js";
import { stripeProvider } from "../../invoices/stripe.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const NINAS_ABN = "51824753556";
const SARAHS_SITE = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = { street: "14 Marine Terrace", suburb: "Fremantle", state: "WA", country: "Australia", postcode: "6160", lat: -32.0569, lng: 115.7439, placeId: null };

type Key = "sarah-a1" | "sarah-b1" | "nina-open" | "nina-a2" | "nina-b2";
const KEYS: Key[] = ["sarah-a1", "sarah-b1", "nina-open", "nina-a2", "nina-b2"];

/** The marker each job's description carries, so topUp can find a scenario's own records. */
const marker = (key: Key): string => `[uat-6015:${key}]`;

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

async function ninaRow(client: PrismaClient) {
  return (
    (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
    (await client.customer.create({
      data: {
        code: await nextReference("CUS", client),
        name: "Nina Rossi",
        email: "nina@idelta.com.au",
        phone: "0400 002 060",
        businessName: "Rossi's Cafe",
        billingAddress: FREMANTLE,
      },
    }))
  );
}

async function build(client: PrismaClient, stripe: Stripe, key: Key): Promise<string> {
  const now = new Date();
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const nina = await ninaRow(client);
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");

  const customer = key.startsWith("sarah") ? sarah : nina;
  const site = key.startsWith("sarah") ? SARAHS_SITE : { ...FREMANTLE, country: "AU", placeId: "fixture-place-fremantle" };
  const text: Record<Key, string> = {
    "sarah-a1": "the kitchen mixer tap is leaking from the base",
    "sarah-b1": "the outside hose tap was replaced",
    "nina-open": "the cafe's kitchen sink is blocked",
    "nina-a2": "the cafe's hand basin was re-sealed",
    "nina-b2": "the cafe's dishwasher inlet was replaced",
  };
  const slot = key === "nina-open" ? todayAt(ZONE, 9, 0, new Date(now.getTime() + DAY_MS)) : zonedDateTimeToUtc(ZONE, lastWeekday(now), 8, 0);

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
      description: `UAT 6015: ${text[key]}. ${marker(key)}`,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: key === "nina-open" ? "assigned" : "scheduled",
    },
  });

  if (key === "nina-open") {
    await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "assigned", proposedSlot: slot },
    });
    return `${job.reference} - Nina Rossi's dispatched job at Rossi's Cafe (${nina.code}): no ABN and no GST answer on her record yet, for the job page fields`;
  }

  const assignment = await client.assignment.create({
    data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
  });
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment.id, startedAt: slot, endedAt: new Date(slot.getTime() + 3 * 60 * 60_000), note: null },
  });

  // Nina's B2 invoice is issued with her ABN on file; the ABN is put back to none straight after.
  if (key === "nina-b2") await client.customer.update({ where: { id: nina.id }, data: { abn: NINAS_ABN } });
  const invoice = await client.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { completionNotes: "Replaced the part and tested for leaks -- all dry.", billedHours: 3, completedAt: now, status: "completed" },
    });
    await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
    return issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [slot], billedHours: 3, now });
  });
  if (key === "nina-b2") await client.customer.update({ where: { id: nina.id }, data: { abn: null } });

  const row = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  const gst = key === "sarah-b1" || key === "nina-b2";
  if (gst) await client.invoice.update({ where: { id: row.id }, data: { gstApplied: true, gstAmount: Math.round(row.amount / 11) } });
  const ref = `${job.reference} / ${row.reference}`;

  if (key === "sarah-a1") {
    const provider = stripeProvider();
    if (provider === null) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT invoice needs a sandbox pay link");
    const link = await provider.createPayLink({ invoiceId: row.id, invoiceReference: row.reference, jobReference: job.reference, amount: row.amount });
    await client.invoice.update({ where: { id: row.id }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });
    return `${ref} - Sarah's leaking-tap job, completed by Bob: invoice sent and unpaid, not GST (case A1), sandbox pay link`;
  }

  // Paid in full by a real sandbox payment, written straight in (no receipt or notice sent).
  const paidAt = new Date(now.getTime() - 60 * 60_000);
  const intent = await sandboxPayment(stripe, row.amount, row.id, row.reference);
  await client.payment.create({
    data: { invoiceId: row.id, customerId: customer.id, stripePaymentIntentId: intent, amount: row.amount, status: "succeeded", method: "card", paidAt },
  });
  await client.invoice.update({ where: { id: row.id }, data: { status: "paid", paidAt } });

  const who: Record<Exclude<Key, "sarah-a1" | "nina-open">, string> = {
    "sarah-b1": "Sarah's hose-tap job, completed by Bob: $610 paid, stamped GST (case B1), ready to refund",
    "nina-a2": "Nina Rossi's job at Rossi's Cafe, completed by Bob: paid, not GST, issued before her ABN was added (case A2, no ABN), ready to refund",
    "nina-b2": "Nina Rossi's job at Rossi's Cafe, completed by Bob: paid, stamped GST, issued with her ABN 51 824 753 556 on it (case B2), ready to refund",
  };
  return `${ref} - ${who[key]}`;
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  const stripe = stripeClient();
  const lines: string[] = [];
  // Nina's A2 invoice first (no ABN), then her B2 (build() adds her ABN for it and takes it off again).
  for (const key of KEYS) lines.push(await build(client, stripe, key));
  return lines;
}

/** Clear runs this after the label sweep; make runs it first. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.platformSettings.updateMany({ data: { accountsPhone: null } });
  await client.customer.updateMany({ where: { email: "nina@idelta.com.au" }, data: { abn: null, gstRegistered: null } });
  await client.customer.updateMany({ where: { code: "CUS-1050" }, data: { businessName: null, abn: null, gstRegistered: null } });
}

/** Remake the scenarios the owner has used up; leave the rest. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const stripe = stripeClient();
  const lines: string[] = [];
  for (const key of KEYS) {
    if (key === "nina-open") continue;
    const job = await client.job.findFirst({
      where: { description: { contains: marker(key) } },
      include: { invoices: { include: { refunds: { where: { status: { not: "failed" } }, select: { amount: true } } } } },
    });
    const invoice = job?.invoices[0];
    const used =
      invoice === undefined ||
      (key === "sarah-a1"
        ? invoice.status !== "sent"
        : invoice.refunds.reduce((sum, refund) => sum + refund.amount, 0) >= invoice.amount);
    if (used) lines.push(await build(client, stripe, key));
  }
  return lines;
}
