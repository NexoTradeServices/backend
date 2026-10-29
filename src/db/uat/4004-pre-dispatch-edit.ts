// UAT data for feature 4004, pre-dispatch edit.
//
// Three new jobs for Mike to edit, all labelled uat-4004, none dispatched:
//   a. Sarah's plumbing job in Hilton 6163, two plumbing questions answered, no site address (AC1, AC2, AC7).
//   b. Karl's electrical job in Joondalup 6027, no site address -- out of reach until the suburb moves (AC3).
//   c. Tom's job in Kalamunda 6076 WITH a site address, so the suburb is locked (AC4).
// JOB-1042 (Sarah's job dispatched to Bob, as seeded) is the locked case (AC5).
// Karl is a new guest customer (karl@idelta.com.au) made here if he is not on file; if feature 3002's check
// has made him, he is shared (that check's clear takes his jobs with him).
//
// Cast records UAT can change: none (an edit changes only the job). Sends nothing.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";

const ZONE = "Australia/Perth";
const KEYS = ["a", "b", "c"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-4004:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake only a job that has been dispatched, moved off its starting data, or is gone. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: "uat-4004", description: { contains: markerOf(key) } } });
    if (job === null || job.status !== "new") used.add(key);
  }
  return makeRecords(client, used);
}

export function restoreCast(): Promise<void> {
  return Promise.resolve();
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const karl =
    (await client.customer.findUnique({ where: { email: "karl@idelta.com.au" } })) ??
    (await client.customer.create({
      data: { code: await nextReference("CUS", client), name: "Karl", email: "karl@idelta.com.au", phone: "0400 000 999" },
    }));
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const electrical = await client.serviceType.findUniqueOrThrow({ where: { trade: "Electrical" } });
  const now = new Date();
  const lines: string[] = [];

  async function newJob(key: Key, customerId: string, trade: typeof plumbing, place: Record<string, unknown>, postcode: string, description: string, selectedOptions: string[], siteAddress?: Record<string, unknown>) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId,
        serviceTypeId: trade.id,
        customerCalloutRate: trade.customerCalloutRate,
        customerStandardRate: trade.customerStandardRate,
        postcode,
        serviceLocation: place as never,
        ...(siteAddress === undefined ? {} : { siteAddress: siteAddress as never }),
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions,
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(now.getTime() + 36 * 60 * 60_000),
        status: "new",
      },
    });
  }

  if (which.has("a")) {
    const job = await newJob("a", sarah.id, plumbing, { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" }, "6163", "UAT 4004: the mixer tap is dripping.", ["Where in the property is it?: Kitchen", "What brand is it?: Methven"]);
    lines.push(`${job.reference} - Sarah's new plumbing job in Hilton 6163, two plumbing questions answered, no site address`);
  }
  if (which.has("b")) {
    const job = await newJob("b", karl.id, electrical, { suburb: "Joondalup", state: "WA", country: "AU", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" }, "6027", "UAT 4004: the garage lights keep tripping.", []);
    lines.push(`${job.reference} - Karl's new electrical job in Joondalup 6027, no site address (out of reach)`);
  }
  if (which.has("c")) {
    const kalamunda = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };
    const job = await newJob("c", tom.id, plumbing, kalamunda, "6076", "UAT 4004: hot water has gone.", [], { street: "22 Haynes Street", ...kalamunda, postcode: "6076" });
    lines.push(`${job.reference} - Tom's new job in Kalamunda 6076 with a site address (22 Haynes Street), so the suburb is locked`);
  }
  return lines;
}
