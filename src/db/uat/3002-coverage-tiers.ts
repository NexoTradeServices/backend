// UAT data for feature 3002, coverage tiers at the pick.
//
// Three new jobs, none dispatched, so the owner can see the tag on the ops queue:
//   1. Sarah's plumbing job in Hilton 6163 (covered -- no tag).
//   2. Greg's plumbing job in Rottnest Island 6161 (near-miss -- "No direct coverage").
//   3. Karl's electrical job in Joondalup 6027, no site address (out of reach -- "Out of reach"),
//      for the site-address move and the reach change.
// Greg and Karl are new guest customers (greg@ / karl@idelta.com.au); Sarah is the seeded cast.
// The form run (UAT step) sends a fourth job as Karl, its description starting "UAT 3002", so
// the clear finds it. Cast records UAT can change: the platform's serviceReachKm (the owner
// raises it) -- put back to 25 as the seed has it.
// Sends nothing itself. (Karl's form run sends his enquiry confirmation to karl@idelta.com.au.)
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { sweepTestData } from "../../test-data/sweep.js";
import { coverageOf } from "../../coverage/tier.js";

const ZONE = "Australia/Perth";
const LABEL = "uat-3002";
const MARKER = "UAT 3002";
const SEED_REACH_KM = 25;

interface Record3002 {
  who: "Sarah" | "Greg" | "Karl";
  email: string | null; // null = the seeded cast row (Sarah, CUS-1050)
  trade: "Plumbing" | "Electrical";
  place: { suburb: string; postcode: string; lat: number; lng: number; placeId: string };
  description: string;
}

const RECORDS: Record3002[] = [
  {
    who: "Sarah",
    email: null,
    trade: "Plumbing",
    place: { suburb: "Hilton", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
    description: `${MARKER}: the mixer tap in the kitchen is dripping.`,
  },
  {
    who: "Greg",
    email: "greg@idelta.com.au",
    trade: "Plumbing",
    place: { suburb: "Rottnest Island", postcode: "6161", lat: -32.0072, lng: 115.5413, placeId: "fixture-place-rottnest" },
    description: `${MARKER}: a cottage hot water tap runs cold.`,
  },
  {
    who: "Karl",
    email: "karl@idelta.com.au",
    trade: "Electrical",
    place: { suburb: "Joondalup", postcode: "6027", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" },
    description: `${MARKER}: the garage lights keep tripping the switch.`,
  },
];

async function ensureCustomer(client: PrismaClient, record: Record3002) {
  if (record.email === null) return client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const found = await client.customer.findUnique({ where: { email: record.email } });
  if (found) return found;
  return client.customer.create({
    data: {
      code: await nextReference("CUS", client),
      name: record.who,
      email: record.email,
      phone: record.who === "Greg" ? "0400 000 998" : "0400 000 999",
    },
  });
}

async function makeOne(client: PrismaClient, record: Record3002): Promise<string> {
  const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade: record.trade } });
  const customer = await ensureCustomer(client, record);
  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: record.place.postcode,
      serviceLocation: {
        suburb: record.place.suburb,
        state: "WA",
        country: "AU",
        lat: record.place.lat,
        lng: record.place.lng,
        placeId: record.place.placeId,
      },
      serviceLevel: "normal",
      timezone: ZONE,
      description: record.description,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(),
      status: "new",
    },
  });
  const { tier, nearestKm } = await coverageOf(client, record.place);
  const distance = nearestKm === null ? "" : `, nearest contractor ${nearestKm.toFixed(1)} km`;
  return `${job.reference} - ${record.who}'s new ${record.trade.toLowerCase()} job in ${record.place.suburb} ${record.place.postcode} (${tier}${distance})`;
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  const lines: string[] = [];
  for (const record of RECORDS) lines.push(await makeOne(client, record));
  return lines;
}

/** During UAT: remake only a job that has moved suburb or left `new`; leave the rest as the owner has them. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const lines: string[] = [];
  for (const record of RECORDS) {
    const intact = await client.job.findFirst({
      where: {
        testData: LABEL,
        status: "new",
        postcode: record.place.postcode,
        description: record.description,
      },
    });
    if (intact === null) lines.push(await makeOne(client, record));
  }
  return lines;
}

/** Clear runs this after the label sweep; make runs it first. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  // Karl's form run is made by the running site, unlabelled: label every job of Greg's and Karl's
  // and anything starting with the marker, so the sweep takes them (and the two guests) together.
  await client.job.updateMany({
    where: { OR: [{ description: { startsWith: MARKER } }, { customer: { email: { in: ["greg@idelta.com.au", "karl@idelta.com.au"] } } }] },
    data: { testData: LABEL },
  });
  await client.customer.updateMany({ where: { email: { in: ["greg@idelta.com.au", "karl@idelta.com.au"] } }, data: { testData: LABEL } });
  await sweepTestData(client, LABEL);
  await client.platformSettings.updateMany({ data: { serviceReachKm: SEED_REACH_KM } });
}
