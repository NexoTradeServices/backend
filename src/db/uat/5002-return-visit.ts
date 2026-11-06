// UAT data for feature 5002, Return visit.
//
// JOB-1042 (Sarah's mixer tap) is a cast job: this script sets it to "in progress with Bob, no time entered" and the clear
// puts it back as the seed has it (waiting on Bob's answer next Thursday 8:00am). Fresh jobs, labelled uat-5002:
//   a. Sarah's job ON HOLD with Bob, a Reason and a note for the office saved, and a work summary written (AC11, AC12)
//   b. Sarah's job SCHEDULED with a booked time three days ahead and Lena Park as the site contact (AC10)
//   d. Sarah's job IN PROGRESS with Bob today, Lena Park the site contact, no time entered -- for Put on hold from Bob's screen (steps 9)
//   c. A job of Sarah's booked with Bob at 1:00pm next Thursday, with Bob's time from 4:00pm that day switched off (AC7, AC8)
// WA holiday in view for AC7: the next WA public holiday on the calendar is printed with the records.
//
// Sends for real: nothing - every record is written straight in its state. At UAT, Confirm return visit emails and
// texts sarah@idelta.com.au (the cast number for her text), and Put on hold on a booked job emails and texts her and Lena.
//
// Cast records UAT can change: JOB-1042 and its assignment and block. restoreCast puts them back as the fixture seed has them
// (assigned, proposed next Thursday 8:00am Perth, its hold block), and removes Bob's switched-off time on that Thursday.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { nextWeekdayAt, todayAt, todayIn } from "../../time/index.js";

const PERTH = "Australia/Perth";
const LABEL = "uat-5002";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const KEYS = ["onhold", "scheduled", "booked", "today"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

export async function restoreCast(client: PrismaClient): Promise<void> {
  const job = await client.job.findUnique({ where: { reference: "JOB-1042" } });
  if (job === null) return;
  const assignment = await client.assignment.findFirst({ where: { jobId: job.id }, orderBy: { dispatchedAt: "desc" } });
  if (assignment === null) return;
  const slot = nextWeekdayAt(PERTH, "thu", 8, 0, new Date());
  await client.returnReason.deleteMany({ where: { jobId: job.id } });
  await client.assignmentTimeLog.deleteMany({ where: { assignmentId: assignment.id } });
  await client.calendarEvent.deleteMany({ where: { assignmentId: assignment.id } });
  await client.assignment.update({
    where: { id: assignment.id },
    data: { status: "assigned", proposedSlot: slot, confirmedSlot: null, acceptedAt: null, completionNotes: null, cancelledAt: null, cancelledByUserId: null },
  });
  await client.job.update({ where: { id: job.id }, data: { status: "assigned" } });
  await client.calendarEvent.create({
    data: { contractorId: assignment.contractorId, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 3_600_000) },
  });
  // Bob's switched-off time on the Thursday used for AC7 and AC8.
  const thursday = todayIn(PERTH, nextWeekdayAt(PERTH, "thu", 13, 0, new Date()));
  await client.contractorAvailability.deleteMany({ where: { contractor: { code: "CON-014" }, date: new Date(`${thursday}T00:00:00.000Z`) } });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  const lines = await makeRecords(client, new Set(KEYS));
  lines.push(...(await setUpJob1042(client)));
  return lines;
}

/** JOB-1042: in progress with Bob, his visit begun this morning, nothing typed on the screen (AC1 to AC6). */
async function setUpJob1042(client: PrismaClient): Promise<string[]> {
  const job = await client.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
  const assignment = await client.assignment.findFirstOrThrow({ where: { jobId: job.id }, orderBy: { dispatchedAt: "desc" } });
  const began = todayAt(PERTH, 8, 0, new Date());
  await client.calendarEvent.deleteMany({ where: { assignmentId: assignment.id } });
  await client.assignment.update({
    where: { id: assignment.id },
    data: { status: "in_progress", proposedSlot: began, confirmedSlot: began, acceptedAt: new Date(Date.now() - 24 * 3_600_000) },
  });
  await client.job.update({ where: { id: job.id }, data: { status: "in_progress", serviceLevel: "normal" } });
  await client.calendarEvent.create({
    data: { contractorId: assignment.contractorId, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: began, endTime: new Date(began.getTime() + 3_600_000) },
  });
  return ["JOB-1042 - Sarah's mixer tap, in progress with Bob, no time entered today (AC1 to AC6)"];
}

/** Top up: remake a record that is gone or no longer in its starting state; JOB-1042 only when it has left in progress. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const want: Record<Key, string> = { onhold: "on_hold", scheduled: "scheduled", booked: "scheduled", today: "in_progress" };
  const need = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
    if (job === null || job.status !== want[key]) need.add(key);
  }
  const lines = await makeRecords(client, need);
  const job1042 = await client.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
  if (job1042.status !== "in_progress") {
    await restoreCast(client);
    lines.push(...(await setUpJob1042(client)));
  }
  return lines;
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const now = new Date();
  const lines: string[] = [];

  async function makeJob(key: Key, status: "scheduled" | "on_hold" | "in_progress", description: string, day: string, siteContact: boolean) {
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
        ...(siteContact ? { siteContact: { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" } } : {}),
        serviceLevel: "normal",
        timezone: PERTH,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(`${day}T00:00:00.000Z`),
        status,
      },
    });
  }

  async function bookWith(jobId: string, slot: Date | null, status: "accepted" | "in_progress"): Promise<{ id: string }> {
    const assignment = await client.assignment.create({
      data: {
        jobId,
        contractorId: bob.id,
        specialtyId: specialty!.id,
        status,
        proposedSlot: slot ?? new Date(now.getTime() - 2 * 86_400_000),
        confirmedSlot: slot,
        acceptedAt: new Date(now.getTime() - 3 * 86_400_000),
      },
    });
    if (slot !== null) {
      await client.calendarEvent.create({
        data: { contractorId: bob.id, type: "job", jobId, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 3_600_000) },
      });
    }
    return assignment;
  }

  if (which.has("onhold")) {
    const job = await makeJob("onhold", "on_hold", "Mixer tap, waiting on a part.", todayIn(PERTH, now), false);
    const assignment = await bookWith(job.id, null, "accepted");
    const start = new Date(now.getTime() - 2 * 86_400_000);
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: start, endedAt: new Date(start.getTime() + 3_600_000), note: null } });
    await client.assignment.update({ where: { id: assignment.id }, data: { completionNotes: "Stripped the old mixer. The new cartridge is on order." } });
    await client.returnReason.create({
      data: { jobId: job.id, assignmentId: assignment.id, reason: "part_on_order", officeNote: "Supplier says the cartridge arrives Friday.", byUserId: mike.id, at: new Date(now.getTime() - 2 * 86_400_000) },
    });
    lines.push(`${job.reference} - Sarah's mixer-tap job ON HOLD with Bob: Part on order, a note for the office, and a work summary (AC11, AC12)`);
  }
  if (which.has("scheduled")) {
    const slot = nextWeekdayAt(PERTH, "mon", 10, 0, new Date(now.getTime() + 3 * 86_400_000));
    const job = await makeJob("scheduled", "scheduled", "Dripping tap, booked.", todayIn(PERTH, slot), true);
    await bookWith(job.id, slot, "accepted");
    lines.push(`${job.reference} - Sarah's dripping-tap job, SCHEDULED for ${todayIn(PERTH, slot)} at 10:00am with Bob, Lena Park the site contact (AC10)`);
  }
  if (which.has("today")) {
    const began = todayAt(PERTH, 8, 0, now);
    const job = await makeJob("today", "in_progress", "Dripping tap, under way.", todayIn(PERTH, now), true);
    await bookWith(job.id, began, "in_progress");
    lines.push(`${job.reference} - Sarah's dripping-tap job, in progress with Bob today, Lena Park the site contact, no time entered (step 9)`);
  }
  if (which.has("booked")) {
    let thursday = nextWeekdayAt(PERTH, "thu", 13, 0, new Date(now.getTime() + 86_400_000));
    for (let week = 0; week < 8; week += 1) {
      const day = todayIn(PERTH, thursday);
      const holiday = await client.publicHoliday.count({ where: { state: "WA", date: new Date(`${day}T00:00:00.000Z`) } });
      const busy = await client.calendarEvent.count({ where: { contractorId: bob.id, startTime: { gte: new Date(thursday.getTime() - 3_600_000), lt: new Date(thursday.getTime() + 8 * 3_600_000) } } });
      if (holiday === 0 && busy === 0) break;
      thursday = new Date(thursday.getTime() + 7 * 86_400_000);
    }
    const day = todayIn(PERTH, thursday);
    const job = await makeJob("booked", "scheduled", "Leaking trap, booked.", day, false);
    await bookWith(job.id, thursday, "accepted");
    for (let minutes = 16 * 60; minutes < 19 * 60; minutes += 30) {
      await client.contractorAvailability.upsert({
        where: { contractorId_date_startTime: { contractorId: bob.id, date: new Date(`${day}T00:00:00.000Z`), startTime: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 === 0 ? "00" : "30"}` } },
        create: { contractorId: bob.id, date: new Date(`${day}T00:00:00.000Z`), startTime: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 === 0 ? "00" : "30"}`, available: false },
        update: { available: false },
      });
    }
    lines.push(`${job.reference} - Sarah's leaking-trap job booked with Bob on ${day} at 1:00pm, with Bob's time from 4:00pm to 7:00pm that day switched off (AC7, AC8)`);
    const holiday = await client.publicHoliday.findFirst({ where: { state: "WA", date: { gte: new Date(`${todayIn(PERTH, now)}T00:00:00.000Z`) } }, orderBy: { date: "asc" } });
    if (holiday !== null) lines.push(`Next WA public holiday for AC7: ${holiday.name} on ${holiday.date.toISOString().slice(0, 10)}`);
  }
  return lines;
}
