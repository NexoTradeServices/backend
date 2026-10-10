// UAT data for feature 4010, the customer rating card on the ops job page.
//
// Four customers, each with a fresh open job (the one Mike opens) and the history the card reads:
//   1. Sarah: 7 completed jobs in the last 12 months, nothing owed, no notes -- Regular customer.
//   2. Tom: 3 completed jobs in the last 12 months; 2 no-show jobs (one with a call-out invoice,
//      one waived); 1 job cancelled after Bob had accepted it and 1 cancelled before any booking;
//      a dispute note on one job; 1 overdue invoice and 1 not yet due -- Returning customer.
//   3. Margaret: 1 completed job 14 months ago -- Old customer.
//   4. Karl: nothing before his first job -- First-time customer.
// Only cast people are used. Sarah, Tom and Margaret are seeded and never changed (the history
// jobs are labelled, so the clear removes them); Karl is made here, labelled, and cleared too.
// Nothing changes a cast record, so there is no restoreCast. Nothing here sends a message.
import type { PrismaClient } from "../client.js";
import { nextReference } from "../reference.js";

const ZONE = "Australia/Perth";
const DAY = 86_400_000;
const HILTON = { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
const KALAMUNDA = { suburb: "Kalamunda", state: "WA", country: "AU", lat: -31.974211, lng: 116.051444, placeId: "fixture-place-kalamunda" };
const APPLECROSS = { suburb: "Applecross", state: "WA", country: "AU", lat: -32.015475, lng: 115.836868, placeId: "fixture-place-applecross" };
const JOONDALUP = { suburb: "Joondalup", state: "WA", country: "AU", lat: -31.7448, lng: 115.7661, placeId: "fixture-place-joondalup" };

const KEYS = ["sarah", "tom", "margaret", "karl"] as const;
type Key = (typeof KEYS)[number];
/** The marker each fresh job's description carries, so a top-up can find it. */
const markerOf = (key: Key): string => `[uat-4010:${key}]`;

export async function make(client: PrismaClient): Promise<string[]> {
  return makeRecords(client, new Set(KEYS), true);
}

/**
 * Top up, never wipe: a fresh job is used up once it is no longer new (the owner cancelled or
 * dispatched it). Remake only those, as fresh jobs; the history is never remade.
 */
export async function topUp(client: PrismaClient): Promise<string[]> {
  const used = new Set<Key>();
  for (const key of KEYS) {
    const job = await client.job.findFirst({
      where: { testData: "uat-4010", description: { contains: markerOf(key) } },
      orderBy: { createdAt: "desc" },
    });
    if (job === null || job.status !== "new") used.add(key);
  }
  return makeRecords(client, used, false);
}

async function makeRecords(client: PrismaClient, which: Set<Key>, withHistory: boolean): Promise<string[]> {
  const sarah = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const tom = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1052" } });
  const margaret = await client.customer.findUniqueOrThrow({ where: { code: "CUS-1053" } });
  const mike = await client.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" }, select: { id: true } });
  const plumbing = await client.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await client.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("Bob has no Plumbing specialty");
  const specialtyId = specialty.id;
  const now = new Date();
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY);
  const lines: string[] = [];

  interface HistoryOptions {
    status: "completed" | "cancelled";
    cancelReason?: "customer_no_show" | "customer_changed_mind";
    /** completed assignment, or cancelled after an acceptance; null = no booking at all. */
    booking: "completed" | "cancelled-accepted" | null;
    days: number;
    note?: { type: string; note: string };
    invoice?: { amount: number; dueInDays: number; status: "sent" | "paid"; callout?: boolean };
    description: string;
  }

  async function baseJob(customerId: string, place: typeof HILTON, postcode: string, description: string, status: string, extra: object = {}) {
    return client.job.create({
      data: {
        reference: await nextReference("JOB", client),
        customerId,
        serviceTypeId: plumbing.id,
        customerCalloutRate: plumbing.customerCalloutRate,
        customerStandardRate: plumbing.customerStandardRate,
        postcode,
        serviceLocation: { ...place },
        timezone: ZONE,
        description,
        selectedOptions: [],
        source: "web",
        preferredWindow: "morning",
        preferredDate: now,
        status: status as "new" | "completed" | "cancelled",
        ...extra,
      },
    });
  }

  async function history(customerId: string, place: typeof HILTON, postcode: string, options: HistoryOptions): Promise<string> {
    const at = ago(options.days);
    const job = await baseJob(customerId, place, postcode, `UAT 4010 history: ${options.description}`, options.status, {
      serviceLevel: "normal",
      ...(options.cancelReason === undefined ? {} : { cancelReason: options.cancelReason, cancelledAt: at, cancelledByUserId: mike.id }),
      ...(options.note === undefined
        ? {}
        : {
            operatorNotes: [
              { id: `uat-4010-${String(Date.now())}-${options.description.length}`, at: at.toISOString(), operatorId: mike.id, type: options.note.type, note: options.note.note },
            ],
          }),
    });
    if (options.booking !== null) {
      const assignment = await client.assignment.create({
        data: {
          jobId: job.id,
          contractorId: bob.id,
          specialtyId,
          status: options.booking === "completed" ? "completed" : "cancelled",
          proposedSlot: at,
          confirmedSlot: at,
          acceptedAt: new Date(at.getTime() - DAY),
          ...(options.booking === "completed" ? { completedAt: at } : { cancelledAt: at }),
        },
      });
      if (options.invoice) {
        const amount = options.invoice.amount;
        const invoice = await client.invoice.create({
          data: {
            reference: await nextReference("INV", client),
            jobId: job.id,
            assignmentId: assignment.id,
            customerId,
            amount,
            labourAmount: amount,
            materialsAmount: 0,
            gstAmount: 0,
            gstApplied: false,
            billedTo: { name: "UAT 4010" },
            status: options.invoice.status,
            dueAt: ago(-options.invoice.dueInDays),
            sentAt: at,
          },
        });
        if (options.invoice.callout) {
          await client.invoiceLine.create({
            data: { invoiceId: invoice.id, kind: "callout", description: "Call-out", qty: 1, unitPrice: amount, lineTotal: amount },
          });
        }
      }
    }
    return job.reference;
  }

  async function fresh(key: Key, customerId: string, place: typeof HILTON, postcode: string, text: string): Promise<string> {
    const job = await baseJob(customerId, place, postcode, `${text} ${markerOf(key)}`, "new");
    return job.reference;
  }

  if (which.has("sarah")) {
    if (withHistory) {
      for (let i = 0; i < 7; i += 1) {
        await history(sarah.id, HILTON, "6163", { status: "completed", booking: "completed", days: 12 + i * 40, description: `Sarah job ${String(i + 1)}` });
      }
    }
    const reference = await fresh("sarah", sarah.id, HILTON, "6163", "UAT 4010: the kitchen mixer tap is leaking from the base.");
    lines.push(`${reference} - Sarah's fresh job in Hilton (7 completed jobs behind her, nothing owed): Regular customer, "7 jobs in the last 12 months", every figure 0`);
  }

  if (which.has("tom")) {
    if (withHistory) {
      await history(tom.id, KALAMUNDA, "6076", {
        status: "completed", booking: "completed", days: 15, description: "Tom completed job, overdue invoice",
        invoice: { amount: 32_000, dueInDays: -5, status: "sent" },
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "completed", booking: "completed", days: 45, description: "Tom completed job, invoice not yet due",
        invoice: { amount: 16_000, dueInDays: 10, status: "sent" },
        note: { type: "dispute", note: "Tom disputes the hours billed." },
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "completed", booking: "completed", days: 90, description: "Tom completed job, paid",
        invoice: { amount: 12_000, dueInDays: -60, status: "paid" },
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "cancelled", cancelReason: "customer_no_show", booking: "cancelled-accepted", days: 60, description: "Tom no-show, call-out charged",
        invoice: { amount: 18_000, dueInDays: -30, status: "paid", callout: true },
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "cancelled", cancelReason: "customer_no_show", booking: "cancelled-accepted", days: 100, description: "Tom no-show, call-out waived",
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "cancelled", cancelReason: "customer_changed_mind", booking: "cancelled-accepted", days: 130, description: "Tom cancelled after Bob accepted",
      });
      await history(tom.id, KALAMUNDA, "6076", {
        status: "cancelled", cancelReason: "customer_changed_mind", booking: null, days: 150, description: "Tom cancelled before any booking",
      });
    }
    const reference = await fresh("tom", tom.id, KALAMUNDA, "6076", "UAT 4010: a blocked kitchen sink.");
    lines.push(
      `${reference} - Tom's fresh job in Kalamunda: Returning customer, "3 jobs in the last 12 months"; Missed visits 2 (1 waived), Late cancellations 1, Disputes 1, Overdue invoices 1, Total due $480`,
    );
  }

  if (which.has("margaret")) {
    if (withHistory) {
      await history(margaret.id, APPLECROSS, "6153", { status: "completed", booking: "completed", days: 425, description: "Margaret job 14 months ago" });
    }
    const reference = await fresh("margaret", margaret.id, APPLECROSS, "6153", "UAT 4010: the garden tap is dripping.");
    lines.push(`${reference} - Margaret's fresh job in Applecross (one completed job 14 months ago): Old customer, "No jobs in the last 12 months - last job ...", figures still shown`);
  }

  if (which.has("karl")) {
    const existing = await client.customer.findFirst({ where: { email: "karl@idelta.com.au" } });
    const karl =
      existing ??
      (await client.customer.create({
        data: { code: await nextReference("CUS", client), name: "Karl", email: "karl@idelta.com.au", phone: "0400 002 070" },
      }));
    const reference = await fresh("karl", karl.id, JOONDALUP, "6027", "UAT 4010: a burst pipe under the laundry.");
    lines.push(`${reference} - Karl's first job in Joondalup: First-time customer, "No earlier jobs with us", figures all 0`);
  }

  return lines;
}
