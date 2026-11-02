// UAT data for feature 1021, Operating states.
//
// Two fresh jobs, labelled uat-1021 (the cast jobs are never touched):
//   a. Sarah's leaking-tap job in Hilton, new -- the open WA job for AC5 (its suburb cannot be moved to a
//      closed state).
//   b. Hannah Lee's (a guest, made here with the label) tap job in Newtown, accepted by Liam for a clear
//      weekday 9:00am three weeks out -- for AC3: with NSW unticked it can still be rescheduled and Liam stays
//      on the books.
// Bob (WA) and Liam (NSW) are as seeded. NSW is open with its holidays, VIC is closed with none (AC2, AC4, AC5,
// AC7); the 7 VIC holidays for AC2's success case are entered by hand at UAT.
//
// Sends for real: nothing. Both jobs are written straight in their states.
//
// Cast records UAT can change: the open flag of NSW and VIC, VIC's holidays, and Bob's Operating state. restoreCast
// puts NSW open (unstamped), VIC closed with no holidays, and Bob back in WA; Liam stays in NSW.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { nextWeekdayAt, todayIn } from "../../time/index.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL = "uat-1021";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const NEWTOWN = { suburb: "Newtown", state: "NSW", country: "AU", lat: -33.897644, lng: 151.180228, placeId: "fixture-place-newtown" };

const KEYS = ["sarah", "hannah"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.operatingState.updateMany({ where: { state: "NSW" }, data: { open: true, changedAt: null, changedByUserId: null } });
  await client.operatingState.updateMany({ where: { state: { in: ["VIC", "QLD", "SA", "TAS", "ACT", "NT"] } }, data: { open: false, changedAt: null, changedByUserId: null } });
  await client.publicHoliday.deleteMany({ where: { state: { notIn: ["WA", "NSW"] } } });
  await client.contractor.updateMany({ where: { code: { in: ["CON-014", "CON-021", "CON-030"] } }, data: { operatingState: "WA" } });
  await client.contractor.updateMany({ where: { code: "CON-037" }, data: { operatingState: "NSW" } });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake a job that is gone, or Hannah's if it was cancelled or moved off its state. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const need = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
    if (job === null) need.add(key);
    else if (key === "sarah" && job.status !== "new") need.add(key);
    else if (key === "hannah" && job.status !== "scheduled") need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const liam = await client.contractor.findUniqueOrThrow({ where: { code: "CON-037" }, include: { specialties: true } });
  const specialty = liam.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Liam has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  if (which.has("sarah")) {
    const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const wanted = nextWeekdayAt("Australia/Perth", "wed", 8, 0, new Date(now.getTime() + WEEK_MS));
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "6163",
        serviceLocation: { ...HILTON },
        timezone: "Australia/Perth",
        description: `Leaking mixer tap in the kitchen, still new. ${markerOf("sarah")}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${todayIn("Australia/Perth", wanted)}T00:00:00.000Z`),
        status: "new",
      },
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job in Hilton (WA), new -- try moving its suburb to a closed state (AC5)`);
  }

  if (which.has("hannah")) {
    const hannah =
      (await client.customer.findUnique({ where: { email: "hannah@idelta.com.au" } })) ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Hannah Lee", email: "hannah@idelta.com.au", phone: "0400 001 054" },
      }));
    let slot = nextWeekdayAt("Australia/Sydney", "thu", 9, 0, new Date(now.getTime() + 3 * WEEK_MS));
    for (let week = 0; week < 12; week += 1) {
      const busy = await client.calendarEvent.count({
        where: { contractorId: liam.id, startTime: { gte: new Date(slot.getTime() - 12 * 3600_000), lt: new Date(slot.getTime() + 12 * 3600_000) } },
      });
      const holiday = await client.publicHoliday.count({ where: { state: "NSW", date: new Date(`${todayIn("Australia/Sydney", slot)}T00:00:00.000Z`) } });
      if (busy === 0 && holiday === 0) break;
      slot = new Date(slot.getTime() + WEEK_MS);
    }
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: hannah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "2042",
        serviceLocation: { ...NEWTOWN },
        siteAddress: { street: "30 King Street", ...NEWTOWN, postcode: "2042" },
        serviceLevel: "normal",
        timezone: "Australia/Sydney",
        description: `Blocked kitchen sink, booked. ${markerOf("hannah")}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${todayIn("Australia/Sydney", slot)}T00:00:00.000Z`),
        status: "scheduled",
      },
    });
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: liam.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: liam.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    lines.push(`${job.reference} - Hannah Lee's blocked-sink job in Newtown (NSW), accepted by Liam on ${todayIn("Australia/Sydney", slot)} at 9:00am (AC3)`);
  }

  return lines;
}
