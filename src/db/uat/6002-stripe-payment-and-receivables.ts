// UAT data for feature 6002, Stripe payment and receivables.
//
// Four of Bob's Plumbing jobs, completed and invoiced the way Complete does it (the
// same issue step), each invoice with a REAL Stripe sandbox pay link:
//   1. Sarah's leaking-tap job: 3.0h and a $45 part = $655, due in 4 days. Her invoice
//      email and text go, as they do live, so Bob's Payment card reads "Invoice sent".
//      She pays it with Stripe's test card (AC1, AC7, AC9, AC10).
//   2. Nina Rossi's job at Rossi's Cafe: due today (AC8).
//   3. Tom's job: 12 days overdue (AC8).
//   4. Tom's second job: its invoice void, its sandbox link still working -- paying it
//      shows money on a closed invoice (AC5).
// Only invoice 1 sends anything when made; 2-4 get their links with no message.
// Only cast people are used: Sarah, Nina, Tom and Bob. Nina is made here if she is not
// on file, and swept with the rest on clear; nothing changes a cast record, so there is
// no restoreCast. Needs STRIPE_SECRET_KEY (the sandbox key) in the backend .env.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, todayAt, zonedDateTimeToUtc } from "../../time/index.js";
import { issueInvoice } from "../../invoices/issue.js";
import { payLinkPass } from "../../invoices/pay-link.js";
import { stripeProvider } from "../../invoices/stripe.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const SARAHS_SITE = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE_BILLING = {
  street: "14 Marine Terrace",
  suburb: "Fremantle",
  state: "WA",
  country: "Australia",
  postcode: "6160",
  lat: -32.0569,
  lng: 115.7439,
  placeId: null,
};
const KALAMUNDA = { street: "22 Haynes Street", suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.9747, lng: 116.0581, placeId: null };

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

/** The most recent weekday before today, in the zone. */
function lastWeekday(now: Date): string {
  for (let back = 1; back < 14; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (!isWeekend(ZONE, day)) return ymdIn(day);
  }
  throw new Error("no weekday in the last fortnight");
}

export async function make(client: PrismaClient): Promise<string[]> {
  const provider = stripeProvider();
  if (provider === null) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT invoices need real sandbox pay links");

  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const nina =
    (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
    (await client.customer.create({
      data: {
        code: await nextReference("CUS", client),
        name: "Nina Rossi",
        email: "nina@idelta.com.au",
        phone: "0400 002 060",
        businessName: "Rossi's Cafe",
        billingAddress: FREMANTLE_BILLING,
      },
    }));
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const day = lastWeekday(now);
  const lines: string[] = [];

  /** A completed job, invoiced by the same issue step Complete uses; 3.0h, plus a $45 part when asked. */
  async function invoicedJob(
    customer: { id: string },
    description: string,
    postcode: string,
    siteAddress: { suburb: string; state: string; country: string; lat: number; lng: number; placeId: string | null },
    withPart: boolean,
  ): Promise<{ jobReference: string; invoiceId: string; invoiceReference: string }> {
    const slot = zonedDateTimeToUtc(ZONE, day, 8, 0);
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode,
        serviceLocation: {
          suburb: siteAddress.suburb,
          state: siteAddress.state,
          country: siteAddress.country,
          lat: siteAddress.lat,
          lng: siteAddress.lng,
          placeId: siteAddress.placeId,
        },
        siteAddress,
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
      data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty!.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.assignmentTimeLog.create({
      data: { assignmentId: assignment.id, startedAt: slot, endedAt: new Date(slot.getTime() + 3 * 60 * 60_000), note: null },
    });
    if (withPart) {
      const receipt = await client.attachment.create({
        data: { jobId: job.id, assignmentId: assignment.id, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/uat-6002-cartridge", fileName: "cartridge.jpg" },
      });
      await client.assignmentPart.create({
        data: { assignmentId: assignment.id, suppliedBy: "contractor", name: "Tap cartridge", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt.id },
      });
    }
    const invoice = await client.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { completionNotes: "Replaced the cartridge and re-sealed the base.\nTested for leaks -- all dry.", billedHours: 3, completedAt: now, status: "completed" },
      });
      await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
      return issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [slot], billedHours: 3, now });
    });
    return { jobReference: job.reference, invoiceId: invoice.id, invoiceReference: invoice.reference };
  }

  /** The real sandbox link, with no message sent. */
  async function linkOnly(invoiceId: string, jobReference: string): Promise<void> {
    const invoice = await client.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const link = await provider!.createPayLink({ invoiceId, invoiceReference: invoice.reference, jobReference, amount: invoice.amount });
    await client.invoice.update({ where: { id: invoiceId }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });
  }

  async function dueIn(invoiceId: string, dueAt: Date): Promise<void> {
    await client.invoice.update({ where: { id: invoiceId }, data: { dueAt } });
  }

  // 1. Sarah: $655, due in 4 days; her invoice email and text go, as they do live.
  const one = await invoicedJob(sarah, "UAT 6002: the kitchen mixer tap is leaking from the base.", "6163", SARAHS_SITE, true);
  if ((await payLinkPass(client, { invoiceId: one.invoiceId, limit: 1, provider })) !== 1) {
    throw new Error("Stripe did not make Sarah's pay link -- try again in a minute");
  }
  await dueIn(one.invoiceId, new Date(todayAt(ZONE, 17, 0, now).getTime() + 4 * DAY_MS));
  lines.push(`${one.jobReference} / ${one.invoiceReference} - Sarah's leaking-tap job, completed by Bob: $655, due in 4 days, sandbox pay link; her invoice email and text sent`);

  // 2. Nina, Rossi's Cafe: due today.
  const two = await invoicedJob(nina, "UAT 6002: the cafe's kitchen sink is blocked.", "6160", FREMANTLE_BILLING, false);
  await linkOnly(two.invoiceId, two.jobReference);
  await dueIn(two.invoiceId, todayAt(ZONE, 17, 0, now));
  lines.push(`${two.jobReference} / ${two.invoiceReference} - Nina Rossi's job at Rossi's Cafe, completed by Bob: $610, due today, sandbox pay link (no message sent)`);

  // 3. Tom: 12 days overdue.
  const three = await invoicedJob(tom, "UAT 6002: the laundry tap drips.", "6076", KALAMUNDA, false);
  await linkOnly(three.invoiceId, three.jobReference);
  await dueIn(three.invoiceId, new Date(todayAt(ZONE, 17, 0, now).getTime() - 12 * DAY_MS));
  lines.push(`${three.jobReference} / ${three.invoiceReference} - Tom's laundry-tap job, completed by Bob: $610, 12 days overdue, sandbox pay link (no message sent)`);

  // 4. Tom's second: void, its link still working.
  const four = await invoicedJob(tom, "UAT 6002: the outside hose tap leaks.", "6076", KALAMUNDA, false);
  await linkOnly(four.invoiceId, four.jobReference);
  await client.invoice.update({ where: { id: four.invoiceId }, data: { status: "void", voidReason: "UAT 6002: issued in error", voidedAt: now } });
  const voided = await client.invoice.findUniqueOrThrow({ where: { id: four.invoiceId }, select: { stripePaymentLinkUrl: true } });
  lines.push(`${four.jobReference} / ${four.invoiceReference} - Tom's hose-tap job, completed by Bob: $610, VOID, its sandbox link still works: ${voided.stripePaymentLinkUrl ?? "-"}`);

  return lines;
}
