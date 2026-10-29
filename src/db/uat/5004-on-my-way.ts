// UAT data for feature 5004, "On my way".
//
// Four fresh jobs, all Bob's, Plumbing, labelled uat-5004. Fresh jobs, not JOB-1042: the cast job is
// never touched, so there is nothing to put back (the 4005 and 4006 way). No message is sent while
// these are made: each assignment is written straight in its state (no dispatch).
//   a. Sarah's leaking-tap job at 12 Paget Street, Hilton, Lena Park (text and email) as site contact,
//      accepted by Bob, booked for today at 5:00pm -- the tap sends Sarah's and Lena's copies.
//   b. Nina Rossi's job at Rossi's Cafe, Fremantle, no site contact, accepted by Bob, booked for today
//      at 3:00pm -- a second card with the button; the tap sends Nina's two messages only.
//   c. Tom's job in Kalamunda, accepted by Bob, booked for tomorrow -- no button.
//   d. Margaret's job in Applecross, dispatched to Bob and not yet answered -- no button.
//
// The visit is booked for the DAY the script runs: make it again (the sitting does) if the owner
// comes back on another day. Cast records UAT can change: none (Nina is made here, with the label).
//
// Sends for real: nothing while the records are made. The steps then send Sarah's, Lena's and Nina's
// emails to their cast inboxes (sarah@, lena@, nina@idelta.com.au); the texts only reach the Texts
// sent page (/dev/texts).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { todayAt } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL = "uat-5004";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };
const APPLECROSS = { suburb: "Applecross", state: "WA", country: "AU", lat: -32.0098, lng: 115.8387, placeId: "fixture-place-applecross" };
const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(["sarah", "nina", "tom", "margaret"]));
}

/** Top up, never wipe: remake only a job whose visit was used up (the tap is idempotent, so "used" means gone or answered otherwise). */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const need = new Set<string>();
  for (const key of ["sarah", "nina", "tom", "margaret"]) {
    const job = await client.job.findFirst({ where: { testData: LABEL, description: { contains: `[${LABEL}:${key}]` } }, orderBy: { createdAt: "desc" } });
    if (job === null) need.add(key);
  }
  return makeRecords(client, need);
}

async function makeRecords(client: PrismaClient, which: Set<string>): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  async function booked(opts: {
    key: string;
    customerId: string;
    location: object;
    street: string;
    postcode: string;
    description: string;
    siteContact?: typeof LENA;
    slot: Date;
    state: "accepted" | "assigned";
  }) {
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: opts.customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: opts.postcode,
        serviceLocation: { ...opts.location },
        siteAddress: { street: opts.street, ...opts.location, postcode: opts.postcode },
        siteContact: opts.siteContact,
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${opts.description} [${LABEL}:${opts.key}]`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "afternoon",
        preferredDate: opts.slot,
        status: opts.state === "accepted" ? "scheduled" : "assigned",
      },
    });
    const assignment = await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bob.id,
        specialtyId: specialty.id,
        status: opts.state,
        proposedSlot: opts.slot,
        ...(opts.state === "accepted" ? { confirmedSlot: opts.slot, acceptedAt: now } : { dispatchedAt: now }),
      },
    });
    await client.calendarEvent.create({
      data: {
        contractorId: bob.id,
        type: "job",
        jobId: job.id,
        assignmentId: assignment.id,
        startTime: opts.slot,
        endTime: new Date(opts.slot.getTime() + 60 * 60_000),
      },
    });
    return job;
  }

  if (which.has("sarah")) {
    const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const job = await booked({
      key: "sarah",
      customerId: sarah.id,
      location: HILTON,
      street: "12 Paget Street",
      postcode: "6163",
      description: "UAT 5004: the kitchen mixer tap is leaking.",
      siteContact: LENA,
      slot: todayAt(ZONE, 17, 0, now),
      state: "accepted",
    });
    lines.push(`${job.reference} - Sarah's leaking-tap job at 12 Paget Street, Hilton, accepted by Bob, booked for today at 5:00pm, Lena Park the site contact (text and email)`);
  }
  if (which.has("nina")) {
    const nina =
      (await client.customer.findFirst({ where: { email: "nina@idelta.com.au" } })) ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "Rossi's Cafe" },
      }));
    const job = await booked({
      key: "nina",
      customerId: nina.id,
      location: FREMANTLE,
      street: "1 High Street",
      postcode: "6160",
      description: "UAT 5004: the cafe's hand basin drips.",
      slot: todayAt(ZONE, 15, 0, now),
      state: "accepted",
    });
    lines.push(`${job.reference} - Nina Rossi's job at Rossi's Cafe, Fremantle, accepted by Bob, booked for today at 3:00pm, no site contact`);
  }
  if (which.has("tom")) {
    const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
    const job = await booked({
      key: "tom",
      customerId: tom.id,
      location: KALAMUNDA,
      street: "9 Railway Road",
      postcode: "6076",
      description: "UAT 5004: a blocked kitchen sink.",
      slot: todayAt(ZONE, 9, 0, new Date(now.getTime() + DAY_MS)),
      state: "accepted",
    });
    lines.push(`${job.reference} - Tom's job in Kalamunda, accepted by Bob, booked for tomorrow at 9:00am -- no On my way button yet`);
  }
  if (which.has("margaret")) {
    const margaret = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
    const job = await booked({
      key: "margaret",
      customerId: margaret.id,
      location: APPLECROSS,
      street: "4 Kearns Crescent",
      postcode: "6153",
      description: "UAT 5004: the toilet keeps running.",
      slot: todayAt(ZONE, 16, 0, now),
      state: "assigned",
    });
    lines.push(`${job.reference} - Margaret's job in Applecross, dispatched to Bob for today at 4:00pm and not yet answered -- no button on its card`);
  }
  return lines;
}
