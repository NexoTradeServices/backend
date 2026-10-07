// UAT data for feature 5001, the contractor job screen and Complete.
//
// All Bob's, Plumbing. Four jobs, so the owner can check each part of the
// screen from a starting state:
//   1. Sarah's leaking-tap job in Hilton, Lena Park as site contact, one
//      Instruction note and one General note, accepted by Bob for today.
//   2. Sarah's second job, in progress, with two saved time entries typed in
//      reverse order and one part with a receipt.
//   3. Sarah's third job, already completed through the screen.
//   4. Tom's job, dispatched to Bob and not yet answered -- the card that does
//      not open.
// Only cast people are used: Sarah, Tom, Lena, Mike and Bob. Nothing changes a
// cast record, so there is no restoreCast. The receipt photos are labels only
// (nothing is uploaded to Cloudinary), so their thumbnails read as broken
// pictures -- the owner picks a real photo in the screen's own steps.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { todayAt } from "../../time/index.js";

const ZONE = "Australia/Perth";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const DAY_MS = 24 * 60 * 60 * 1000;

export async function make(client: PrismaClient): Promise<string[]> {
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  async function newJob(
    customer: { id: string; billingAddress: unknown },
    status: "scheduled" | "in_progress" | "completed" | "assigned",
    description: string,
    extra: { siteContact?: { name: string; phone: string }; operatorNotes?: unknown[] } = {},
  ) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "6163",
        serviceLocation: { ...HILTON },
        siteAddress: customer.billingAddress === null ? undefined : (customer.billingAddress as object),
        siteContact: extra.siteContact,
        serviceLevel: "normal",
        timezone: ZONE,
        description,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status,
        operatorNotes: extra.operatorNotes as never,
      },
    });
  }

  async function receiptFor(jobId: string, assignmentId: string, name: string) {
    return client.attachment.create({
      data: { jobId, assignmentId, uploadedByRole: "contractor", storageKey: `tradeservice/receipts/uat-5001-${name}`, fileName: `${name}.jpg` },
    });
  }

  // 1. Sarah's leaking tap, accepted for today.
  const slot1 = todayAt(ZONE, 10, 0, now);
  const job1 = await newJob(sarah, "scheduled", "UAT 5001: the kitchen mixer tap is leaking from the base.", {
    siteContact: { name: "Lena Park", phone: "0400 002 050" },
    operatorNotes: [
      { id: randomUUID(), at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), operatorId: mike.id, type: "instruction", note: "Side gate code 4471" },
      { id: randomUUID(), at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), operatorId: mike.id, type: "general", note: "Sarah pays by card" },
    ],
  });
  await client.assignment.create({
    data: { jobId: job1.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot1, confirmedSlot: slot1, acceptedAt: now },
  });
  lines.push(`${job1.reference} - Sarah's leaking-tap job in Hilton, Lena Park the site contact, an Instruction note and a General note, accepted by Bob for today`);

  // 2. Sarah's second job, in progress, two entries typed in reverse order and a part with a receipt.
  const slot2 = new Date(todayAt(ZONE, 8, 0, now).getTime() - 2 * DAY_MS);
  const job2 = await newJob(sarah, "in_progress", "UAT 5001: the bathroom basin drains slowly.");
  const assignment2 = await client.assignment.create({
    data: { jobId: job2.id, contractorId: bob.id, specialtyId: specialty.id, status: "in_progress", proposedSlot: slot2, confirmedSlot: slot2, acceptedAt: now },
  });
  const returnDay = todayAt(ZONE, 9, 0, new Date(now.getTime() - DAY_MS));
  // The return visit first, then the first visit: typed in reverse order.
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment2.id, startedAt: returnDay, endedAt: new Date(returnDay.getTime() + 20 * 60_000), note: "Back for the washer" },
  });
  const firstStart = new Date(slot2.getTime() + 7 * 60_000);
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment2.id, startedAt: firstStart, endedAt: new Date(firstStart.getTime() + 178 * 60_000), note: null },
  });
  const receipt2 = await receiptFor(job2.id, assignment2.id, "basin-trap");
  await client.assignmentPart.create({
    data: { assignmentId: assignment2.id, suppliedBy: "contractor", name: "Basin trap", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt2.id },
  });
  lines.push(`${job2.reference} - Sarah's basin job, in progress: two saved time entries (typed in reverse order) and one part, a basin trap with its receipt`);

  // 3. Sarah's third job, already completed through the screen.
  const slot3 = new Date(todayAt(ZONE, 9, 0, now).getTime() - DAY_MS);
  const job3 = await newJob(sarah, "completed", "UAT 5001: the outdoor tap will not turn off.");
  const assignment3 = await client.assignment.create({
    data: {
      jobId: job3.id,
      contractorId: bob.id,
      specialtyId: specialty.id,
      status: "completed",
      proposedSlot: slot3,
      confirmedSlot: slot3,
      acceptedAt: now,
      completionNotes: "Replaced the tap washer and tested the line.",
      billedHours: 1,
      completedAt: new Date(slot3.getTime() + 60 * 60_000),
    },
  });
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment3.id, startedAt: slot3, endedAt: new Date(slot3.getTime() + 45 * 60_000), note: null },
  });
  const receipt3 = await receiptFor(job3.id, assignment3.id, "tap-washer");
  await client.assignmentPart.create({
    data: { assignmentId: assignment3.id, suppliedBy: "contractor", name: "Tap washer", qty: 2, unitPrice: 300, lineTotal: 600, receiptAttachmentId: receipt3.id },
  });
  lines.push(`${job3.reference} - Sarah's outdoor-tap job, already completed: one entry (45 minutes, billed 1.0h), notes and one part -- every field locked`);

  // 4. Tom's job, dispatched to Bob and not yet answered.
  const slot4 = todayAt(ZONE, 9, 0, new Date(now.getTime() + DAY_MS));
  const job4 = await newJob(tom, "assigned", "UAT 5001: a blocked kitchen sink.");
  await client.assignment.create({
    data: { jobId: job4.id, contractorId: bob.id, specialtyId: specialty.id, status: "assigned", proposedSlot: slot4 },
  });
  lines.push(`${job4.reference} - Tom's job, dispatched to Bob and not yet answered -- its dashboard card does not open`);

  return lines;
}
