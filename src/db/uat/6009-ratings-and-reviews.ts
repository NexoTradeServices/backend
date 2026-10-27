// UAT data for feature 6009, ratings and reviews.
//
// Seven of Bob's Plumbing jobs and their reviews, so the owner can check each part from the pages
// and the inbox:
//   a. Sarah's leaking-tap job, completed by Bob, invoice unpaid with a REAL Stripe sandbox pay link;
//      her invoice email and text go, as they do live. She pays it with Stripe's test card and the
//      review request reaches sarah@ (AC1, then AC3, AC4, AC6, AC7, AC9).
//   b. A goodwill callback on (a), accepted by Bob and ready for him to Complete as "Fixing earlier
//      work - no charge": the Callback - no charge email and the review request both reach sarah@
//      (AC2, AC10). The plan named Priya; she is an electrician and cannot take a plumbing callback,
//      so Bob attends it (the Change Log says so).
//   c. Nina Rossi's job at Rossi's Cafe, completed by Bob, paid, already reviewed: 5 stars,
//      "Quick and tidy.", recommend 9; its used review link is listed (AC5, AC7, AC9).
//   d. Margaret's job, completed by Bob, paid, its review link 31 days old; the expired link is
//      listed. No email goes to her (AC5).
//   e. Tom's no-show Bob attended, call-out invoice unpaid with a sandbox pay link (his Missed visit
//      email and text go, as live): pay it and no review request appears in Messages (AC2).
//   f. Tom's completed, paid job with an OPEN review link, to try the review page without the
//      payment (AC3, AC4).
//   g, h. Two more of Tom's jobs completed by Bob and reviewed (4 stars with a comment; 5 stars with
//      none), so Bob's Reviews tab shows several, one "No comment." (AC8). Dave has none.
// Only cast people are used: Sarah, Nina, Tom, Margaret, Bob, Dave and Mike. Nina is made here if she
// is not on file (labelled, so the clear removes her). Bob's average and count are worked out from
// his reviews; restoreCast puts them back to the seed's (none).
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";
import { issueInvoice } from "../../invoices/issue.js";
import { askInvoiceMessages } from "../../invoices/messages.js";
import { stripeProvider, type PayLinkProvider } from "../../invoices/stripe.js";
import { markNoShow } from "../../jobs/no-show.js";
import { CapabilityTokenType, mintCapabilityLink } from "../../capability-tokens/index.js";
import { recomputeContractorRating } from "../../reviews/service.js";
import { isWeekend, todayAt, zonedDateTimeToUtc } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const SARAHS_SITE = { street: "5 Carrington Street", ...HILTON, postcode: "6163" };
const FREMANTLE = { suburb: "Fremantle", state: "WA", country: "AU", lat: -32.0569, lng: 115.7439, placeId: "fixture-place-fremantle" };
const ROSSIS_SITE = { street: "14 Marine Terrace", ...FREMANTLE, postcode: "6160" };
const KALAMUNDA = { street: "22 Haynes Street", suburb: "Kalamunda", state: "WA", country: "AU", postcode: "6076", lat: -31.9747, lng: 116.0581, placeId: "fixture-place-kalamunda" };

const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
type Key = (typeof KEYS)[number];
const markerOf = (key: Key): string => `[uat-6009:${key}]`;

type Site = typeof SARAHS_SITE;

function ymdIn(moment: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

/** The most recent weekday `skip` weekdays back from today, in the zone. */
function weekdayBack(now: Date, skip: number): string {
  let seen = 0;
  for (let back = 1; back < 30; back += 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    if (isWeekend(ZONE, day)) continue;
    if (seen === skip) return ymdIn(day);
    seen += 1;
  }
  throw new Error("no weekday in the last month");
}

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS));
}

/**
 * Top up, never wipe: remake only what the owner has used up. A is used once paid; B once Bob has
 * completed it; C and D are only read; E once its invoice is paid; F once its review is saved; G and
 * H are only read. A missing one is remade.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: { testData: "uat-6009", description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
      include: { invoices: { select: { status: true } }, reviews: { select: { id: true } } },
    });
    if (job === null) {
      used.add(key);
    } else if (key === "a" && job.invoices.every((invoice) => invoice.status !== "sent")) {
      used.add(key);
    } else if (key === "b" && job.status !== "scheduled") {
      used.add(key);
    } else if (key === "e" && job.invoices.every((invoice) => invoice.status !== "sent")) {
      used.add(key);
    } else if (key === "f" && job.reviews.length > 0) {
      used.add(key);
    }
  }
  // A callback needs its original to exist and unpaid-or-not alike; a remade A means a remade B.
  if (used.has("a")) used.add("b");
  return makeRecords(client, used);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.contractor.updateMany({ where: { code: "CON-014" }, data: { averageRating: null, reviewCount: null } });
}

async function makeRecords(client: PrismaClient, which: Set<Key>): Promise<string[]> {
  const provider = stripeProvider();
  if (provider === null) throw new Error("STRIPE_SECRET_KEY is not set in the backend .env -- the UAT invoices need real sandbox pay links");

  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const margaret = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
  const nina =
    (await client.customer.findUnique({ where: { email: "nina@idelta.com.au" } })) ??
    (await client.customer.create({
      data: {
        code: await nextReference("CUS", client),
        name: "Nina Rossi",
        email: "nina@idelta.com.au",
        phone: "0400 002 060",
        businessName: "Rossi's Cafe",
        billingAddress: { ...ROSSIS_SITE, country: "Australia" },
      },
    }));
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bobRow = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bobRow.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const bob = { id: bobRow.id, specialtyId: specialty.id };
  const now = new Date();
  const lines: string[] = [];
  let skip = 0;

  async function newJob(
    key: Key,
    customer: { id: string },
    description: string,
    status: "scheduled" | "completed",
    site: Site,
    parentJobId?: string,
  ) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId: customer.id,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode: site.postcode,
        serviceLocation: { suburb: site.suburb, state: site.state, country: site.country, lat: site.lat, lng: site.lng, placeId: site.placeId },
        siteAddress: site,
        ...(parentJobId === undefined ? { source: "web" as const } : { parentJobId, source: "phone" as const }),
        serviceLevel: "normal",
        timezone: ZONE,
        description: `${description} ${markerOf(key)}`,
        selectedOptions: [],
        preferredWindow: "morning",
        preferredDate: now,
        status,
      },
    });
  }

  /** A finished, invoiced visit (3.0h), paid when asked -- priced by the same step Complete uses. */
  async function completedJob(key: Key, customer: { id: string }, description: string, site: Site, paid: boolean) {
    const job = await newJob(key, customer, description, "completed", site);
    const start = zonedDateTimeToUtc(ZONE, weekdayBack(now, skip), 8, 0);
    skip += 1;
    const end = new Date(start.getTime() + 3 * 60 * 60_000);
    const assignment = await client.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bob.id,
        specialtyId: bob.specialtyId,
        status: "accepted",
        proposedSlot: start,
        confirmedSlot: start,
        acceptedAt: start,
        completionNotes: "Replaced the cartridge and re-sealed the base.\nTested for leaks -- all dry.",
        billedHours: 3,
      },
    });
    await client.assignmentTimeLog.create({ data: { assignmentId: assignment.id, startedAt: start, endedAt: end, note: null } });
    const invoice = await client.$transaction(async (tx) => {
      await tx.assignment.update({ where: { id: assignment.id }, data: { completedAt: end, status: "completed" } });
      const issued = await issueInvoice(tx, { assignmentId: assignment.id, entryStarts: [start], billedHours: 3, now: end });
      if (paid) await tx.invoice.update({ where: { id: issued.id }, data: { status: "paid", paidAt: end } });
      return issued;
    });
    return { job, assignmentId: assignment.id, invoiceId: invoice.id, completedAt: end };
  }

  /** The real sandbox link, with no message sent. */
  async function linkOnly(invoiceId: string, jobReference: string): Promise<void> {
    const invoice = await client.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const link = await (provider as PayLinkProvider).createPayLink({ invoiceId, invoiceReference: invoice.reference, jobReference, amount: invoice.amount });
    await client.invoice.update({ where: { id: invoiceId }, data: { stripePaymentLinkUrl: link.url, stripePaymentLinkId: link.id } });
  }

  async function review(jobId: string, customerId: string, rating: number, reviewText: string | null, recommendScore: number | null, at: Date): Promise<void> {
    await client.review.create({ data: { jobId, customerId, contractorId: bob.id, rating, reviewText, recommendScore, createdAt: at } });
  }

  async function reviewLink(jobId: string, state: "open" | "used" | "expired"): Promise<string> {
    const minted = await mintCapabilityLink(client, { type: CapabilityTokenType.review, jobId });
    if (state === "used") await client.capabilityToken.update({ where: { id: minted.tokenId }, data: { usedAt: now } });
    if (state === "expired") {
      await client.capabilityToken.update({
        where: { id: minted.tokenId },
        data: { createdAt: new Date(now.getTime() - 31 * DAY_MS), expiresAt: new Date(now.getTime() - DAY_MS) },
      });
    }
    return new URL(minted.url).pathname;
  }

  async function existing(key: Key) {
    return client.job.findFirst({ where: { testData: "uat-6009", description: { contains: markerOf(key) } }, orderBy: { createdAt: "desc" } });
  }

  // a. Sarah: unpaid, a real sandbox pay link; her invoice email and text go.
  let a = which.has("a") ? null : await existing("a");
  if (which.has("a") || a === null) {
    const made = await completedJob("a", sarah, "UAT 6009: the kitchen mixer tap is leaking from the base.", SARAHS_SITE, false);
    // The real sandbox link, then the same invoice email and text the pay-link loop sends live.
    await linkOnly(made.invoiceId, made.job.reference);
    await client.$transaction((tx) => askInvoiceMessages(tx, made.invoiceId));
    a = made.job;
    lines.push(`${a.reference} - Sarah's leaking-tap job, completed by Bob: invoice unpaid, sandbox pay link; her invoice email and text sent -- she pays it`);
  }

  // b. The goodwill callback on (a), accepted by Bob.
  if (which.has("b")) {
    const b = await newJob("b", sarah, "UAT 6009: the tap is dripping again.", "scheduled", SARAHS_SITE, a.id);
    const slot = new Date(todayAt(ZONE, 9, 0, now).getTime() + 2 * DAY_MS);
    const assignment = await client.assignment.create({
      data: { jobId: b.id, contractorId: bob.id, specialtyId: bob.specialtyId, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: b.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    lines.push(`${b.reference} - a callback on ${a.reference}, accepted by Bob -- he completes it as "Fixing earlier work - no charge"; both emails reach sarah@`);
  }

  // c. Nina: paid, already reviewed, its used link.
  let c = which.has("c") ? null : await existing("c");
  if (which.has("c") || c === null) {
    const made = await completedJob("c", nina, "UAT 6009: the cafe's kitchen sink is blocked.", ROSSIS_SITE, true);
    c = made.job;
    await review(c.id, nina.id, 5, "Quick and tidy.", 9, new Date(made.completedAt.getTime() + 2 * 60 * 60_000));
    const path = await reviewLink(c.id, "used");
    lines.push(`${c.reference} - Nina Rossi's job at Rossi's Cafe, completed by Bob and paid: reviewed 5 stars, "Quick and tidy.", recommend 9; its used link: ${path}`);
  }

  // d. Margaret: paid, its link 31 days old.
  let d = which.has("d") ? null : await existing("d");
  if (which.has("d") || d === null) {
    const made = await completedJob("d", margaret, "UAT 6009: the bathroom basin will not drain.", SARAHS_SITE, true);
    d = made.job;
    const path = await reviewLink(d.id, "expired");
    lines.push(`${d.reference} - Margaret's job, completed by Bob and paid, no review; its link is 31 days old (expired): ${path}`);
  }

  // e. Tom: a no-show Bob attended, call-out invoice unpaid with a sandbox link (no message sent).
  if (which.has("e")) {
    const e = await newJob("e", tom, "UAT 6009: the laundry tap drips.", "scheduled", KALAMUNDA);
    const slot = todayAt(ZONE, 10, 0, now);
    const assignment = await client.assignment.create({
      data: { jobId: e.id, contractorId: bob.id, specialtyId: bob.specialtyId, status: "accepted", proposedSlot: slot, confirmedSlot: slot, acceptedAt: now },
    });
    await client.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: e.id, assignmentId: assignment.id, startTime: slot, endTime: new Date(slot.getTime() + 60 * 60_000) },
    });
    const marked = await markNoShow(client, e.reference, mike.id, true);
    if (!marked.ok) throw new Error(`could not mark ${e.reference} a no-show: ${marked.error}`);
    // Mark no-show starts the real pay-link step for the call-out invoice (link, then the Missed visit
    // email and text, as live); wait for it rather than race it for Stripe's idempotency key.
    const invoice = await client.invoice.findFirstOrThrow({ where: { jobId: e.id }, orderBy: { createdAt: "desc" } });
    for (let tries = 0; tries < 60; tries += 1) {
      const linked = await client.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { stripePaymentLinkUrl: true } });
      if (linked.stripePaymentLinkUrl !== null) break;
      if (tries === 59) throw new Error(`Stripe did not make the pay link for ${e.reference}'s call-out invoice -- try again in a minute`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    lines.push(`${e.reference} - Tom's no-show Bob attended: call-out invoice ${invoice.reference} unpaid, sandbox pay link; his Missed visit email and text sent -- pay it and no review request follows`);
  }

  // f. Tom: paid, an OPEN review link, for trying the page without a payment.
  if (which.has("f")) {
    const made = await completedJob("f", tom, "UAT 6009: the outside hose tap leaks.", KALAMUNDA, true);
    const path = await reviewLink(made.job.id, "open");
    lines.push(`${made.job.reference} - Tom's job, completed by Bob and paid, not yet reviewed; its open review link: ${path} (add ?rating=4 to open it with 4 stars chosen)`);
  }

  // g, h. Two more reviews on Bob, one with no comment.
  if (which.has("g")) {
    const made = await completedJob("g", tom, "UAT 6009: a new washer in the garden tap.", KALAMUNDA, true);
    await review(made.job.id, tom.id, 4, "Arrived on time and explained everything.", 7, new Date(made.completedAt.getTime() + 24 * 60 * 60_000));
    lines.push(`${made.job.reference} - Tom's job, completed by Bob and paid: reviewed 4 stars, "Arrived on time and explained everything."`);
  }
  if (which.has("h")) {
    const made = await completedJob("h", tom, "UAT 6009: the toilet cistern keeps running.", KALAMUNDA, true);
    await review(made.job.id, tom.id, 5, null, null, new Date(made.completedAt.getTime() + 3 * 24 * 60 * 60_000));
    lines.push(`${made.job.reference} - Tom's job, completed by Bob and paid: reviewed 5 stars, no comment`);
  }

  await recomputeContractorRating(client, bob.id);
  return lines;
}
