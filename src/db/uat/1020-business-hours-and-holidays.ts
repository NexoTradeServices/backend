// UAT data for feature 1020, Business hours and holidays.
//
// Two fresh jobs for Sarah (CUS-1050), Hilton, Plumbing, labelled uat-1020. Fresh jobs, not JOB-1042: the
// cast job is never touched.
//   a. Sarah's new job with a wanted date, ready to dispatch -- for AC3 (hours) and AC6 (a holiday).
//   b. Sarah's leaking-tap job, dispatched to Bob and accepted, on a clear day -- for AC4 (the hours change,
//      the job stays) and AC8 (a holiday added on its day says "1 job is already booked that day").
// WA 2026 and 2027 holidays are the migration's own rows (AC10); WA 2028 is empty on purpose; NSW has none
// (AC11). The script empties NSW and WA 2028 and puts the opening hours back to 7:00am - 7:00pm, so every
// sitting starts from the same place.
//
// Sends for real: nothing. Both jobs are written straight in their states (no dispatch email or text goes
// out). The only email in this feature is the Public holidays missing email, which goes to the business inbox
// (ops@idelta.com.au) when the morning check runs for a year with a gap.
//
// Cast records UAT can change: none. UAT changes settings (the hours) and holidays: restoreCast puts the
// hours back and removes every NSW holiday and every WA 2028 holiday the owner entered.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { nextWeekdayAt, todayIn } from "../../time/index.js";

const ZONE = "Australia/Perth";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL = "uat-1020";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };

const KEYS = ["new", "booked"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.platformSettings.updateMany({ data: { openingTime: "07:00", closingTime: "19:00", openingHoursChangedAt: null } });
  await client.publicHoliday.deleteMany({
    where: {
      OR: [
        { state: { not: "WA" } },
        { state: "WA", date: { gte: new Date("2028-01-01T00:00:00.000Z"), lt: new Date("2029-01-01T00:00:00.000Z") } },
        { state: "WA", date: { lt: new Date(`${thisYear()}-01-01T00:00:00.000Z`) } },
      ],
    },
  });
}

function thisYear(): string {
  return todayIn(ZONE).slice(0, 4);
}

/** A past year with one row in it, so the owner can try Remove all (a past year cannot be added to). */
async function ensurePastYearRow(client: PrismaClient): Promise<void> {
  const date = new Date(`${String(Number(thisYear()) - 1)}-01-01T00:00:00.000Z`);
  await client.publicHoliday.upsert({
    where: { state_date: { state: "WA", date } },
    update: {},
    create: { state: "WA", date, name: "New Year's Day" },
  });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  await ensurePastYearRow(client);
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake a job that is gone, or a booked one that was cancelled or moved. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  await ensurePastYearRow(client);
  const need = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
    if (job === null) need.add(key);
    else if (key === "new" && job.status !== "new") need.add(key);
    else if (key === "booked" && job.status !== "scheduled") need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const now = new Date();
  const lines: string[] = [];

  async function newJob(key: Key, status: "new" | "scheduled", preferred: Date, description: string) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "6163",
        serviceLocation: { ...HILTON },
        siteAddress: { street: "12 Paget Street", ...HILTON, postcode: "6163" },
        ...(status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: preferred,
        status,
      },
    });
  }

  if (which.has("new")) {
    const wanted = nextWeekdayAt(ZONE, "wed", 8, 0, new Date(now.getTime() + WEEK_MS));
    const job = await newJob("new", "new", new Date(`${todayIn(ZONE, wanted)}T00:00:00.000Z`), "Leaking mixer tap in the kitchen, still new.");
    lines.push(`${job.reference} - Sarah's leaking-tap job in Hilton, new, wanted ${todayIn(ZONE, wanted)}, ready to dispatch (AC3, AC6)`);
  }

  if (which.has("booked")) {
    // A clear Thursday 3 or more weeks out, 9:00am: step a week on at a time while Bob already has something that day.
    let slot = nextWeekdayAt(ZONE, "thu", 9, 0, new Date(now.getTime() + 3 * WEEK_MS));
    for (let week = 0; week < 12; week += 1) {
      const day = todayIn(ZONE, slot);
      const busy = await client.calendarEvent.count({
        where: { contractorId: bob.id, startTime: { gte: new Date(slot.getTime() - 12 * 3600_000), lt: new Date(slot.getTime() + 12 * 3600_000) } },
      });
      const holiday = await client.publicHoliday.count({ where: { state: "WA", date: new Date(`${day}T00:00:00.000Z`) } });
      if (busy === 0 && holiday === 0) break;
      slot = new Date(slot.getTime() + WEEK_MS);
    }
    const job = await newJob("booked", "scheduled", new Date(`${todayIn(ZONE, slot)}T00:00:00.000Z`), "Leaking mixer tap, booked.");
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job in Hilton, accepted by Bob on ${todayIn(ZONE, slot)} at 9:00am, a clear day (AC4, AC8)`);
  }

  return lines;
}
