// UAT data for feature 7004, the Job tomorrow reminder.
//
// Three fresh jobs, all Bob's, Plumbing, labelled uat-7004. Fresh jobs, not JOB-1042: the cast job is
// never touched, so there is nothing to put back (the 4005 and 5004 way).
//   a. Sarah's leaking-tap job at 12 Paget Street, Hilton, Lena Park (text and email) as site contact,
//      accepted by Bob at 4:00pm yesterday for tomorrow 9:00am -- the morning run sends Sarah's and
//      Lena's reminders (AC1, AC2). No message is sent while this job is made (it is written straight
//      in its accepted state, as 5004's are).
//   b. Nina Rossi's job at Rossi's Cafe, Fremantle, dispatched to Bob for the day after tomorrow at
//      9:00am and not yet answered -- Bob accepts it and the Job booked email says a reminder is
//      coming (AC9).
//   c. Tom's job in Kalamunda, dispatched to Bob for later today and not yet answered -- Bob accepts it:
//      no reminder line (AC9) and no reminder ever comes (AC4).
//
// Sends for real: the dispatch emails to Bob's cast inbox (bob@idelta.com.au) for b and c; the dispatch
// texts only reach the Texts sent page (/dev/texts). The steps then send Sarah's and Lena's emails
// (reminder, then Job booked) and Nina's and Tom's Job booked emails to their cast inboxes. The
// reminders go out when the morning run is next due (at or after 9:00am Perth, within five minutes of
// the dev site running) or when the implementer runs the step at the start of the sitting.
//
// Cast records UAT can change: none (Nina is made here, with the label, if the 5004 script has not).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { dispatchJob, sendDispatchNotifications } from "../../jobs/dispatch.js";
import { todayAt, todayIn } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL = "uat-7004";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };
const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };

const KEYS = ["sarah", "nina", "tom"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[${LABEL}:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake a job that is gone, and a dispatched one that has been answered. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const need = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: { testData: LABEL, description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
      include: { assignments: { where: { status: "assigned" } } },
    });
    if (job === null) need.add(key);
    else if (key !== "sarah" && (job.status !== "assigned" || job.assignments.length === 0)) need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  async function newJob(opts: {
    key: Key;
    customerId: string;
    location: object;
    street?: string;
    postcode: string;
    description: string;
    siteContact?: typeof LENA;
    slot: Date;
  }) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: opts.customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: opts.postcode,
        serviceLocation: { ...opts.location },
        ...(opts.street === undefined ? {} : { siteAddress: { street: opts.street, ...opts.location, postcode: opts.postcode } }),
        siteContact: opts.siteContact,
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${opts.description} ${markerOf(opts.key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: opts.slot,
        status: "new",
      },
    });
  }

  /** Dispatched through the real dispatch, still waiting for Bob's answer. Tries each start in turn: a clash or a past time is only a refusal. */
  async function dispatched(job: { reference: string }, date: string, startsMinutes: number[]): Promise<void> {
    let result: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (const startMinutes of startsMinutes) {
      result = await dispatchJob(client, job.reference, "CON-014", { date, startMinutes, holdMinutes: 60, emergency: false });
      if (result.ok) break;
    }
    if (result === null || !result.ok) {
      throw new Error(`could not dispatch ${job.reference} to Bob: ${result === null ? "no attempt" : result.error}`);
    }
    await sendDispatchNotifications(client, result);
  }

  if (which.has("sarah")) {
    const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const slot = todayAt(ZONE, 9, 0, new Date(now.getTime() + DAY_MS));
    const job = await newJob({
      key: "sarah",
      customerId: sarah.id,
      location: HILTON,
      street: "12 Paget Street",
      postcode: "6163",
      description: "UAT 7004: the kitchen mixer tap is leaking.",
      siteContact: LENA,
      slot,
    });
    await client.job.update({ where: { id: job.id }, data: { status: "scheduled" } });
    const assignment = await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bob.id,
        specialtyId: specialty.id,
        status: "accepted",
        proposedSlot: slot,
        confirmedSlot: slot,
        dispatchedAt: todayAt(ZONE, 15, 0, new Date(now.getTime() - DAY_MS)),
        acceptedAt: todayAt(ZONE, 16, 0, new Date(now.getTime() - DAY_MS)),
      },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job at 12 Paget Street, Hilton, accepted by Bob yesterday at 4:00pm for tomorrow at 9:00am, Lena Park the site contact (text and email)`);
  }
  if (which.has("nina")) {
    const nina =
      (await client.customer.findFirst({ where: { email: "nina@idelta.com.au" } })) ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "Rossi's Cafe" },
      }));
    const job = await newJob({
      key: "nina",
      customerId: nina.id,
      location: FREMANTLE,
      street: "1 High Street",
      postcode: "6160",
      description: "UAT 7004: the cafe's hand basin drips.",
      slot: now,
    });
    await dispatched(job, todayIn(ZONE, new Date(now.getTime() + 2 * DAY_MS)), [540, 600, 660, 720]);
    lines.push(`${job.reference} - Nina Rossi's job at Rossi's Cafe, Fremantle, dispatched to Bob for the day after tomorrow at 9:00am and not yet answered; Bob's Accept link is in the Texts sent page (/dev/texts)`);
  }
  if (which.has("tom")) {
    const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
    const job = await newJob({
      key: "tom",
      customerId: tom.id,
      location: KALAMUNDA,
      street: "9 Railway Road",
      postcode: "6076",
      description: "UAT 7004: a blocked kitchen sink.",
      slot: now,
    });
    await dispatched(job, todayIn(ZONE, now), [1260, 1230, 1200, 1140, 1080, 1020]);
    lines.push(`${job.reference} - Tom's job in Kalamunda, dispatched to Bob for later today and not yet answered; Bob's Accept link is in the Texts sent page (/dev/texts)`);
  }
  return lines;
}
