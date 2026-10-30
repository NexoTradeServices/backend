// UAT data for feature 7001, bounced emails.
//
// Records, all labelled uat-7001 except Sarah's login (below):
//   a. Greg (guest, greg@idelta.com.au -- deliberately no mailbox) with a plumbing job on Rottnest Island,
//      dispatched to Bob through the real dispatch and still waiting for his answer. The owner accepts it
//      from Bob's Accept link; Greg's Job booked email then really bounces at Mailjet (AC10, AC1) and
//      the office inbox gets "Email bouncing - Greg"; Greg's job page then shows "Bouncing" (AC7).
//   b. Nina Rossi (Rossi's Cafe, nina@idelta.com.au) as a customer record, so Mike can try her address on
//      Sarah's job and be refused naming her code (AC8).
//      Nina is not in the seed; another feature's UAT script may already have made her (customer emails are
//      unique, so one record serves both). If that script's clear removes her, topUp makes her again.
//   c. Sarah (CUS-1050, the seeded cast row) gets a LOGIN with the dev password, the 3004 way (a User her
//      Customer row points at), so Change email on JOB-1042 moves her login email too (AC9). That User is
//      deliberately NOT labelled: the sweep removes every row that points at a labelled row, and Sarah's
//      Customer row points at it. restoreCast removes the login again and puts her email back.
//
// Cast records UAT changes: Sarah's email (the steps change it and change it back) and her login.
// restoreCast puts the email back to sarah@idelta.com.au, removes the login, and removes the bounced
// listings the steps caused (greg@idelta.com.au, sarah@idelta.com.au); a listing is written by the
// provider's report, not by this script, so the label cannot reach it.
//
// Sends for real: the dispatch email to Bob's cast inbox (bob@idelta.com.au); the dispatch text only
// reaches the Texts sent page (/dev/texts). The steps then send Greg's Job booked email to Mailjet
// (it bounces: no mailbox), and the office inbox (ops@idelta.com.au) gets one Email bouncing notice.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { dispatchJob, sendDispatchNotifications } from "../../jobs/dispatch.js";
import { nextWeekdayAt, todayIn } from "../../time/index.js";
import { sweepTestData } from "../../test-data/sweep.js";
import { passwordHasher } from "../../auth/dev-password.js";
import { DEV_PASSWORD } from "../seed/auth.js";

const LABEL = "uat-7001";
const ZONE = "Australia/Perth";
const GREG_EMAIL = "greg@idelta.com.au";
const SARAH_EMAIL = "sarah@idelta.com.au";
const ROTTNEST = { suburb: "Rottnest Island", state: "WA", country: "AU", lat: -32.0072, lng: 115.5413, placeId: "fixture-place-rottnest" };
const COTTAGE = { street: "7 Bedford Avenue", ...ROTTNEST, postcode: "6161" };
const MARKER = "[uat-7001:greg]";

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, { greg: true, nina: true, login: true });
}

/** Top up, never wipe: remake Greg's job once it has been answered, Nina if she is gone, Sarah's login if it is gone. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const job = await client.job.findFirst({
    where: { testData: LABEL, description: { contains: MARKER } },
    orderBy: { createdAt: "desc" },
    include: { assignments: { where: { status: "assigned" } } },
  });
  const gregUsedUp = job === null || job.status !== "assigned" || job.assignments.length === 0;
  const nina = await client.customer.findFirst({ where: { email: "nina@idelta.com.au" } });
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  if (gregUsedUp) {
    // A fresh job to accept needs a fresh bounce: the dead address was listed by the last one.
    await client.suppression.deleteMany({ where: { channel: "email", address: GREG_EMAIL } });
  }
  return makeRecords(client, { greg: gregUsedUp, nina: nina === null, login: sarah.userId === null });
}

/** Sarah back to a guest with her own email; the bounced listings the steps caused gone. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  await sweepTestData(client, LABEL);
  const sarah = await client.customer.findUnique({ where: { code: "CUS-1050" } });
  if (sarah !== null) {
    const userId = sarah.userId;
    await client.customer.update({ where: { id: sarah.id }, data: { email: SARAH_EMAIL, userId: null } });
    if (userId !== null) await client.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
  // Mike's steps may have moved Greg to another address; the old one stays listed, so clear every listing the steps made.
  await client.suppression.deleteMany({ where: { channel: "email", address: { in: [GREG_EMAIL, SARAH_EMAIL] } } });
}

async function makeRecords(client: PrismaClient, which: { greg: boolean; nina: boolean; login: boolean }): Promise<string[]> {
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const now = new Date();
  const lines: string[] = [];

  if (which.greg) {
    const greg =
      (await client.customer.findFirst({ where: { email: GREG_EMAIL } })) ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Greg", email: GREG_EMAIL, phone: "0400 000 998" },
      }));
    const job = await client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: greg.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: "6161",
        serviceLocation: { ...ROTTNEST },
        siteAddress: COTTAGE,
        timezone: ZONE,
        description: `UAT 7001: a cottage hot water tap runs cold. ${MARKER}`,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status: "new",
      },
    });
    let result: Awaited<ReturnType<typeof dispatchJob>> | null = null;
    for (let week = 0; week < 8; week += 1) {
      const day = new Date(nextWeekdayAt(ZONE, "wed", 8, 0, now).getTime() + week * 7 * 24 * 60 * 60_000);
      result = await dispatchJob(client, job.reference, "CON-014", { date: todayIn(ZONE, day), startMinutes: 480, holdMinutes: 60, emergency: false });
      if (result.ok || result.status !== 409) break;
    }
    if (result === null || !result.ok) {
      throw new Error(`could not dispatch ${job.reference} to Bob: ${result === null ? "no attempt" : result.error}`);
    }
    await sendDispatchNotifications(client, result);
    lines.push(`${job.reference} - Greg's hot-water-tap job on Rottnest Island, dispatched to Bob and waiting for his answer; his Accept link is in the Texts sent page (/dev/texts). Greg's email greg@idelta.com.au has no mailbox`);
  }

  if (which.nina) {
    const nina =
      (await client.customer.findFirst({ where: { email: "nina@idelta.com.au" } })) ??
      (await client.customer.create({
        data: {
          code: await nextReference("CUS", client),
          name: "Nina Rossi",
          email: "nina@idelta.com.au",
          phone: "0400 002 060",
          businessName: "Rossi's Cafe",
        },
      }));
    lines.push(`${nina.code} - Nina Rossi, Rossi's Cafe, nina@idelta.com.au -- the address Mike tries on Sarah's job and is refused`);
  }

  if (which.login) {
    const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    if (sarah.userId === null) {
      // Not labelled on purpose (see the header): the Customer row points at this User.
      const user = await client.user.create({ data: { name: sarah.name, email: sarah.email, role: "customer", testData: null } });
      const hash = await passwordHasher().hash(DEV_PASSWORD);
      await client.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash } });
      await client.customer.update({ where: { id: sarah.id }, data: { userId: user.id } });
      lines.push(`CUS-1050 - Sarah Chen now has a login (sarah@idelta.com.au, the dev password), for the Change email login check on JOB-1042`);
    }
  }
  return lines;
}
