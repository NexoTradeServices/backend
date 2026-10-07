// UAT data for feature 1017, business customers.
//
// Two jobs, so the owner can check the job page's Business name field:
//   1. Nina Rossi's new job in Fremantle. Nina is a new customer here, holding
//      "Rossi's Cafe" as her business name (shown on the job page).
//   2. Tom's job in Kalamunda, dispatched to Bob, with no business name on
//      Tom's record -- Mike adds one on a dispatched job.
// The owner also submits the web form twice (UAT steps): as a fresh Nina
// (nina.uat1017@idelta.com.au, "Rossi's Cafe") and as Sarah with a business
// name typed. Those two enquiries are made by the running site, not this
// script, so the clear finds them by what the steps told the owner to use:
// Nina's e-mail address, and the text "UAT 1017" in the description.
//
// Cast records UAT can change: Tom's business name (Mike adds one) and
// Sarah's (a web enquiry must leave it alone). Both are put back to none.
// Only cast people are used: Nina, Tom, Sarah, Mike and Bob.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { sweepTestData } from "../../test-data/sweep.js";
import { todayAt } from "../../time/index.js";

const ZONE = "Australia/Perth";
const LABEL = "uat-1017";
/** The address the owner types for Nina on the web form (the steps name it). */
const FORM_NINA_EMAIL = "nina.uat1017@idelta.com.au";
/** The text the owner types in the description of both web enquiries (the steps name it). */
const MARKER = "UAT 1017";
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);

  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const now = new Date();
  const lines: string[] = [];

  const nina = await client.customer.create({
    data: {
      code: await nextReference("CUS", client),
      name: "Nina Rossi",
      email: "nina@idelta.com.au",
      phone: "0400 002 060",
      businessName: "Rossi's Cafe",
    },
  });
  const ninaJob = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: nina.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6160",
      serviceLocation: { ...FREMANTLE },
      serviceLevel: "normal",
      timezone: ZONE,
      description: "UAT 1017: the cafe's kitchen sink is blocked.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: now,
      status: "new",
    },
  });
  lines.push(`${ninaJob.reference} - Nina Rossi's new job in Fremantle, her business name "Rossi's Cafe" on her record (${nina.code})`);

  const tomJob = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: tom.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6076",
      serviceLocation: { ...KALAMUNDA },
      serviceLevel: "normal",
      timezone: ZONE,
      description: "UAT 1017: a dripping outside tap.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: now,
      status: "assigned",
    },
  });
  await client.assignment.create({
    data: {
      jobId: tomJob.id,
      contractorId: bob.id,
      specialtyId: specialty.id,
      status: "assigned",
      proposedSlot: todayAt(ZONE, 9, 0, new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    },
  });
  lines.push(`${tomJob.reference} - Tom's job in Kalamunda, dispatched to Bob, no business name on Tom's record (CUS-1052)`);

  return lines;
}

/** Clear runs this after the label sweep; make runs it first. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  // The owner's two web enquiries are made by the running site, unlabelled:
  // label them (and what hangs off them) so the sweep removes them with the rest.
  await client.customer.updateMany({ where: { email: FORM_NINA_EMAIL }, data: { testData: LABEL } });
  await client.job.updateMany({
    where: { description: { contains: MARKER }, customer: { code: "CUS-1050" } },
    data: { testData: LABEL },
  });
  await sweepTestData(client, LABEL);

  // Cast records UAT may have changed: back to no business name, as the seed has them.
  await client.customer.updateMany({ where: { code: { in: ["CUS-1050", "CUS-1052"] } }, data: { businessName: null } });
}
