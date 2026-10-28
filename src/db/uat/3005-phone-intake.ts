// UAT data for feature 3005, phone-taken job intake.
//
// Nothing is made up front: Mike keys the jobs himself on the Phone intake page, which is the check.
// Tom (CUS-1052, Kalamunda 6076, tom@idelta.com.au) is the seeded customer with no open job; Karl has no
// customer record; Bob is the seeded active plumber for the emergency dispatch. Every job the steps
// key starts its description with "UAT 3005", so the clear finds it.
//
// Cast records UAT can change: Karl's customer record (made by the keyed job, removed again with it, but
// only when every job on it is a UAT 3005 one), and Tom (his UAT jobs go; Tom stays). Bob's dispatch of
// Tom's job goes with the job.
//
// Sends for real, from the steps (not this script): the Enquiry received email to tom@idelta.com.au and
// karl@idelta.com.au, and Bob's dispatch text to the Texts sent page.
import type { PrismaClient } from "../client.js";
import { sweepTestData } from "../../test-data/sweep.js";

const LABEL = "uat-3005";
const MARKER = "UAT 3005";

export function make(): Promise<string[]> {
  return Promise.resolve(["Nothing to make -- Mike keys the jobs on the Phone intake page; each description starts with 'UAT 3005'"]);
}

export function topUp(): Promise<string[]> {
  return Promise.resolve([]);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
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
