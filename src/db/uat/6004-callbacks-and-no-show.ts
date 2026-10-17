// UAT data for feature 6004, callbacks and no-shows.
//
// Seven jobs, so the owner can check each part from the pages:
//   A. Sarah's leaking-tap job, completed by Bob and paid -- Raise callback on it (AC1, AC2, AC5).
//   B. A callback on A, dispatched to Bob and accepted (AC3 once completed, AC5, AC6, AC8: no charge).
//   C. A second callback on A, accepted by Bob (AC7: charged).
//   D. Sarah's plumbing job booked for Bob today, accepted -- Mark no-show, charged (AC9, AC10).
//   E. Nina Rossi's plumbing job at Rossi's Cafe booked for Bob today, accepted, Lena Park the site
//      contact -- Mark no-show, waived (AC11, AC12).
//   F. Sarah's electrical job completed by Dave, and G, its callback accepted by Priya (AC5a).
// Nothing is sent when these are made: nothing is dispatched through the real dispatch and no pay
// link is asked for. Only cast people are used: Sarah, Nina, Lena, Bob, Dave and Priya. Nina is made
// here if she is not on file (labelled, so the clear removes her). Nothing changes a cast record, so
// there is no restoreCast.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { issueInvoice } from "../../invoices/issue.js";
import { todayAt } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const SARAHS_SITE = { street: "5 Carrington Street", ...HILTON, postcode: "6163" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const ROSSIS_SITE = { street: "14 Marine Terrace", ...FREMANTLE, postcode: "6160" };

const KEYS = ["a", "b", "c", "d", "e", "f", "g"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-6004:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/**
 * Top up, never wipe: remake only what the owner has used up and leave the rest. A, the two
 * callbacks' original, and F are only read, never used up (a missing one is remade). A callback or
 * a booked job is used up once it has left `scheduled`.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: { testData: "uat-6004", description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
    });
    const wantsStatus = key === "a" || key === "f" ? "completed" : "scheduled";
    if (job === null || job.status !== wantsStatus) used.add(key);
  }
  // A callback needs its original to exist.
  if (used.has("a")) {
    used.add("b");
    used.add("c");
  }
  if (used.has("f")) used.add("g");
  return makeRecords(client, used);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const nina =
    (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
    (await client.customer.create({
      data: {
        code: await nextReference("CUS", client),
        name: "Nina Rossi",
        email: "nina@idelta.com.au",
        phone: "0400 002 060",
        businessName: "Rossi's Cafe",
        billingAddress: { ...ROSSIS_SITE, country: "Australia" },
      },
    }));
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const electrical = await client.serviceType.findUniqueOrThrow({ where: { trade: "Electrical" } });
  const contractor = async (code: string, trade: string) => {
    const row = await client.contractor.findUniqueOrThrow({ where: { code }, include: { specialties: true } });
    const specialty = row.specialties.find((s) => s.trade === trade);
    if (!specialty) throw new Error(`${code} has no ${trade} specialty`);
    return { id: row.id, specialtyId: specialty.id };
  };
  const bob = await contractor("CON-014", "Plumbing");
  const dave = await contractor("CON-021", "Electrical");
  const priya = await contractor("CON-030", "Electrical");
  const now = new Date();
  const lines: string[] = [];

  async function newJob(
    key: Key,
    customer: { id: string },
    serviceTypeId: string,
    rates: { customerCalloutRate: number; customerStandardRate: number },
    description: string,
    status: "scheduled" | "completed",
    extra: { parentJobId?: string; siteContact?: { name: string; phone: string; email: string }; site?: typeof SARAHS_SITE } = {},
  ) {
    const site = extra.site ?? SARAHS_SITE;
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId,
        customerCalloutRate: rates.customerCalloutRate,
        customerStandardRate: rates.customerStandardRate,
        postcode: site.postcode,
        serviceLocation: { suburb: site.suburb, state: site.state, country: site.country, lat: site.lat, lng: site.lng, placeId: site.placeId },
        siteAddress: site,
        ...(extra.siteContact ? { siteContact: extra.siteContact } : {}),
        ...(extra.parentJobId ? { parentJobId: extra.parentJobId, source: "phone" as const } : { source: "web" as const }),
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  /** A finished, invoiced visit (3.0h and a $45 part), paid when asked -- priced by the same step Complete uses. */
  async function completedOriginal(
    key: Key,
    description: string,
    serviceType: typeof plumbing,
    worker: { id: string; specialtyId: string },
    paid: boolean,
  ) {
    const job = await newJob(key, sarah, serviceType.id, serviceType, description, "completed");
    const start = todayAt(ZONE, 8, 0, new Date(now.getTime() - 14 * DAY_MS));
    const end = new Date(start.getTime() + 3 * 60 * 60_000);
    const assignment = await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: worker.id,
        specialtyId: worker.specialtyId,
        status: "accepted",
        proposedSlot: start,
        confirmedSlot: start,
        acceptedAt: start,
        completionNotes: "Replaced the cartridge.\nTested for leaks.",
        billedHours: 3,
      },
    });
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: start, endedAt: end, note: null } });
    const receipt = await client.attachment.create({
      data: { jobId: job.id, assignmentId: assignment.id, uploadedByRole: "contractor", storageKey: "tradeservice/receipts/uat-6004", fileName: "receipt.jpg" },
    });
    await client.assignmentPart.create({
      data: { assignmentId: assignment.id, suppliedBy: "contractor", name: "Tap cartridge", description: "Ceramic", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt.id },
    });
    await client.$transaction(async (tx) => {
      await tx.assignment.update({ where: { id: assignment.id }, data: { completedAt: end, status: "completed" } });
      const invoice = await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [start], billedHours: 3, now: end });
      if (paid) await tx.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: end } });
    });
    return job;
  }

  /** A callback with its booking accepted and a calendar block, ready for the contractor to work. */
  async function acceptedCallback(
    key: Key,
    parent: { id: string },
    serviceType: typeof plumbing,
    worker: { id: string; specialtyId: string },
    slot: Date,
    description: string,
  ) {
    const job = await newJob(key, sarah, serviceType.id, serviceType, description, "scheduled", { parentJobId: parent.id });
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: worker.id, specialtyId: worker.specialtyId, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: worker.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    return job;
  }

  /** A booked job for Bob today, accepted, with its calendar block. */
  async function bookedToday(
    key: Key,
    customer: { id: string },
    description: string,
    hour: number,
    extra: Parameters<typeof newJob>[6] = {},
  ) {
    const job = await newJob(key, customer, plumbing.id, plumbing, description, "scheduled", extra);
    const slot = todayAt(ZONE, hour, 0, now);
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: bob.specialtyId, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    return job;
  }

  async function existing(key: Key) {
    return client.job.findFirst({
      where: { testData: "uat-6004", description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
    });
  }

  let a = which.has("a") ? null : await existing("a");
  if (which.has("a") || a === null) {
    a = await completedOriginal("a", "The mixer tap in the kitchen leaks.", plumbing, bob, true);
    lines.push(`${a.reference} - Sarah's leaking-tap job, completed by Bob and paid -- raise a callback on it`);
  }
  if (which.has("b")) {
    const b = await acceptedCallback("b", a, plumbing, bob, new Date(todayAt(ZONE, 9, 0, now).getTime() + 2 * DAY_MS), "The tap is dripping again.");
    lines.push(`${b.reference} - a callback on ${a.reference}, accepted by Bob -- pick "Fixing earlier work - no charge", complete it, then raise a callback from it`);
  }
  if (which.has("c")) {
    const c = await acceptedCallback("c", a, plumbing, bob, new Date(todayAt(ZONE, 13, 0, now).getTime() + 2 * DAY_MS), "Water is also pooling under the sink.");
    lines.push(`${c.reference} - a second callback on ${a.reference}, accepted by Bob -- pick "New fault - charged" and complete it`);
  }
  if (which.has("d")) {
    const d = await bookedToday("d", sarah, "The outdoor tap will not turn off.", 8);
    lines.push(`${d.reference} - Sarah's plumbing job booked for Bob today, accepted -- mark it a no-show, charged`);
  }
  if (which.has("e")) {
    const e = await bookedToday("e", nina, "The cafe's hand basin is blocked.", 10, {
      site: ROSSIS_SITE,
      siteContact: { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" },
    });
    lines.push(`${e.reference} - Nina Rossi's plumbing job at Rossi's Cafe booked for Bob today, accepted, Lena Park the site contact -- mark it a no-show, waived`);
  }
  let f = which.has("f") ? null : await existing("f");
  if (which.has("f") || f === null) {
    f = await completedOriginal("f", "The kitchen power point sparks.", electrical, dave, true);
    lines.push(`${f.reference} - Sarah's electrical job, completed by Dave`);
  }
  if (which.has("g")) {
    const g = await acceptedCallback("g", f, electrical, priya, new Date(todayAt(ZONE, 11, 0, now).getTime() + 3 * DAY_MS), "The power point is warm again.");
    lines.push(`${g.reference} - a callback on ${f.reference}, accepted by Priya -- Priya opens the original Dave did`);
  }
  return lines;
}
