// UAT data for feature 3005, phone-taken job intake.
//
// Nothing is made up front: Mike keys the jobs himself on the Phone intake page, which is the check.
// Tom (CUS-1052, Kalamunda 6076, tom@idelta.com.au) is the seeded customer with no open job; Karl has no
// customer record; Bob is the seeded active plumber for the emergency dispatch. Every job the steps
// key starts its description with "UAT 3005", so the clear finds it.
//
// Cast records UAT can change: Tom's billing address (the steps key a new one; put back to the seed's 22
// Williams Road), Karl's customer record (made by the keyed job, removed again with it, but
// only when every job on it is a UAT 3005 one), and Tom (his UAT jobs go; Tom stays). Bob's dispatch of
// Tom's job goes with the job.
//
// Sends for real, from the steps (not this script): the Enquiry received email to tom@idelta.com.au and
// karl@idelta.com.au, and Bob's dispatch text to the Texts sent page.
import type { PrismaClient } from "../client.js";
import { sweepTestData } from "../../test-data/sweep.js";

const LABEL = "uat-3005";
const MARKER = "UAT 3005";
// Tom's billing address as the seed has it (backend/src/db/seed/fixtures.ts, CUS-1052).
const TOM_SEED_BILLING = {
  street: "22 Williams Road",
  suburb: "Kalamunda",
  state: "WA",
  country: "AU",
  postcode: "6076",
  lat: -31.974211,
  lng: 116.051444,
  placeId: "fixture-place-kalamunda",
};

export function make(): Promise<string[]> {
  return Promise.resolve(["Nothing to make -- Mike keys the jobs on the Phone intake page; each description starts with 'UAT 3005'"]);
}

export function topUp(): Promise<string[]> {
  return Promise.resolve([]);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  // The page can save a billing address (and the ABN and GST answer) on the customer it joins: put Tom's back.
  await client.customer.updateMany({
    where: { code: "CUS-1052" },
    data: { billingAddress: TOM_SEED_BILLING, abn: null, gstRegistered: null },
  });
  const keyed = await client.job.findMany({ where: { description: { startsWith: MARKER } }, select: { id: true, customerId: true } });
  if (keyed.length === 0) return;
  await client.job.updateMany({ where: { id: { in: keyed.map((job) => job.id) } }, data: { testData: LABEL } });

  // Karl: his record goes only when every job on it is a UAT one (he had none before the check).
  const karl = await client.customer.findUnique({ where: { email: "karl@idelta.com.au" }, select: { id: true, testData: true } });
  if (karl !== null && karl.testData === null) {
    const others = await client.job.count({ where: { customerId: karl.id, NOT: { description: { startsWith: MARKER } } } });
    if (others === 0 && keyed.some((job) => job.customerId === karl.id)) {
      await client.customer.update({ where: { id: karl.id }, data: { testData: LABEL } });
    }
  }
  await sweepTestData(client, LABEL);
}
