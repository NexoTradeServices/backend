// UAT data for feature 6001, invoice at completion.
//
// Two jobs, both Bob's, Plumbing, ready for him to press Complete:
//   1. Sarah's weekday job: accepted, a 3.0h time entry, work notes and a $45
//      part he bought (with its receipt label). Complete issues $655 -- the
//      first two lines are $250 and 2.0h @ $180/h, then the part (AC1-AC3, AC7-AC9,
//      AC12-AC15).
//   2. Nina's Saturday job: Nina Rossi of Rossi's Cafe (a business customer with
//      a billing address in Fremantle), accepted, a 1.0h entry on the most recent
//      Saturday and work notes -- the weekend price and the invoice addressed to
//      the cafe (AC4, AC6).
// Only cast people are used: Sarah, Nina and Bob. Nina is made here and swept with
// the rest on clear; nothing changes a cast record, so there is no restoreCast.
// The receipt photo is a label only (nothing is uploaded to Cloudinary).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, weekdayIn, zonedDateTimeToUtc } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
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
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };

/** "2026-10-07" for a moment in the business zone. */
function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

/** The most recent day (today included) that is, or is not, a weekend in the zone, and the given weekday when saturday. */
function recentDay(now: Date, wanted: "weekday" | "saturday"): string {
  for (let back = 0; back < 14; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (wanted === "weekday" ? !isWeekend(ZONE, day) : weekdayIn(ZONE, day) === "sat") return ymdIn(day);
  }
  throw new Error("no matching day in the last fortnight");
}

export async function make(client: PrismaClient): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  async function acceptedJob(
    customer: { id: string; billingAddress: unknown },
    day: string,
    level: "normal" | "weekend",
    description: string,
    postcode: string,
    siteAddress: object,
  ) {
    const slot = zonedDateTimeToUtc(ZONE, day, 8, 0);
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode,
        serviceLocation: { ...HILTON },
        siteAddress,
        serviceLevel: level,
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
    return { job, assignment, slot };
  }

  // 1. Sarah's weekday job: 3.0h, work notes, a $45 part with its receipt.
  const weekday = recentDay(now, "weekday");
  const sarahsSite = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
  const one = await acceptedJob(sarah, weekday, "normal", "UAT 6001: the kitchen mixer tap is leaking from the base.", "6163", sarahsSite);
  await client.assignmentTimeLog.create({
    data: { assignmentId: one.assignment.id, startedAt: one.slot, endedAt: new Date(one.slot.getTime() + 3 * 60 * 60_000), note: null },
  });
  await client.assignment.update({
    where: { id: one.assignment.id },
    data: { completionNotes: "Replaced the cartridge and re-sealed the base.\nTested for leaks -- all dry." },
  });
  const receipt = await client.attachment.create({
    data: { jobId: one.job.id, assignmentId: one.assignment.id, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/uat-6001-cartridge", fileName: "cartridge.jpg" },
  });
  await client.assignmentPart.create({
    data: { assignmentId: one.assignment.id, suppliedBy: "contractor", name: "Tap cartridge", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt.id },
  });
  lines.push(`${one.job.reference} - Sarah's leaking-tap job, accepted by Bob: a 3.0h entry on ${weekday}, work notes and a $45 tap cartridge with its receipt -- ready for Bob to press Complete`);

  // 2. Nina's Saturday job: a 1.0h entry, work notes, billed to Rossi's Cafe.
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
  const saturday = recentDay(now, "saturday");
  const two = await acceptedJob(nina, saturday, "weekend", "UAT 6001: the cafe's kitchen sink is blocked.", "6160", FREMANTLE_BILLING);
  await client.assignmentTimeLog.create({
    data: { assignmentId: two.assignment.id, startedAt: two.slot, endedAt: new Date(two.slot.getTime() + 60 * 60_000), note: null },
  });
  await client.assignment.update({
    where: { id: two.assignment.id },
    data: { completionNotes: "Cleared the blockage in the kitchen drain and flushed the line." },
  });
  lines.push(`${two.job.reference} - Nina Rossi's Saturday job at Rossi's Cafe in Fremantle (${nina.code}, billing address on her record), accepted by Bob: a 1.0h entry on ${saturday} and work notes -- ready for Bob to press Complete`);

  return lines;
}
