// UAT data for feature 9002, test data hygiene -- the pattern's own example.
//
// Sarah: one extra enquiry, a leaking-tap job in Hilton, so the owner sees a
// labelled record on the Jobs list and then sees it go (AC6). Nothing else:
// Sarah herself is cast and stays as the seed has her.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";

export async function make(client: PrismaClient): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });

  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: sarah.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: {
        suburb: "Hilton",
        state: "WA",
        country: "AU",
        lat: -32.0731,
        lng: 115.7797,
        placeId: "fixture-place-hilton",
      },
      timezone: "Australia/Perth",
      description: "UAT 9002: a leaking tap -- this job is test data and goes when the check passes.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(),
    },
  });

  return [`${job.reference} - Sarah's leaking-tap job in Hilton`];
}
