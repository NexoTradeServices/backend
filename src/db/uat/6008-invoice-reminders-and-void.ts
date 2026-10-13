// UAT data for feature 6008, invoice reminders and void.
//
// Five completed jobs, each invoiced the way Complete does it (the same issue step), each with a
// REAL Stripe sandbox pay link made with no message sent (so no invoice email or text goes now):
//   sarah-due   Sarah's leaking-tap job by Bob: due today, no reminder yet (AC1, AC5, AC11).
//   nina-second Nina Rossi's electrical job by Dave: due 8 days ago, reminder 1 "sent" 7 days ago
//               (AC3, AC7 -- "Your turn to ring" appears after the morning run).
//   tom-void    Tom's plumbing job by Bob: 10 days overdue, both reminders "sent" (AC8, AC9 void it,
//               AC10 its sandbox pay link is switched off).
//   margaret    Margaret's plumbing job by Bob: 3 days past due, no reminder yet (AC2, the missed
//               morning: she gets reminder 1 on the next run). The "still waiting for its pay link,
//               no reminder" half of AC2 cannot be held in dev -- the live pay-link loop links a
//               waiting invoice within 2 minutes and sends its messages -- so only the automated
//               tests (backend/tests/invoice-reminders.test.ts) reach that state.
//   sarah-paid  A second Sarah invoice on an earlier job, already paid (AC4: no reminder, no
//               Void invoice button).
// The reminders that "were already sent" are written as already-sent messages straight into the
// notification table: nothing is queued, so nothing goes to anyone when this runs. The morning run
// (POST /api/test-data/daily/run, asked of the implementer during UAT) is what really sends:
// "due today" to sarah@idelta.com.au and "overdue" to nina@idelta.com.au, real Mailjet email.
//
// Only cast people are used: Sarah, Nina, Tom, Margaret, Bob and Dave. Nina is made here if she is
// not on file, and swept with the rest on clear; nothing changes a cast record, so there is no
// restoreCast. Needs STRIPE_SECRET_KEY (the sandbox key) in the backend .env.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { isWeekend, todayAt, zonedDateTimeToUtc } from "../../time/index.js";
import { issueInvoice } from "../../invoices/issue.js";
import { stripeProvider } from "../../invoices/stripe.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const SARAHS_SITE = { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const FREMANTLE_BILLING = { street: "14 Marine Terrace", suburb: "Fremantle", state: "WA", country: "Australia", postcode: "6160", lat: -32.0569, lng: 115.7439, placeId: null };
const KALAMUNDA = { street: "22 Haynes Street", suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.9747, lng: 116.0581, placeId: null };
const APPLECROSS = { street: "8 Ardross Street", suburb: "Applecross", state: "WA", country: "AU", postcode: "6153", lat: -32.0087, lng: 115.8398, placeId: null };

type Site = { suburb: string; state: string; country: string; postcode: string; lat: number; lng: number; placeId: string | null };

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

/** The most recent weekday before today, in the zone. */
function lastWeekday(now: Date): string {
  for (let back = 1; back < 14; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (!isWeekend(ZONE, day)) return ymdIn(day);
  }
  throw new Error("no weekday in the last fortnight");
}

/** The marker each job's description carries, so topUp can find a scenario's own records. */
const marker = (key: string): string => `[uat-6008:${key}]`;

interface Made {
  key: string;
  line: string;
}

async function buildScenario(client: PrismaClient, key: string): Promise<Made> {
  const provider = stripeProvider();
  if (provider === null) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT invoices need real sandbox pay links");
  const now = new Date();
  const day = lastWeekday(now);
  const dueAt = (daysFromToday: number): Date => new Date(todayAt(ZONE, 17, 0, now).getTime() + daysFromToday * DAY_MS);
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

  const customerByCode = (code: string) => client.customer.findUniqueOrThrow({ where: { code } });
  const plan: Record<
    string,
    { who: () => Promise<{ id: string }>; trade: "Plumbing" | "Electrical"; contractor: string; site: Site; text: string; billingHint: string }
  > = {
    "sarah-due": { who: () => customerByCode("CUS-1050"), trade: "Plumbing", contractor: "CON-014", site: SARAHS_SITE, text: "the kitchen mixer tap is leaking from the base", billingHint: "" },
    "nina-second": {
      who: async () =>
        (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
        (await client.customer.create({
          data: {
            code: await nextReference("CUS", client),
            name: "Nina Rossi",
            email: "nina@idelta.com.au",
            phone: "0400 002 060",
            businessName: "Rossi's Cafe",
            billingAddress: FREMANTLE_BILLING,
          },
        })),
      trade: "Electrical",
      contractor: "CON-021",
      site: FREMANTLE_BILLING,
      text: "the cafe's back-kitchen power points have tripped twice",
      billingHint: "",
    },
    "tom-void": { who: () => customerByCode("CUS-1052"), trade: "Plumbing", contractor: "CON-014", site: KALAMUNDA, text: "the laundry tap drips", billingHint: "" },
    margaret: { who: () => customerByCode("CUS-1053"), trade: "Plumbing", contractor: "CON-014", site: APPLECROSS, text: "the bathroom basin is slow to drain", billingHint: "" },
    "sarah-paid": { who: () => customerByCode("CUS-1050"), trade: "Plumbing", contractor: "CON-014", site: SARAHS_SITE, text: "the outside hose tap was replaced", billingHint: "" },
  };
  const spec = plan[key];
  if (spec === undefined) throw new Error(`unknown UAT scenario "${key}"`);

  const customer = await spec.who();
  const serviceType = await client.serviceType.findUniqueOrThrow({ where: { trade: spec.trade } });
  const contractor = await client.contractor.findUniqueOrThrow({ where: { code: spec.contractor }, include: { specialties: true } });
  const specialty = contractor.specialties.find((s) => s.trade === spec.trade);
  if (specialty === undefined) throw new Error(`${spec.contractor} has no ${spec.trade} specialty`);

  const slot = zonedDateTimeToUtc(ZONE, day, 8, 0);
  const job = await client.job.create({
    data: {
      reference: await nextReference("JOB", client),
      customerId: customer.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: spec.site.postcode,
      serviceLocation: { suburb: spec.site.suburb, state: spec.site.state, country: spec.site.country, lat: spec.site.lat, lng: spec.site.lng, placeId: spec.site.placeId },
      siteAddress: spec.site,
      serviceLevel: "normal",
      timezone: ZONE,
      description: `UAT 6008: ${spec.text}. ${marker(key)}`,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: "scheduled",
    },
  });
  const assignment = await client.assignment.create({
    data: { jobId: job.id, contractorId: contractor.id, specialtyId: specialty.id, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
  });
  await client.assignmentTimeLog.create({
    data: { assignmentId: assignment.id, startedAt: slot, endedAt: new Date(slot.getTime() + 3 * 60 * 60_000), note: null },
  });
  const invoice = await client.$transaction(async (tx) => {
    await tx.assignment.update({
      where: { id: assignment.id },
      data: { completionNotes: "Done and tested -- all dry.", billedHours: 3, completedAt: now, status: "completed" },
    });
    await tx.job.update({ where: { id: job.id }, data: { status: "completed" } });
    return issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [slot], billedHours: 3, now });
  });
  const row = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

  // A real sandbox link, no message sent.
  const link = await provider.createPayLink({ invoiceId: row.id, invoiceReference: row.reference, jobReference: job.reference, amount: row.amount });
  const linkUrl = link.url;
  await client.invoice.update({ where: { id: row.id }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });

  const alreadySent = async (type: "invoice_reminder_1" | "invoice_reminder_2", daysAgo: number): Promise<void> => {
    const at = ago(daysAgo);
    await client.notification.create({
      data: {
        recipientType: "customer",
        recipientId: customer.id,
        channel: "email",
        type,
        category: "transactional",
        relatedType: "invoice",
        relatedId: row.id,
        jobId: job.id,
        provider: "uat-already-sent",
        status: "sent",
        sentAt: at,
        createdAt: at,
        idempotencyKey: `${type}:invoice:${row.id}:email`,
      },
    });
  };

  const ref = `${job.reference} / ${row.reference}`;
  switch (key) {
    case "sarah-due":
      await client.invoice.update({ where: { id: row.id }, data: { dueAt: dueAt(0) } });
      return { key, line: `${ref} - Sarah's leaking-tap job, completed by Bob: $610, due today, sandbox pay link, no reminder yet` };
    case "nina-second":
      await client.invoice.update({ where: { id: row.id }, data: { dueAt: dueAt(-8) } });
      await alreadySent("invoice_reminder_1", 7);
      return { key, line: `${ref} - Nina Rossi's electrical job at Rossi's Cafe, completed by Dave: due 8 days ago, reminder 1 sent 7 days ago, sandbox pay link` };
    case "tom-void":
      await client.invoice.update({ where: { id: row.id }, data: { dueAt: dueAt(-10) } });
      await alreadySent("invoice_reminder_1", 9);
      await alreadySent("invoice_reminder_2", 2);
      return { key, line: `${ref} - Tom's laundry-tap job, completed by Bob: 10 days overdue, both reminders sent; its sandbox pay link is ${linkUrl}` };
    case "margaret":
      await client.invoice.update({ where: { id: row.id }, data: { dueAt: dueAt(-3) } });
      return { key, line: `${ref} - Margaret's basin job, completed by Bob: due 3 days ago, sandbox pay link, no reminder yet` };
    default:
      await client.invoice.update({ where: { id: row.id }, data: { dueAt: dueAt(-5), status: "paid", paidAt: ago(2) } });
      return { key, line: `${ref} - Sarah's earlier hose-tap job, completed by Bob: already paid (no reminder, no Void invoice button)` };
  }
}

const KEYS = ["sarah-due", "nina-second", "tom-void", "margaret", "sarah-paid"] as const;

export async function make(client: PrismaClient): Promise<string[]> {
  const lines: string[] = [];
  for (const key of KEYS) lines.push((await buildScenario(client, key)).line);
  return lines;
}

/** Is a scenario's newest record still as make left it? */
async function stillFresh(client: PrismaClient, key: string): Promise<boolean> {
  const job = await client.job.findFirst({ where: { description: { contains: marker(key) } }, orderBy: { createdAt: "desc" } });
  if (job === null) return false;
  const invoice = await client.invoice.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" } });
  if (invoice === null) return false;
  const reminders = await client.notification.count({
    where: { jobId: job.id, type: { in: ["invoice_reminder_1", "invoice_reminder_2"] } },
  });
  const expectedStatus = key === "sarah-paid" ? "paid" : "sent";
  const expectedReminders = key === "nina-second" ? 1 : key === "tom-void" ? 2 : 0;
  return invoice.status === expectedStatus && reminders === expectedReminders && invoice.stripePaymentLinkUrl !== null;
}

/** During UAT: remake only the scenarios the owner has used up; every other record stays as it is. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const lines: string[] = [];
  for (const key of KEYS) {
    if (await stillFresh(client, key)) continue;
    lines.push((await buildScenario(client, key)).line);
  }
  return lines;
}
