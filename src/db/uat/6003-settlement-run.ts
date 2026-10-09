// UAT data for feature 6003, the settlement run.
//
// Everything is dated off today, on the business clock: "last week" is the Monday-to-Sunday the
// most recent Monday run covers, "the week before" the one ahead of it, "this week" what has
// happened since. Visits are written straight into the tables but priced by the same completion
// step Complete uses, and the drafts are made by the real sweep.
//
//   Bob (GST registered, Tax Invoice):
//     - the week before: one Plumbing job for Sarah, already on an invoice Mike PAID, its
//       "you've been paid" email sent (AC10 look, AC11 list)
//     - last week: Sarah's leaking-tap job on the Wednesday (3.0h, the $45 Caroma part), a
//       Thursday job (1.5h) and a Saturday job (1.0h, time and a half) - swept by the run into
//       ONE draft, emailed to bob@idelta.com.au with a live approve link (AC3, AC4, AC5, AC12)
//     - this week: one job completed since the run, not yet swept - Next payout and Not yet
//       invoiced (AC11, AC12)
//   Dave (not registered, plain Invoice), Tom the customer:
//     - last week: an Electrical job and an Air conditioning job, on an invoice already APPROVED
//       and ready to pay (AC3, AC9, AC10)
//     - the week before: an unapproved Electrical draft whose job carries a `correction` note
//       dated after the draft was made - Rebuild it (AC8), or let next Monday's run replace it (AC7)
//   Priya (GST not asked): last week's Electrical job in a draft, emailed to priya@idelta.com.au,
//     so her approve link refuses (AC6) and her record shows "GST registration (not asked)" (AC1)
//
// Sends for REAL to cast mailboxes when made: the draft email to Bob and to Priya, and the
// payout-sent email to Bob for his paid invoice. Only cast people are used. make() sets the three
// contractors' GST answers to the seed's (Bob yes, Dave no, Priya not asked); restoreCast() puts
// them back after the owner has recorded an answer for Priya.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { issueInvoice } from "../../invoices/issue.js";
import { addDays, payDayAfter, periodFor, dayLabel } from "../../settlements/calendar.js";
import { askDraftEmail, askPayoutSentEmail } from "../../settlements/messages.js";
import { sweepContractor } from "../../settlements/sweep.js";
import { zonedDateTimeToUtc } from "../../time/index.js";

const HILTON = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const KALAMUNDA = { street: "22 Haynes Street", suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.9747, lng: 116.0581, placeId: "fixture-place-kalamunda" };

/** The cast's GST answers, as the seed has them. */
const CAST_GST = [
  { code: "CON-014", gstRegistered: true },
  { code: "CON-021", gstRegistered: false },
  { code: "CON-030", gstRegistered: null },
] as const;

async function putGstBack(client: PrismaClient): Promise<void> {
  for (const { code, gstRegistered } of CAST_GST) {
    await client.contractor.update({ where: { code }, data: { gstRegistered } });
  }
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await putGstBack(client);
}

export async function make(client: PrismaClient): Promise<string[]> {
  await putGstBack(client);
  const settings = await client.platformSettings.findFirstOrThrow();
  const zone = settings.timezone;
  const now = new Date();
  const period = periodFor(settings, now);
  const lastStart = period.periodStart;
  const beforeStart = addDays(lastStart, -7);
  const beforeEnd = addDays(period.periodEnd, -7);

  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
  const dave = await client.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
  const priya = await client.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
  const lines: string[] = [];

  /** A completed, invoiced visit by a cast contractor, the way Complete leaves it. */
  async function visit(
    contractorCode: string,
    trade: string,
    customer: { id: string },
    site: typeof HILTON,
    startsAt: Date,
    hours: number,
    description: string,
    withPart = false,
  ): Promise<{ jobId: string; jobReference: string; assignmentId: string; pay: number }> {
    const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade } });
    const contractor = await client.contractor.findUniqueOrThrow({ where: { code: contractorCode }, include: { specialties: true } });
    const specialty = contractor.specialties.find((s) => s.trade === trade);
    if (!specialty) throw new Error(`${contractorCode} has no ${trade} specialty`);
    const endsAt = new Date(startsAt.getTime() + hours * 60 * 60_000);
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: serviceType.id,
        customerCalloutRate: serviceType.customerCalloutRate,
        customerStandardRate: serviceType.customerStandardRate,
        postcode: site.postcode,
        serviceLocation: { suburb: site.suburb, state: site.state, country: site.country, lat: site.lat, lng: site.lng, placeId: site.placeId },
        siteAddress: site,
        serviceLevel: "normal",
        timezone: zone,
        description,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${startsAt.toISOString().slice(0, 10)}T00:00:00.000Z`),
        status: "scheduled",
      },
    });
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: contractor.id, specialtyId: specialty.id, status: "accepted", proposedSlot: startsAt, confirmedSlot: startsAt, acceptedAt: startsAt },
    });
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: startsAt, endedAt: endsAt, note: null } });
    if (withPart) {
      const receipt = await client.attachment.create({
        data: { jobId: job.id, assignmentId: assignment.id, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/uat-6003-caroma", fileName: "caroma-cartridge.jpg" },
      });
      await client.assignmentPart.create({
        data: { assignmentId: assignment.id, suppliedBy: "contractor", name: "Caroma cartridge", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt.id },
      });
    }
    await client.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { completionNotes: "Done and tested.", billedHours: hours, completedAt: endsAt, status: "completed" },
      });
      await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
      await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [startsAt], billedHours: hours, now: endsAt });
    });
    const done = await client.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    return { jobId: job.id, jobReference: job.reference, assignmentId: assignment.id, pay: done.contractorPay ?? 0 };
  }

  const at = (day: string, hour = 8): Date => zonedDateTimeToUtc(zone, day, hour, 0);

  /** The real sweep for one contractor up to a period's end; the draft email is asked by the caller. */
  async function sweep(contractorId: string, periodEnd: string): Promise<{ id: string; reference: string; testData: string | null }> {
    const draft = await client.$transaction((tx) => sweepContractor(tx, contractorId, { periodEnd, now }));
    if (draft === null) throw new Error(`nothing to sweep for ${contractorId} up to ${periodEnd}`);
    return draft;
  }

  // ---- Bob, the week before: an invoice Mike already paid -------------------------------------
  const older = await visit("CON-014", "Plumbing", sarah, HILTON, at(addDays(beforeStart, 1)), 1, "UAT 6003: the bathroom basin tap drips.");
  const olderInvoice = await sweep(bob.id, beforeEnd);
  const paidOn = addDays(payDayAfter(settings, beforeEnd), 0); // the first pay day after that week ended
  await client.contractorSettlement.update({
    where: { id: olderInvoice.id },
    data: {
      status: "approved",
      approvedAt: zonedDateTimeToUtc(zone, addDays(paidOn, -1), 9, 0),
      contractorGstRegistered: true,
      gstAmount: Math.round(older.pay / 10),
    },
  });
  await client.contractorSettlement.update({
    where: { id: olderInvoice.id },
    data: { status: "paid", paidAt: zonedDateTimeToUtc(zone, paidOn, 10, 0), paidByUserId: mike.id, paymentReference: olderInvoice.reference },
  });
  await askPayoutSentEmail(client, olderInvoice.id);
  lines.push(`${olderInvoice.reference} - Bob's older invoice (${older.jobReference}, Sarah's basin-tap job), PAID by Mike ${dayLabel(paidOn)}; the "you've been paid" email sent to bob@idelta.com.au`);

  // ---- Bob, last week: three jobs in one draft -------------------------------------------------
  const wednesday = await visit("CON-014", "Plumbing", sarah, HILTON, at(addDays(lastStart, 2)), 3, "UAT 6003: the kitchen mixer tap is leaking from the base.", true);
  const thursday = await visit("CON-014", "Plumbing", sarah, HILTON, at(addDays(lastStart, 3)), 1.5, "UAT 6003: the laundry tap needs a new washer.");
  const saturday = await visit("CON-014", "Plumbing", sarah, HILTON, at(addDays(lastStart, 5)), 1, "UAT 6003: the outside tap is dripping.");
  const bobsDraft = await sweep(bob.id, period.periodEnd);
  await askDraftEmail(client, bobsDraft, now);
  lines.push(
    `${bobsDraft.reference} - Bob's DRAFT for last week: ${wednesday.jobReference} Sarah's leaking-tap job (Wed, 3.0h, the $45 Caroma part), ${thursday.jobReference} (Thu, 1.5h), ${saturday.jobReference} (Sat, 1.0h at T1.5) - Subtotal $1,075, GST $107.50, materials $45, Total $1,227.50; the draft email with its approve link sent to bob@idelta.com.au`,
  );

  // ---- Bob, this week: swept by nobody yet ------------------------------------------------------
  const thisWeek = await visit("CON-014", "Plumbing", sarah, HILTON, zonedDateTimeToUtc(zone, period.runMonday, 6, 10), 1, "UAT 6003: the toilet cistern keeps running.");
  lines.push(`${thisWeek.jobReference} - Bob's job completed since the run (Sarah's cistern job, $200), not yet on any invoice: his Next payout and Not yet invoiced`);

  // ---- Dave: last week's invoice, approved and ready to pay -----------------------------------
  const electrical = await visit("CON-021", "Electrical", tom, KALAMUNDA, at(addDays(lastStart, 1)), 2, "UAT 6003: the hallway lights flicker.");
  const aircon = await visit("CON-021", "Air conditioning", tom, KALAMUNDA, at(addDays(lastStart, 3)), 1, "UAT 6003: the split system will not cool.");
  const davesApproved = await sweep(dave.id, period.periodEnd);
  await client.contractorSettlement.update({
    where: { id: davesApproved.id },
    data: { status: "approved", approvedAt: now, contractorGstRegistered: false, gstAmount: null },
  });
  lines.push(`${davesApproved.reference} - Dave's invoice for last week (${electrical.jobReference} Electrical 2.0h, ${aircon.jobReference} Air conditioning 1.0h), APPROVED and ready to pay: a plain Invoice, $365 + $215 = $580`);

  // ---- Dave: the week before, an unapproved draft with a corrected job ---------------------------
  const corrected = await visit("CON-021", "Electrical", tom, KALAMUNDA, at(addDays(beforeStart, 2)), 1.5, "UAT 6003: the garage power point is dead.");
  const davesOlder = await sweep(dave.id, beforeEnd);
  // The note must be dated AFTER the draft, so the flag shows.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await client.job.update({
    where: { id: corrected.jobId },
    data: { operatorNotes: [{ id: "uat-6003-correction", at: new Date().toISOString(), operatorId: mike.id, type: "correction", note: "Missing half hour added after the draft was made." }] },
  });
  lines.push(`${davesOlder.reference} - Dave's older DRAFT (the week before): ${corrected.jobReference} Electrical 1.5h, carrying a correction note made after the draft - "Job corrected since" shows; Rebuild it, or let next Monday's run replace it`);

  // ---- Priya: GST not asked -----------------------------------------------------------------------
  const priyas = await visit("CON-030", "Electrical", sarah, HILTON, at(addDays(lastStart, 3)), 2, "UAT 6003: the oven will not switch on.");
  const priyasDraft = await sweep(priya.id, period.periodEnd);
  await askDraftEmail(client, priyasDraft, now);
  lines.push(`${priyasDraft.reference} - Priya's DRAFT for last week (${priyas.jobReference}, Electrical 2.0h): GST registration NOT ASKED, so Approve is refused; the draft email sent to priya@idelta.com.au`);

  lines.push("Cast: Bob GST yes, Dave GST no, Priya GST not asked (set to the seed's answers)");
  return lines;
}
