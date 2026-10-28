// UAT data for feature 3004, guest to account upgrade.
//
// Sarah Chen (CUS-1050, Hilton 6163, sarah@idelta.com.au) is a guest as seeded: no login. Two jobs of
// hers are made, both labelled uat-3004:
//   a. a booked plumbing job with Bob: its Slot confirmed email and text go to Sarah while she is a
//      guest (the footer "Want to track all your jobs? Set a password"); the text shows on the
//      interim Texts sent page. (AC9)
//   b. a completed plumbing job with an OPEN review link, listed in full, for the review page's
//      footer in each state. (AC10)
// The Set a password steps make Sarah a login (her Customer gets userId). That login is the one cast
// change UAT makes: restoreCast removes it (and its links and mail), so she is a guest again.
// Mike, Bob and the owner are the seeded logins, used as they are.
//
// Sends for real: the Slot confirmed email to sarah@idelta.com.au and the same text to the Texts sent
// page. Nothing else.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { sendNotification } from "../../notifications/index.js";
import { CapabilityTokenType, mintCapabilityLink } from "../../capability-tokens/index.js";
import { formatSlotLabel } from "../../time/index.js";

const ZONE = "Australia/Perth";
const HOUR_MS = 60 * 60 * 1000;
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const SITE = { street: "5 Carrington Street", ...HILTON, postcode: "6163" };
const MARKER_BOOKED = "[uat-3004:booked]";
const MARKER_DONE = "[uat-3004:done]";

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(["booked", "done"]));
}

/** Top up, never wipe: remake only a job the owner has used up (the review link is spent once she rates). */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<"booked" | "done">();
  const booked = await client.job.findFirst({ where: { testData: "uat-3004", description: { contains: MARKER_BOOKED } } });
  if (booked === null) used.add("booked");
  const done = await client.job.findFirst({ where: { testData: "uat-3004", description: { contains: MARKER_DONE } }, include: { reviews: { select: { id: true } } } });
  if (done === null || done.reviews.length > 0) used.add("done");
  return makeRecords(client, used);
}

async function makeRecords(client: PrismaClient, which: Set<"booked" | "done">): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bobRow = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bobRow.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
  const now = new Date();
  const lines: string[] = [];

  async function newJob(description: string, status: "scheduled" | "completed") {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: sarah.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: SITE.postcode,
        serviceLocation: { suburb: HILTON.suburb, state: HILTON.state, country: HILTON.country, lat: HILTON.lat, lng: HILTON.lng, placeId: HILTON.placeId },
        siteAddress: SITE,
        source: "web",
        serviceLevel: "normal",
        timezone: ZONE,
        description,
        selectedOptions: [],
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  if (which.has("booked")) {
    const job = await newJob(`UAT 3004: the bathroom tap is dripping. ${MARKER_BOOKED}`, "scheduled");
    const slot = new Date(now.getTime() + 26 * HOUR_MS);
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bobRow.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    const context = {
      audience: "customer",
      firstName: "Sarah",
      contractorFirstName: "Bob",
      jobReference: job.reference,
      trade: "Plumbing",
      street: SITE.street,
      suburb: SITE.suburb,
      slotLabel: formatSlotLabel(ZONE, slot, now),
      officePhone: settings?.operatorPhone ?? "",
    };
    for (const channel of ["email", "sms"] as const) {
      await sendNotification(
        {
          type: "slot_confirmed",
          channel,
          recipientType: "customer",
          recipientId: sarah.id,
          idempotencyKey: `slot_confirmed:assignment:${assignment.id}:customer:${channel}`,
          relatedType: "assignment",
          relatedId: assignment.id,
          jobId: job.id,
          context,
        },
        client,
      );
    }
    lines.push(`${job.reference} - Sarah's booked plumbing job with Bob; its Slot confirmed email (to sarah@idelta.com.au) and text (Texts sent page) carry the Set a password offer while she is a guest`);
  }

  if (which.has("done")) {
    const job = await newJob(`UAT 3004: the kitchen mixer tap was leaking. ${MARKER_DONE}`, "completed");
    const start = new Date(now.getTime() - 30 * HOUR_MS);
    await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bobRow.id,
        specialtyId: specialty.id,
        status: "completed",
        proposedSlot: start,
        confirmedSlot: start,
        acceptedAt: start,
        completedAt: new Date(start.getTime() + 3 * HOUR_MS),
        completionNotes: "Replaced the cartridge.",
        billedHours: 3,
      },
    });
    const link = await mintCapabilityLink(client, { type: CapabilityTokenType.review, jobId: job.id });
    lines.push(`${job.reference} - Sarah's completed plumbing job with an open review link: ${link.url}`);
  }
  return lines;
}

/** Clear runs this after the label sweep; make runs it first: Sarah is a guest again. */
export async function restoreCast(client: PrismaClient): Promise<void> {
  const sarah = await client.customer.findUnique({ where: { code: "CUS-1050" }, select: { id: true, userId: true } });
  if (sarah?.userId === null || sarah === null) return;
  const userId = sarah.userId;
  await client.customer.update({ where: { id: sarah.id }, data: { userId: null } });
  await client.verification.deleteMany({ where: { identifier: { startsWith: "reset-password:" }, value: userId } });
  await client.notification.deleteMany({ where: { recipientType: "user", recipientId: userId } });
  await client.user.delete({ where: { id: userId } });
}
