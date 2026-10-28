// UAT data for feature 3006, the enquiry form safe when Google is missing.
//
// No record is needed up front: Sarah (CUS-1050, Hilton 6163) sends a fresh enquiry through the
// form herself, so nothing is created here and nothing carries the uat-3006 label to begin with.
//
// The one record the check creates is that enquiry's job. Its step tells the owner to start the
// description with "UAT 3006", so clearing can find it: restoreCast labels any such job, then
// sweeps the label -- the job goes with its notifications, and Sarah (the seeded cast) stays.
//
// Sends nothing itself: no email, no text, no upload. (The enquiry the OWNER sends in the check
// does send Sarah's confirmation email, to her real test mailbox.)
import type { PrismaClient } from "../client.js";
import { sweepTestData } from "../../test-data/sweep.js";

const LABEL = "uat-3006";
const DESCRIPTION_PREFIX = "UAT 3006";

export function make(): Promise<string[]> {
  return Promise.resolve(["Nothing to make -- Sarah sends the enquiry herself (step 5); it starts with 'UAT 3006'"]);
}

/** Top up: nothing is used up before the check starts -- leave whatever the owner has made. */
export function topUp(): Promise<string[]> {
  return Promise.resolve([]);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.job.updateMany({
    where: { description: { startsWith: DESCRIPTION_PREFIX } },
    data: { testData: LABEL },
  });
  await sweepTestData(client, LABEL);
}
