// UAT data for feature 1018, the frontend frame.
//
// What the owner needs to open each frame and each gate:
//   1. Sarah's customer login, so /account can be opened (AC3, AC4): sarah@idelta.com.au with the dev
//      password, a login of her own labelled uat-1018. It is NOT linked to her customer record
//      (CUS-1050): the sweep removes everything that points at a labelled row, and her cast record
//      must never be one of them. Nothing at /account reads the link yet.
//   2. Sarah's leaking-tap job, dispatched to Bob and waiting for his answer, with a live respond link
//      (AC7: the Respond page in the Focused frame). Made through the real dispatch step, so Bob has
//      a job on his dashboard (AC3), but NO message is sent: the link is minted here and printed.
//   3. A DRAFT settlement for Bob awaiting his approval, with a live approve link (AC7: the Approve
//      page). Made by the real sweep over one completed visit; no email is sent, the link is printed.
//      If Bob already holds a draft that is not this feature's (the one-draft rule), that one is used.
// Mike, the owner and Bob's own login are the seeded ones, unchanged; PlatformSettings.operatorPhone is
// already filled in (it cannot be empty), and nothing here changes it. Only cast people are used.
//
// Sends nothing: no email, no text. The two links are printed with the record lines (dev database
// only; they are not written into the feature file).
import type { PrismaClient } from "../client.js";
import { passwordHasher } from "../../auth/dev-password.js";
import { CapabilityTokenType, mintCapabilityLink } from "../../capability-tokens/index.js";
import { issueInvoice } from "../../invoices/issue.js";
import { dispatchJob } from "../../jobs/dispatch.js";
import { addDays, periodFor } from "../../settlements/calendar.js";
import { sweepContractor } from "../../settlements/sweep.js";
import { nextWeekdayAt, todayIn, zonedDateTimeToUtc } from "../../time/index.js";
import { DEV_PASSWORD } from "../seed/auth.js";
import { nextReference } from "../reference.js";

const LABEL = "uat-1018";
const LOGIN_EMAIL = "sarah@idelta.com.au";
const HILTON = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const RESPOND_MARKER = "[uat-1018:respond]";
const APPROVE_MARKER = "[uat-1018:approve]";

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, { login: true, respond: true, approve: true });
}

/**
 * Top up, never wipe: remake only what the owner has used up. The respond job is used up once Bob
 * answered it (accepted or declined) or it was cancelled; the draft once it was approved or replaced.
 * The login is never used up.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const login = (await client.user.findFirst({ where: { email: LOGIN_EMAIL, testData: LABEL } })) === null;

  const respondJob = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: RESPOND_MARKER } },
    orderBy: { createdAt: "desc" },
    include: { assignments: true },
  });
  const respond = respondJob === null || respondJob.status !== "assigned" || !respondJob.assignments.some((a) => a.status === "assigned");

  const approveJob = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: APPROVE_MARKER } },
    orderBy: { createdAt: "desc" },
    include: { assignments: { include: { settlement: true } } },
  });
  const approve = approveJob === null || !approveJob.assignments.some((a) => a.settlement?.status === "draft");

  return makeRecords(client, { login, respond, approve });
}

async function makeRecords(
  client: PrismaClient,
  which: { login: boolean; respond: boolean; approve: boolean },
): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const settings = await client.platformSettings.findFirstOrThrow();
  const zone = settings.timezone;

  async function newJob(status: "new" | "scheduled", description: string) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: HILTON.postcode,
        serviceLocation: { suburb: HILTON.suburb, state: HILTON.state, country: HILTON.country, lat: HILTON.lat, lng: HILTON.lng, placeId: HILTON.placeId },
        siteAddress: HILTON,
        ...(status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: zone,
        description,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  // 1. Sarah's customer login.
  if (which.login) {
    const user = await client.user.create({ data: { name: "Sarah Chen", email: LOGIN_EMAIL, role: "customer" } });
    const hash = await passwordHasher().hash(DEV_PASSWORD);
    await client.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash } });
    lines.push(`${LOGIN_EMAIL} - Sarah Chen's customer login, password ${DEV_PASSWORD}: opens /account (not linked to CUS-1050)`);
  }

  // 2. Sarah's job, dispatched to Bob, waiting: a live respond link.
  if (which.respond) {
    const job = await newJob("new", `UAT 1018: the kitchen mixer tap is leaking from the base. ${RESPOND_MARKER}`);
    // A free weekday morning for Bob: step a week on at a time, a clash is only a busy answer.
    let dispatched: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (let week = 0; week < 8; week += 1) {
      const day = new Date(nextWeekdayAt(zone, "thu", 9, 0, now).getTime() + week * 7 * 24 * 60 * 60_000);
      dispatched = await dispatchJob(client, job.reference, "CON-014", {
        date: todayIn(zone, day),
        startMinutes: 540,
        holdMinutes: 60,
        emergency: false,
      });
      if (dispatched.ok || dispatched.status !== 409) break;
    }
    if (dispatched === null || !dispatched.ok) {
      throw new Error(`could not dispatch Sarah's job to Bob: ${dispatched === null ? "no attempt" : dispatched.error}`);
    }
    const link = await mintCapabilityLink(client, {
      type: CapabilityTokenType.respond,
      assignmentId: dispatched.assignmentId,
      expiresAt: dispatched.proposedSlot.toISOString(),
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job, dispatched to Bob and waiting for his answer (on his dashboard); respond link: ${link.url}`);
  }

  // 3. Bob's draft settlement, awaiting his approval: an approve link.
  if (which.approve) {
    const period = periodFor(settings, now);
    const startsAt = zonedDateTimeToUtc(zone, addDays(period.periodStart, 2), 8, 0);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const job = await newJob("scheduled", `UAT 1018: the bathroom basin tap drips. ${APPROVE_MARKER}`);
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: startsAt, confirmedSlot: startsAt, acceptedAt: startsAt },
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
    const draft = await client.$transaction((tx) =>
      sweepContractor(tx, bob.id, { periodEnd: period.periodEnd, now, onlyLabel: LABEL }),
    );
    const held =
      draft ?? (await client.contractorSettlement.findFirstOrThrow({ where: { contractorId: bob.id, status: "draft" }, select: { id: true, reference: true } }));
    const link = await mintCapabilityLink(client, { type: CapabilityTokenType.approve, settlementId: held.id });
    lines.push(
      `${held.reference} - Bob's DRAFT invoice awaiting his approval${draft === null ? " (a draft Bob already held; this one's job is left beside it)" : ` (${job.reference}, Sarah's basin-tap job, 1.0h)`}; approve link: ${link.url}`,
    );
  }

  return lines;
}
