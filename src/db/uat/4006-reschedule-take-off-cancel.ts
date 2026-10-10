// UAT data for feature 4006, reschedule / take off / cancel.
//
// Five starting states, so the owner can check each action from the page:
//   1. Sarah's leaking-tap job in Hilton, accepted by Bob for a weekday morning, Lena Park (text
//      and email) as site contact -- Reschedule, Take off and Cancel job all work on it, and Lena
//      is told on a cancel. A fresh job of Sarah's, not JOB-1042: the cast job is never touched,
//      so a cancel here leaves nothing to put back.
//   2. Tom's plumbing job, dispatched to Bob and still waiting for his answer, its Accept link in
//      the interim Texts sent page (/dev/texts). Made through the real dispatch, so Bob's email
//      and text are real messages.
//   3. Margaret's new job in Applecross, no contractor, and a second copy of it to cancel as a
//      duplicate.
//   4. Karl's new job in Joondalup, nobody covering -- cancel with "Nobody can cover the area".
//   5. Nina Rossi's job for Rossi's Cafe, in progress with Bob -- Cancel job is refused on it.
// Only cast people are used: Sarah, Tom, Margaret, Karl, Nina, Lena, Mike and Bob. Karl and Nina
// are made here (labelled, so the clear removes them); Sarah, Tom, Margaret and Bob are seeded.
// Nothing changes a cast record, so there is no restoreCast.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { dispatchJob, sendDispatchNotifications } from "../../jobs/dispatch.js";
import { nextWeekdayAt, todayAt, todayIn } from "../../time/index.js";

const ZONE = "Australia/Perth";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };
const APPLECROSS = { suburb: "Applecross", state: "WA", country: "AU", lat: -32.015475, lng: 115.836868, placeId: "fixture-place-applecross" };
const JOONDALUP = { suburb: "Joondalup", state: "WA", country: "AU", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" };

/** The marker each record's description carries, so a top-up can tell which are still in their starting state. */
const KEYS = ["sarah", "tom", "margaret", "margaret-copy", "karl", "nina"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-4006:${key}]`;
/** The wording the first make wrote, before the markers: a top-up still finds those records by it. */
const FIRST_DESCRIPTION: Record<Key, string> = {
  sarah: "UAT 4006: the kitchen mixer tap is leaking from the base.",
  tom: "UAT 4006: a blocked kitchen sink.",
  margaret: "UAT 4006: the garden tap is dripping.",
  "margaret-copy": "UAT 4006: the garden tap is dripping (second copy).",
  karl: "UAT 4006: a burst pipe under the laundry.",
  nina: "UAT 4006: the cafe's grease trap is blocked.",
};

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/**
 * Top up, never wipe (the UAT rules): remake only the records the owner has used up, as fresh
 * records, and leave every other record exactly as it was. A record is still fresh while its job
 * is in its starting state: Sarah's scheduled with an accepted booking, Tom's assigned and
 * waiting, Margaret's and Karl's new, Nina's in progress.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const START: Record<Key, { status: string; assignment: string | null }> = {
    sarah: { status: "scheduled", assignment: "accepted" },
    tom: { status: "assigned", assignment: "assigned" },
    margaret: { status: "new", assignment: null },
    "margaret-copy": { status: "new", assignment: null },
    karl: { status: "new", assignment: null },
    nina: { status: "in_progress", assignment: "in_progress" },
  };
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: {
        testData: "uat-4006",
        OR: [{ description: { contains: markerOf(key) } }, { description: FIRST_DESCRIPTION[key] }],
      },
      orderBy: { createdAt: "desc" },
      include: { assignments: { where: { status: { in: ["assigned", "accepted", "in_progress"] } } } },
    });
    const want = START[key];
    const live = job?.assignments[0]?.status ?? null;
    if (job === null || job.status !== want.status || live !== want.assignment) used.add(key);
  }
  return makeRecords(client, used);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const margaret = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  async function newJob(
    key: Key,
    customer: { id: string; billingAddress: unknown },
    place: typeof HILTON,
    postcode: string,
    status: "new" | "scheduled" | "in_progress",
    description: string,
    extra: { siteContact?: { name: string; phone: string; email: string }; withAddress?: boolean } = {},
  ) {
    const withAddress = extra.withAddress ?? true;
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode,
        serviceLocation: { ...place },
        siteAddress: withAddress && customer.billingAddress !== null ? (customer.billingAddress as object) : undefined,
        siteContact: extra.siteContact,
        ...(status === "new" ? {} : { serviceLevel: "normal" as const }),
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  // 1. Sarah's leaking tap, accepted by Bob for a weekday morning, Lena Park the site contact.
  if (which.has("sarah")) {
    const slot1 = nextWeekdayAt(ZONE, "wed", 8, 0, now);
    const job1 = await newJob("sarah", sarah, HILTON, "6163", "scheduled", FIRST_DESCRIPTION.sarah, {
      siteContact: { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" },
    });
    const assignment1 = await client.assignment.create({
      data: { jobId: job1.id, contractorId: bob.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot1, confirmedSlot: slot1, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: job1.id, assignmentId: assignment1.id, startTime: slot1, endTime: new Date(slot1.getTime() + 60 * 60_000) },
    });
    lines.push(`${job1.reference} - Sarah's leaking-tap job in Hilton, accepted by Bob for a weekday morning, Lena Park the site contact (text and email)`);
  }

  // 2. Tom's job, dispatched to Bob through the real dispatch: its Accept link is in /dev/texts.
  if (which.has("tom")) {
    const job2 = await newJob("tom", tom, KALAMUNDA, "6076", "new", FIRST_DESCRIPTION.tom);
    // A free Friday morning for Bob: step a week on at a time from the next Friday, a clash is only a busy answer.
    let dispatched: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (let week = 0; week < 8; week += 1) {
      const friday = new Date(nextWeekdayAt(ZONE, "fri", 9, 0, now).getTime() + week * 7 * 24 * 60 * 60_000);
      dispatched = await dispatchJob(client, job2.reference, "CON-014", {
        date: todayIn(ZONE, friday),
        startMinutes: 540,
        holdMinutes: 60,
        emergency: false,
      });
      if (dispatched.ok || dispatched.status !== 409) break;
    }
    if (dispatched === null || !dispatched.ok) {
      throw new Error(`could not dispatch Tom's job to Bob: ${dispatched === null ? "no attempt" : dispatched.error}`);
    }
    await sendDispatchNotifications(client, dispatched);
    lines.push(`${job2.reference} - Tom's blocked-sink job, dispatched to Bob and still waiting for his answer; his Accept link is in the Texts sent page (/dev/texts)`);
  }

  // 3. Margaret's new job and a second copy of it, to cancel as a duplicate.
  if (which.has("margaret")) {
    const job3 = await newJob("margaret", margaret, APPLECROSS, "6153", "new", FIRST_DESCRIPTION.margaret);
    lines.push(`${job3.reference} - Margaret's garden-tap job in Applecross, new, no contractor`);
  }
  if (which.has("margaret-copy")) {
    const job3b = await newJob("margaret-copy", margaret, APPLECROSS, "6153", "new", FIRST_DESCRIPTION["margaret-copy"]);
    lines.push(`${job3b.reference} - a second copy of Margaret's job, to cancel as a duplicate`);
  }

  // 4. Karl's job in Joondalup, nobody covering.
  if (which.has("karl")) {
    const karl =
      (await client.customer.findFirst({ where: { email: "karl@idelta.com.au", testData: "uat-4006" } })) ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Karl", email: "karl@idelta.com.au", phone: "0400 002 070" },
      }));
    const job4 = await newJob("karl", karl, JOONDALUP, "6027", "new", FIRST_DESCRIPTION.karl, { withAddress: false });
    lines.push(`${job4.reference} - Karl's burst-pipe job in Joondalup, new, nobody covering the area`);
  }

  // 5. Nina's job for Rossi's Cafe, in progress with Bob.
  if (which.has("nina")) {
    const nina =
      (await client.customer.findFirst({ where: { email: "nina@idelta.com.au", testData: "uat-4006" } })) ??
      (await client.customer.create({
        data: {
          code: await nextReference("CUS", client),
          name: "Nina Rossi",
          email: "nina@idelta.com.au",
          phone: "0400 002 060",
          businessName: "Rossi's Cafe",
          billingAddress: { street: "14 Marine Terrace", suburb: "Fremantle", state: "WA", country: "AU", postcode: "6160", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" },
        },
      }));
    const job5 = await newJob("nina", nina, { ...HILTON, suburb: "Fremantle", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" }, "6160", "in_progress", FIRST_DESCRIPTION.nina);
    const slot5 = todayAt(ZONE, 8, 0, now);
    await client.assignment.create({
      data: { jobId: job5.id, contractorId: bob.id, specialtyId: specialty.id, status: "in_progress", proposedSlot: slot5, confirmedSlot: slot5, acceptedAt: now },
    });
    lines.push(`${job5.reference} - Nina's job for Rossi's Cafe, in progress with Bob -- Cancel job is refused on it`);
  }

  return lines;
}
