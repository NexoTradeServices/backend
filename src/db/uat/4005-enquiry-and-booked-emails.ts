// UAT data for feature 4005, the Enquiry received email and the Job booked email.
//
// Two fresh jobs of Sarah's (CUS-1050, Hilton), each dispatched to Bob through the real dispatch and
// still waiting for his answer, labelled uat-4005. Fresh jobs, not JOB-1042: the cast job is never
// touched, so there is nothing to put back (the 4006 way).
//   a. A weekday morning, normal level, Lena Park (text and email) as site contact -- the owner accepts
//      it from Bob's Accept link and reads Sarah's Job booked email (AC3) and Lena's copy (AC5, AC7).
//   b. The coming Saturday morning, weekend level, no site contact -- accepted the same way (AC4).
// The Enquiry received emails (AC1, AC2) need no data: the owner submits the web form as Sarah and
// Mike keys a phone job for her; each description the steps type starts "UAT 4005", so the clear
// finds it.
//
// Cast records UAT can change: none. A phone job keyed for Sarah may save a billing address on her
// record only if the steps change it, and they say not to.
//
// Sends for real: the dispatch emails to Bob's cast inbox (bob@idelta.com.au) for the two jobs
// made here; the dispatch texts only reach the Texts sent page (/dev/texts). The steps then send
// Sarah's and Lena's emails to their cast inboxes (sarah@idelta.com.au, lena@idelta.com.au).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { dispatchJob, sendDispatchNotifications } from "../../jobs/dispatch.js";
import { nextWeekdayAt, todayIn } from "../../time/index.js";
import { sweepTestData } from "../../test-data/sweep.js";

const LABEL = "uat-4005";
const MARKER = "UAT 4005";
const ZONE = "Australia/Perth";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };

const KEYS = ["weekday", "saturday"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-4005:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake only a job that has been answered (or is gone). */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: { testData: LABEL, description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
      include: { assignments: { where: { status: "assigned" } } },
    });
    if (job === null || job.status !== "assigned" || job.assignments.length === 0) used.add(key);
  }
  return makeRecords(client, used);
}

/** The jobs the steps told the owner to key start "UAT 4005": label them so the sweep removes them. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.job.updateMany({ where: { description: { startsWith: MARKER, mode: "insensitive" }, testData: null }, data: { testData: LABEL } });
  await sweepTestData(client, LABEL);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const now = new Date();
  const lines: string[] = [];

  async function dispatched(key: Key, weekday: "wed" | "sat", description: string, siteContact?: typeof LENA) {
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "6163",
        serviceLocation: { ...HILTON },
        siteAddress: sarah.billingAddress ?? undefined,
        siteContact,
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status: "new",
      },
    });
    // A free morning for Bob: step a week on at a time, a clash is only a busy answer.
    let result: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (let week = 0; week < 8; week += 1) {
      const day = new Date(nextWeekdayAt(ZONE, weekday, 8, 0, now).getTime() + week * 7 * 24 * 60 * 60_000);
      result = await dispatchJob(client, job.reference, "CON-014", {
        date: todayIn(ZONE, day),
        startMinutes: 480,
        holdMinutes: 60,
        emergency: false,
      });
      if (result.ok || result.status !== 409) break;
    }
    if (result === null || !result.ok) {
      throw new Error(`could not dispatch ${job.reference} to Bob: ${result === null ? "no attempt" : result.error}`);
    }
    await sendDispatchNotifications(client, result);
    return job;
  }

  if (which.has("weekday")) {
    const job = await dispatched("weekday", "wed", "UAT 4005: the kitchen mixer tap is leaking.", LENA);
    lines.push(`${job.reference} - Sarah's leaking-tap job in Hilton, dispatched to Bob for a weekday morning (normal level), Lena Park the site contact, waiting for Bob's answer; his Accept link is in the Texts sent page (/dev/texts)`);
  }
  if (which.has("saturday")) {
    const job = await dispatched("saturday", "sat", "UAT 4005: the laundry tap will not shut off.");
    lines.push(`${job.reference} - Sarah's laundry-tap job in Hilton, dispatched to Bob for the coming Saturday morning (weekend level), waiting for Bob's answer; his Accept link is in the Texts sent page (/dev/texts)`);
  }
  return lines;
}
