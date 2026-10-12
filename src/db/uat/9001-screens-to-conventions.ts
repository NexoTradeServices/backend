// UAT data for feature 9001, built screens brought to the frontend conventions.
//
// What the owner needs to see the new look and the new dates:
//   1. Sarah's leaking-tap job, dispatched to Bob and waiting for his answer, with a live respond
//      link (AC4 the titles, AC8 the hairline borders). Made by the real dispatch; on Bob's
//      dashboard as the later-this-week job (AC3).
//   2. A second job of Sarah's, dispatched to Bob and ALREADY ACCEPTED, so its respond link reads
//      "Already answered" in the Message card (AC5).
//   3. Sarah's closed job completed on 9 Sep 2025, and one completed three days ago: the job
//      queue's Closed list shows the first with its year and the second without (AC2).
//   4. A job of Sarah's for today, accepted by Bob: "Today, 5:00pm AWST" on his dashboard (AC3).
//   5. Bob's DRAFT settlement awaiting his approval, with a live approve link (AC4), and the
//      customer invoice its job made, issued with its PDF carrying Issued and Due dates (AC1).
//   6. A contractor agreement, issued 1 Sep 2026 and accepted by Bob, Dave and Priya on 9 Sep 2026
//      (AC1). No stamped record file exists in dev, so the acceptance record's PDF button has
//      nothing behind it; the dates read on Bob's agreement page and the ops record's card.
//   7. Dave's Electrical licence expiring in two days and a new Electrical job of Sarah's to
//      dispatch to a slot after that: the licence reason reads "expires 14 Sep 2026, before this
//      slot" (AC3).
// Only cast people are used. make() changes three cast records (the three contractors' agreement
// answer, Dave's Electrical licence date); restoreCast() puts them back as the seed has them.
//
// Sends nothing: no email, no text. The links are printed with the record lines (dev database
// only; they are not written into the feature file).
import type { PrismaClient } from "../client.js";
import { CapabilityTokenType, mintCapabilityLink } from "../../capability-tokens/index.js";
import { issueInvoice } from "../../invoices/issue.js";
import { dispatchJob } from "../../jobs/dispatch.js";
import { acceptAssignment } from "../../respond/service.js";
import { addDays, periodFor } from "../../settlements/calendar.js";
import { sweepContractor } from "../../settlements/sweep.js";
import { formatDate, nextWeekdayAt, todayAt, todayIn, zonedDateTimeToUtc } from "../../time/index.js";
import { nextReference } from "../reference.js";

const LABEL = "uat-9001";
const HILTON = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const CAST_CODES = ["CON-014", "CON-021", "CON-030"] as const;
/** Dave's Electrical licence as the seed has it. */
const DAVE_LICENCE_SEED = new Date("2027-06-30T00:00:00.000Z");

const markerOf = (key: string): string => `[uat-9001:${key}]`;

export async function restoreCast(client: PrismaClient): Promise<void> {
  for (const code of CAST_CODES) {
    await client.contractor.update({ where: { code }, data: { agreementVersion: null, agreementAcceptedAt: null } });
  }
  const dave = await client.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
  await client.contractorSpecialty.updateMany({ where: { contractorId: dave.id, trade: "Electrical" }, data: { licenceExpiry: DAVE_LICENCE_SEED } });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(["respond", "answered", "closed", "today", "draft", "agreement", "licence"]));
}

/**
 * Top up, never wipe: remake only what the owner has used up. The respond job is used up once Bob
 * answered it or it was cancelled; the draft once it was approved or replaced; Dave's licence job
 * once it was dispatched; today's job once the day has rolled over (its slot is no longer today).
 * The static records (the closed jobs, the answered link, the agreement) are never used up.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<string>();

  const respond = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: markerOf("respond") } },
    orderBy: { createdAt: "desc" },
    include: { assignments: true },
  });
  if (respond === null || respond.status !== "assigned" || !respond.assignments.some((a) => a.status === "assigned")) used.add("respond");

  const draftJob = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: markerOf("draft") } },
    orderBy: { createdAt: "desc" },
    include: { assignments: { include: { settlement: true } } },
  });
  if (draftJob === null || !draftJob.assignments.some((a) => a.settlement?.status === "draft")) used.add("draft");

  const licenceJob = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: markerOf("licence") } },
    orderBy: { createdAt: "desc" },
  });
  if (licenceJob === null || licenceJob.status !== "new") used.add("licence");

  const todayJob = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: markerOf("today") } },
    orderBy: { createdAt: "desc" },
    include: { assignments: true },
  });
  const zone = (await client.platformSettings.findFirstOrThrow()).timezone;
  const todaySlot = todayAt(zone, 17, 0, new Date()).getTime();
  if (todayJob === null || !todayJob.assignments.some((a) => a.status === "accepted" && a.confirmedSlot?.getTime() === todaySlot)) {
    used.add("today");
  }

  return makeRecords(client, used);
}

async function makeRecords(client: PrismaClient, which: Set<string>): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();
  const settings = await client.platformSettings.findFirstOrThrow();
  const zone = settings.timezone;
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const electrical = await client.serviceType.findUniqueOrThrow({ where: { trade: "Electrical" } });
  const bobPlumbing = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!bobPlumbing) throw new Error("Bob has no Plumbing specialty");

  async function newJob(
    key: string,
    trade: typeof plumbing,
    status: "new" | "scheduled" | "completed",
    description: string,
  ) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: trade.id,
        customerCalloutRate: trade.customerCalloutRate,
        customerStandardRate: trade.customerStandardRate,
        postcode: HILTON.postcode,
        serviceLocation: { suburb: HILTON.suburb, state: HILTON.state, country: HILTON.country, lat: HILTON.lat, lng: HILTON.lng, placeId: HILTON.placeId },
        siteAddress: HILTON,
        ...(status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: zone,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  /** Dispatch to Bob on a free weekday morning: step a week on at a time, a clash is only a busy answer. */
  async function dispatchToBob(reference: string, weekday: "mon" | "tue" | "wed" | "thu" | "fri", startHour: number) {
    let result: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (let week = 0; week < 8; week += 1) {
      const day = new Date(nextWeekdayAt(zone, weekday, startHour, 0, now).getTime() + week * 7 * 24 * 60 * 60_000);
      result = await dispatchJob(client, reference, "CON-014", {
        date: todayIn(zone, day),
        startMinutes: startHour * 60,
        holdMinutes: 60,
        emergency: false,
      });
      if (result.ok || result.status !== 409) break;
    }
    if (result === null || !result.ok) {
      throw new Error(`could not dispatch ${reference} to Bob: ${result === null ? "no attempt" : result.error}`);
    }
    return result;
  }

  // 1. The respond job, waiting for Bob: a live respond link.
  if (which.has("respond")) {
    const job = await newJob("respond", plumbing, "new", "UAT 9001: the kitchen mixer tap is leaking from the base.");
    const dispatched = await dispatchToBob(job.reference, "thu", 9);
    const link = await mintCapabilityLink(client, {
      type: CapabilityTokenType.respond,
      assignmentId: dispatched.assignmentId,
      expiresAt: dispatched.proposedSlot.toISOString(),
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job, dispatched to Bob and waiting for his answer (on his dashboard); respond link: ${link.url}`);
  }

  // 2. A second job, already accepted: its respond link reads "Already answered".
  if (which.has("answered")) {
    const job = await newJob("answered", plumbing, "new", "UAT 9001: the laundry tap needs a new washer.");
    const dispatched = await dispatchToBob(job.reference, "wed", 13);
    const link = await mintCapabilityLink(client, {
      type: CapabilityTokenType.respond,
      assignmentId: dispatched.assignmentId,
      expiresAt: dispatched.proposedSlot.toISOString(),
    });
    const rawToken = link.url.slice(link.url.lastIndexOf("/") + 1);
    const answer = await acceptAssignment(client, rawToken, now);
    if (!answer.ok) throw new Error(`could not accept ${job.reference} for Bob`);
    lines.push(`${job.reference} - Sarah's laundry-tap job, accepted by Bob (on his dashboard later this week); its respond link, already answered: ${link.url}`);
  }

  // 3. Closed jobs: one from last year, one three days ago.
  if (which.has("closed")) {
    async function closedJob(key: string, description: string, completedAt: Date) {
      const job = await newJob(key, plumbing, "completed", description);
      const startsAt = new Date(completedAt.getTime() - 60 * 60_000);
      await client.assignment.create({
        data: {
          jobId: job.id,
          contractorId: bob.id,
          specialtyId: bobPlumbing!.id,
          status: "completed",
          proposedSlot: startsAt,
          confirmedSlot: startsAt,
          acceptedAt: startsAt,
          completedAt,
          billedHours: 1,
          completionNotes: "Done and tested.",
        },
      });
      return job;
    }
    const lastYear = await closedJob("closed-2025", "UAT 9001: the bathroom basin tap drips.", new Date("2025-09-09T04:00:00.000Z"));
    const recent = await closedJob("closed-recent", "UAT 9001: the toilet cistern keeps running.", new Date(now.getTime() - 3 * 24 * 60 * 60_000));
    lines.push(`${lastYear.reference} - Sarah's basin-tap job, completed 9 Sep 2025: Closed on the job queue shows it WITH its year`);
    lines.push(`${recent.reference} - Sarah's cistern job, completed three days ago: Closed on the job queue shows it WITHOUT a year`);
  }

  // 4. Today's job on Bob's dashboard.
  if (which.has("today")) {
    const job = await newJob("today", plumbing, "scheduled", "UAT 9001: the outside tap is dripping.");
    const slot = todayAt(zone, 17, 0, now);
    await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: bobPlumbing.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    lines.push(`${job.reference} - Sarah's outside-tap job, accepted by Bob for today 5:00pm: "Today, 5:00pm AWST" on his dashboard`);
  }

  // 5. Bob's draft settlement and the customer invoice its job made.
  if (which.has("draft")) {
    const period = periodFor(settings, now);
    const startsAt = zonedDateTimeToUtc(zone, addDays(period.periodStart, 2), 8, 0);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const job = await newJob("draft", plumbing, "scheduled", "UAT 9001: the garden tap will not turn off.");
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: bobPlumbing.id, status: "accepted", proposedSlot: startsAt, confirmedSlot: startsAt, acceptedAt: startsAt },
    });
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: startsAt, endedAt: endsAt, note: null } });
    await client.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { completionNotes: "Done and tested.", billedHours: 1, completedAt: endsAt, status: "completed" },
      });
      await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
      await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [startsAt], billedHours: 1, now: endsAt });
    });
    const invoice = await client.invoice.findFirstOrThrow({ where: { assignmentId: assignment.id }, select: { reference: true } });
    const draft = await client.$transaction((tx) => sweepContractor(tx, bob.id, { periodEnd: period.periodEnd, now, onlyLabel: LABEL }));
    const held =
      draft ?? (await client.contractorSettlement.findFirstOrThrow({ where: { contractorId: bob.id, status: "draft" }, select: { id: true, reference: true } }));
    const link = await mintCapabilityLink(client, { type: CapabilityTokenType.approve, settlementId: held.id });
    lines.push(
      `${held.reference} - Bob's DRAFT invoice awaiting his approval${draft === null ? " (a draft Bob already held; this one's job is left beside it)" : ` (${job.reference}, Sarah's garden-tap job, 1.0h)`}; approve link: ${link.url}`,
    );
    lines.push(`${invoice.reference} - the customer invoice for ${job.reference}, issued with its PDF: Issued and Due dates in "9 Sep 2026" style (Mike: the job page's Invoice card)`);
  }

  // 6. The agreement, accepted by the three contractors.
  if (which.has("agreement")) {
    const versions = await client.contractorAgreementVersion.findMany({ select: { version: true } });
    const next = String(Math.max(0, ...versions.map((v) => Number(v.version)).filter((n) => Number.isFinite(n))) + 1);
    const version = await client.contractorAgreementVersion.create({
      data: {
        version: next,
        storageKey: "tradeservice/agreements/uat-9001",
        documentHash: "0".repeat(64),
        issuedAt: new Date("2026-09-01T02:00:00.000Z"),
        issuedByUserId: mike.id,
      },
    });
    const acceptedAt = new Date("2026-09-09T04:00:00.000Z");
    for (const code of CAST_CODES) {
      const contractor = await client.contractor.findUniqueOrThrow({ where: { code } });
      await client.contractorAgreementAcceptance.create({
        data: { contractorId: contractor.id, agreementVersionId: version.id, acceptedAt, acceptedFromIp: "203.0.113.7", userAgent: "UAT 9001" },
      });
      await client.contractor.update({ where: { code }, data: { agreementVersion: version.version, agreementAcceptedAt: acceptedAt } });
    }
    lines.push(`Agreement version ${version.version} - issued 1 Sep 2026, accepted by Bob, Dave and Priya on 9 Sep 2026 (Bob: /contractor/agreement; Mike: Bob's record)`);
  }

  // 7. Dave's licence expiring before a test slot, and an Electrical job to dispatch.
  if (which.has("licence")) {
    const dave = await client.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    const expiry = new Date(`${addDays(todayIn(zone, now), 2)}T00:00:00.000Z`);
    await client.contractorSpecialty.updateMany({ where: { contractorId: dave.id, trade: "Electrical" }, data: { licenceExpiry: expiry } });
    const job = await newJob("licence", electrical, "new", "UAT 9001: the hallway lights flicker.");
    lines.push(
      `${job.reference} - Sarah's hallway-lights job (Electrical, new): open Dispatch and pick a slot 3 or more days away -- Dave's Electrical licence expires ${formatDate("UTC", expiry)}, so his row is greyed with "Electrical licence expires <date>, before this slot"`,
    );
  }

  return lines;
}
