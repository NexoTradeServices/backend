// UAT data for feature 3010, per-job contact details.
//
// Four new jobs, each with the contact "typed on the request" kept on it (enquiryContact), all labelled
// uat-3010. Sarah, Tom and Nina are the cast; none of their records is changed by make.
//   a. Sarah's job with a new phone (0412 555 019) and the business name "Chen Consulting", dispatched to
//      Bob and accepted; its Slot confirmed TEXT is queued, so it lands on the Texts sent page at the
//      given phone (AC1-AC4). Older job with no enquiryContact: JOB-1042, as seeded (AC9).
//   b. Nina Rossi's job (Rossi's Cafe on her record) whose request left the business name empty (AC5).
//   c. Sarah's second job typed as "Sara", the same phone as her record, no business name (AC6).
//   d. Tom's phone-intake job (source phone) keyed with a different phone (AC8).
// Cast records UAT can change: Sarah's and Tom's phone and business name ("Update customer" copies them);
// restoreCast puts both back as the seed has them. Nina is made here if she is not on file (labelled).
//
// Sends for real: nothing by email; the Slot confirmed text only reaches the Texts sent page.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { sendNotification } from "../../notifications/index.js";
import { formatSlotLabel } from "../../time/index.js";

const ZONE = "Australia/Perth";
const HOUR_MS = 60 * 60 * 1000;
const SARAH_PHONE = "0400 001 050";
const TOM_PHONE = "0400 001 052";
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };

const KEYS = ["a", "b", "c", "d"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-3010:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return makeRecords(client, new Set(KEYS));
}

/** Top up, never wipe: remake only a job the owner has used up (its flag cleared by Update customer, or gone). */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({ where: { testData: "uat-3010", description: { contains: markerOf(key) } } });
    if (job === null) used.add(key);
  }
  // The flag on (a) and (d) is cleared once Update customer has copied the phone: remake them to flag again.
  for (const key of ["a", "d"] as const) {
    const customerCode = key === "a" ? "CUS-1050" : "CUS-1052";
    const job = await client.job.findFirst({ where: { testData: "uat-3010", description: { contains: markerOf(key) } } });
    const contact = job?.enquiryContact as { phone?: string } | null | undefined;
    const customer = await client.customer.findUnique({ where: { code: customerCode } });
    if (contact?.phone !== undefined && customer?.phone === contact.phone) used.add(key);
  }
  if (used.has("a") || used.has("d")) await restoreRecords(client);
  return makeRecords(client, used);
}

async function restoreRecords(client: PrismaClient): Promise<void> {
  await client.customer.update({ where: { code: "CUS-1050" }, data: { phone: SARAH_PHONE, businessName: null } });
  await client.customer.update({ where: { code: "CUS-1052" }, data: { phone: TOM_PHONE, businessName: null } });
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await restoreRecords(client);
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const nina =
    (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
    (await client.customer.create({
      data: { code: await nextReference("CUS", client), name: "Nina Rossi", email: "nina@idelta.com.au", phone: "0400 002 060", businessName: "Rossi's Cafe" },
    }));
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bobRow = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bobRow.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
  const now = new Date();
  const lines: string[] = [];

  async function newJob(
    key: Key,
    customerId: string,
    place: typeof HILTON,
    postcode: string,
    description: string,
    source: "web" | "phone",
    contact: { name: string; phone: string; businessName?: string },
    status: "new" | "scheduled" = "new",
  ) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode,
        serviceLocation: { suburb: place.suburb, state: place.state, country: place.country, lat: place.lat, lng: place.lng, placeId: place.placeId },
        enquiryContact: contact,
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        source,
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  if (which.has("a")) {
    const job = await newJob("a", sarah.id, HILTON, "6163", "UAT 3010: the mixer tap is dripping.", "web", { name: "Sarah Chen", phone: "0412 555 019", businessName: "Chen Consulting" }, "scheduled");
    const slot = new Date(now.getTime() + 26 * HOUR_MS);
    const assignment = await client.assignment.create({
      data: { jobId: job.id, contractorId: bobRow.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await sendNotification(
      {
        type: "slot_confirmed",
        channel: "sms",
        recipientType: "customer",
        recipientId: sarah.id,
        idempotencyKey: `slot_confirmed:assignment:${assignment.id}:customer:sms`,
        relatedType: "assignment",
        relatedId: assignment.id,
        jobId: job.id,
        context: {
          audience: "customer",
          firstName: "Sarah",
          contractorFirstName: "Bob",
          jobReference: job.reference,
          trade: "Plumbing",
          street: "12 Paget Street",
          suburb: "Hilton",
          slotLabel: formatSlotLabel(ZONE, slot, now),
          officePhone: settings?.operatorPhone ?? "",
        },
      },
      client,
    );
    lines.push(`${job.reference} - Sarah's job booked with Bob; she typed phone 0412 555 019 and business name "Chen Consulting"; its Slot confirmed text is on the Texts sent page, to 0412 555 019`);
  }
  if (which.has("b")) {
    const job = await newJob("b", nina.id, FREMANTLE, "6160", "UAT 3010: the cafe's sink is slow to drain.", "web", { name: "Nina Rossi", phone: nina.phone ?? "0400 002 060" });
    lines.push(`${job.reference} - Nina Rossi's new job; her request left the business name empty (Rossi's Cafe stays on her record)`);
  }
  if (which.has("c")) {
    const job = await newJob("c", sarah.id, HILTON, "6163", "UAT 3010: a second tap, same house.", "web", { name: "Sara", phone: SARAH_PHONE });
    lines.push(`${job.reference} - Sarah's second new job, typed as "Sara", the same phone, no business name`);
  }
  if (which.has("d")) {
    const job = await newJob("d", tom.id, KALAMUNDA, "6076", "UAT 3010: hot water gone, keyed by phone.", "phone", { name: "Tom", phone: "0412 777 888" });
    lines.push(`${job.reference} - Tom's phone-intake job in Kalamunda, keyed with the phone 0412 777 888 (his record has ${TOM_PHONE})`);
  }
  return lines;
}
