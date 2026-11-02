// UAT data for feature 2004, Contractor calendar and Availability.
//
// Fresh jobs, labelled uat-2004 (the cast jobs are never touched; JOB-1042, waiting on Bob, is used as it is):
//   a. Sarah's leaking-tap job, accepted by Bob next Wednesday 10:00am -> a Booked block (AC2, AC6)
//   b. Sarah's second job, dispatched to Bob next Friday 2:00pm, not answered -> a To answer block (AC2, AC6)
//   c. Sarah's third job, a finished visit two days ago at 9:00am -> a Finished block (AC2)
//   d. Sarah's fourth job, in progress today at 9:00am -> an In progress block (AC2)
//   e. Sarah's fifth job, new, to dispatch to Bob (AC12 to AC14)
//   f. Hannah Lee's job in Newtown, accepted by Liam next Tuesday 9:00am Sydney time (AC2)
// Bob, Dave and Liam have NO saved Availability (AC10); the business hours are 7:00am to 7:00pm (AC11 widens them at UAT).
//
// Sends for real: nothing - every job is written straight in its state.
//
// Cast records UAT can change: Bob's, Dave's and Liam's Availability and defaults, and the opening hours. restoreCast puts
// them back (no rows, never saved, hours 7:00am-7:00pm, notice unseen).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { nextWeekdayAt, todayAt, todayIn } from "../../time/index.js";

const PERTH = "Australia/Perth";
const SYDNEY = "Australia/Sydney";
const LABEL = "uat-2004";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const NEWTOWN = { suburb: "Newtown", state: "NSW", country: "AU", lat: -33.897644, lng: 151.180228, placeId: "fixture-place-newtown" };

const KEYS = ["booked", "toanswer", "finished", "inprogress", "new", "liam"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

export async function restoreCast(client: PrismaClient): Promise<void> {
  const codes = ["CON-014", "CON-021", "CON-030", "CON-037"];
  await client.contractorAvailability.deleteMany({ where: { contractor: { code: { in: codes } } } });
  await client.contractor.updateMany({
    where: { code: { in: codes } },
    data: { availabilitySavedAt: null, hoursNoticeSeenAt: null, defaultOpening: "07:00", defaultClosing: "19:00" },
  });
  await client.platformSettings.updateMany({ data: { openingTime: "07:00", closingTime: "19:00", openingHoursChangedAt: null } });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake a job that is gone, a booked/to-answer one that was answered or moved, or the new one once dispatched. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const need = new Set<Key>();
  const wantStatus: Record<Key, string> = { booked: "scheduled", toanswer: "assigned", finished: "completed", inprogress: "in_progress", new: "new", liam: "scheduled" };
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
    if (job === null || job.status !== wantStatus[key]) need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const liam = await client.contractor.findUniqueOrThrow({ where: { code: "CON-037" }, include: { specialties: true } });
  const bobSpecialty = bob.specialties.find((s) => s.trade === "Plumbing");
  const liamSpecialty = liam.specialties.find((s) => s.trade === "Plumbing");
  if (!bobSpecialty || !liamSpecialty) throw new Error("Bob or Liam has no Plumbing specialty");
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const hannah =
    (await client.customer.findUnique({ where: { email: "hannah@idelta.com.au" } })) ??
    (await client.customer.create({ data: { code: await nextReference("CUS", client), name: "Hannah Lee", email: "hannah@idelta.com.au", phone: "0400 001 054" } }));
  const now = new Date();
  const lines: string[] = [];

  async function makeJob(opts: {
    key: Key;
    customerId: string;
    place: typeof HILTON | typeof NEWTOWN;
    postcode: string;
    zone: string;
    status: "new" | "assigned" | "scheduled" | "in_progress" | "completed";
    description: string;
    day: string;
  }) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: opts.customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: opts.postcode,
        serviceLocation: { ...opts.place },
        siteAddress: { street: "12 Paget Street", ...opts.place, postcode: opts.postcode },
        ...(opts.status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: opts.zone,
        description: `${opts.description} ${markerOf(opts.key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${opts.day}T00:00:00.000Z`),
        status: opts.status,
      },
    });
  }

  async function book(
    jobId: string,
    contractor: { id: string },
    specialtyId: string,
    status: "assigned" | "accepted" | "in_progress" | "completed",
    slot: Date,
  ): Promise<void> {
    const assignment = await client.assignment.create({
      data: {
        jobId,
        contractorId: contractor.id,
        specialtyId,
        status,
        proposedSlot: slot,
        ...(status === "assigned" ? {} : { confirmedSlot: slot, acceptedAt: new Date(now.getTime() - 24 * 3600_000) }),
        ...(status === "completed" ? { completedAt: new Date(slot.getTime() + 3600_000) } : {}),
      },
    });
    await client.calendarEvent.create({
      data: { contractorId: contractor.id, type: "job", jobId, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 3600_000) },
    });
  }

  async function freeSlot(from: Date, zone: string, weekday: "mon" | "tue" | "wed" | "thu" | "fri", hour: number, contractorId: string): Promise<Date> {
    let slot = nextWeekdayAt(zone, weekday, hour, 0, from);
    for (let week = 0; week < 10; week += 1) {
      const day = todayIn(zone, slot);
      const busy = await client.calendarEvent.count({ where: { contractorId, startTime: { gte: new Date(slot.getTime() - 3600_000), lt: new Date(slot.getTime() + 2 * 3600_000) } } });
      const holiday = await client.publicHoliday.count({ where: { state: zone === SYDNEY ? "NSW" : "WA", date: new Date(`${day}T00:00:00.000Z`) } });
      if (busy === 0 && holiday === 0) return slot;
      slot = new Date(slot.getTime() + 7 * 86_400_000);
    }
    return slot;
  }

  if (which.has("booked")) {
    const slot = await freeSlot(new Date(now.getTime() + 2 * 86_400_000), PERTH, "wed", 10, bob.id);
    const job = await makeJob({ key: "booked", customerId: sarah.id, place: HILTON, postcode: "6163", zone: PERTH, status: "scheduled", description: "Leaking mixer tap, booked.", day: todayIn(PERTH, slot) });
    await book(job.id, bob, bobSpecialty.id, "accepted", slot);
    lines.push(`${job.reference} - Sarah's leaking-tap job in Hilton, accepted by Bob on ${todayIn(PERTH, slot)} at 10:00am (a Booked block, AC2, AC6)`);
  }
  if (which.has("toanswer")) {
    const slot = await freeSlot(new Date(now.getTime() + 2 * 86_400_000), PERTH, "fri", 14, bob.id);
    const job = await makeJob({ key: "toanswer", customerId: sarah.id, place: HILTON, postcode: "6163", zone: PERTH, status: "assigned", description: "Dripping tap, waiting on Bob.", day: todayIn(PERTH, slot) });
    await book(job.id, bob, bobSpecialty.id, "assigned", slot);
    lines.push(`${job.reference} - Sarah's dripping-tap job, dispatched to Bob for ${todayIn(PERTH, slot)} at 2:00pm and not answered (a To answer block, AC2, AC6)`);
  }
  if (which.has("finished")) {
    const slot = todayAt(PERTH, 9, 0, new Date(now.getTime() - 2 * 86_400_000));
    const job = await makeJob({ key: "finished", customerId: sarah.id, place: HILTON, postcode: "6163", zone: PERTH, status: "completed", description: "Finished visit.", day: todayIn(PERTH, slot) });
    await book(job.id, bob, bobSpecialty.id, "completed", slot);
    lines.push(`${job.reference} - Sarah's finished visit with Bob on ${todayIn(PERTH, slot)} at 9:00am (a Finished block, AC2)`);
  }
  if (which.has("inprogress")) {
    const slot = todayAt(PERTH, 9, 0, now);
    const job = await makeJob({ key: "inprogress", customerId: sarah.id, place: HILTON, postcode: "6163", zone: PERTH, status: "in_progress", description: "Visit under way.", day: todayIn(PERTH, slot) });
    await book(job.id, bob, bobSpecialty.id, "in_progress", slot);
    lines.push(`${job.reference} - Sarah's visit in progress with Bob today at 9:00am (an In progress block, AC2)`);
  }
  if (which.has("new")) {
    const day = todayIn(PERTH, nextWeekdayAt(PERTH, "mon", 8, 0, new Date(now.getTime() + 7 * 86_400_000)));
    const job = await makeJob({ key: "new", customerId: sarah.id, place: HILTON, postcode: "6163", zone: PERTH, status: "new", description: "Leaking tap, still new.", day });
    lines.push(`${job.reference} - Sarah's new job in Hilton, wanted ${day}, to dispatch to Bob (AC12 to AC14)`);
  }
  if (which.has("liam")) {
    const slot = await freeSlot(new Date(now.getTime() + 2 * 86_400_000), SYDNEY, "tue", 9, liam.id);
    const job = await makeJob({ key: "liam", customerId: hannah.id, place: NEWTOWN, postcode: "2042", zone: SYDNEY, status: "scheduled", description: "Blocked sink, booked.", day: todayIn(SYDNEY, slot) });
    await book(job.id, liam, liamSpecialty.id, "accepted", slot);
    lines.push(`${job.reference} - Hannah Lee's blocked-sink job in Newtown, accepted by Liam on ${todayIn(SYDNEY, slot)} at 9:00am Sydney time (AC2)`);
  }
  return lines;
}
