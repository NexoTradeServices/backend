// UAT data for feature 1022, Time zones.
//
// Two fresh Sydney jobs, both Hannah Lee's (the Sydney happy path, a guest; made by the fixtures command) in Newtown
// 2042, Plumbing, labelled uat-1022. The cast jobs are never touched (JOB-1042 is Sarah's Perth example for AC2 and AC11).
//   a. Hannah's blocked-sink job, accepted by Liam, with the visit TOMORROW at 9:00am Sydney time and the booking confirmed
//      yesterday midday - the one the reminder is shown on (AC1, AC2, AC5). The reminder is not sent while this is made.
//   b. Hannah's second job, new, with no booking yet - to dispatch to Liam on the dispatch page (AC8, AC9).
//
// Sends for real: nothing while the script runs (both jobs are written straight in their states). The steps then send
// the reminder email and text to Hannah (hannah@idelta.com.au) when the implementer runs the reminder pass with a set time.
//
// Cast records UAT can change: none (Liam and Sarah's job are only read; the dispatch UAT makes uses up job b, which the
// top-up remakes).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { todayIn, zonedDateTimeToUtc } from "../../time/index.js";

const SYDNEY = "Australia/Sydney";
const LABEL = "uat-1022";
const NEWTOWN = { suburb: "Newtown", state: "NSW", country: "AU", lat: -33.897644, lng: 151.180228, placeId: "fixture-place-newtown" };

const KEYS = ["tomorrow", "new"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake a job that is gone, or a booked one that was cancelled, or the new one once dispatched. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const need = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
    if (job === null) need.add(key);
    else if (key === "new" && job.status !== "new") need.add(key);
    else if (key === "tomorrow" && job.status !== "scheduled") need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const liam = await client.contractor.findUniqueOrThrow({ where: { code: "CON-037" }, include: { specialties: true } });
  const specialty = liam.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Liam has no Plumbing specialty");
  const hannah =
    (await client.customer.findUnique({ where: { email: "hannah@idelta.com.au" } })) ??
    (await client.customer.create({
      data: { code: await nextReference("CUS", client), name: "Hannah Lee", email: "hannah@idelta.com.au", phone: "0400 001 054" },
    }));
  const now = new Date();
  const today = todayIn(SYDNEY, now);
  const lines: string[] = [];

  async function newJob(key: Key, status: "new" | "scheduled", day: string, description: string) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: hannah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "2042",
        serviceLocation: { ...NEWTOWN },
        siteAddress: { street: "30 King Street", ...NEWTOWN, postcode: "2042" },
        ...(status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: SYDNEY,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${day}T00:00:00.000Z`),
        status,
      },
    });
  }

  if (which.has("tomorrow")) {
    const day = addDays(today, 1);
    const slot = zonedDateTimeToUtc(SYDNEY, day, 9, 0);
    const job = await newJob("tomorrow", "scheduled", day, "Blocked kitchen sink, booked for tomorrow.");
    const confirmed = zonedDateTimeToUtc(SYDNEY, addDays(today, -1), 12, 0);
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: liam.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: confirmed },
    });
    await client.calendarEvent.create({
      data: { contractorId: liam.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    lines.push(`${job.reference} - Hannah Lee's blocked-sink job in Newtown, accepted by Liam for tomorrow (${day}) at 9:00am Sydney time (AC1, AC2, AC5)`);
  }

  if (which.has("new")) {
    // A weekday a week out, so a Sydney date that is not a public holiday is easy to find.
    let day = addDays(today, 7);
    for (let i = 0; i < 7; i += 1) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      const holiday = await client.publicHoliday.count({ where: { state: "NSW", date: new Date(`${day}T00:00:00.000Z`) } });
      if (weekday >= 1 && weekday <= 5 && holiday === 0) break;
      day = addDays(day, 1);
    }
    const job = await newJob("new", "new", day, "Leaking hot-water tap, still new.");
    lines.push(`${job.reference} - Hannah Lee's leaking-tap job in Newtown, new, wanted ${day}, ready to dispatch to Liam (AC8, AC9)`);
  }

  return lines;
}
