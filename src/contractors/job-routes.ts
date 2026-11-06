// /api/contractor/jobs -- Feature 5001, the contractor's job screen and Complete.
//
//   GET  /api/contractor/jobs/:reference                  the screen's read
//   POST /api/contractor/jobs/:reference/on-site          the optional "On site" tap
//   POST /api/contractor/jobs/:reference/on-my-way        the optional "On my way" tap (Feature 5004)
//   PUT  /api/contractor/jobs/:reference                  Save: times, notes, parts, as a whole
//   POST /api/contractor/jobs/:reference/complete         save, then freeze
//   POST /api/contractor/jobs/:reference/receipt-signature  a signed direct upload for a receipt
//   POST /api/contractor/jobs/:reference/receipts         the upload confirmed -> an Attachment
//
// The contractor always comes from the session, never the URL; a job that is
// not his own assignment answers 404, never a hint that it exists (same door
// as dashboard-routes.ts).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { dateOnlyAsUtcMidnight, formatSlotLabel, todayIn, zonedDateTimeToUtc } from "../time/index.js";
import { holidayOn, stateOfLocation } from "../calendar/rules.js";
import { notAvailableRunsOn } from "../availability/index.js";
import { loadContractorDay } from "./day.js";
import { parseSlotInput } from "../jobs/dispatch.js";
import { bookReturnIn, parseReason, putOnHoldIn, sendHeldUpdate, sendReturnBooked, type BookedReturn, type HeldJob } from "../jobs/return-visit.js";
import { suburbOf } from "../jobs/shared.js";
import { billedHours } from "../jobs/billed-hours.js";
import { issueInvoice } from "../invoices/issue.js";
import { askCallbackNoCharge } from "../invoices/messages.js";
import { askReviewRequest } from "../reviews/messages.js";
import { earlierNotesOf, type EarlierJobNotes } from "../jobs/callbacks.js";
import { kickPayLink } from "../invoices/pay-link.js";
import { assignmentInclude, jobFactsOf, type JobFacts } from "../respond/service.js";
import { sendOnMyWay } from "../respond/messages.js";
import { onMyWayOf, todaysVisit, onMyWayKey, type OnMyWayView } from "./on-my-way.js";
import {
  isReceiptKey,
  photoUrls,
  readCloudinaryConfig,
  signReceiptUpload,
  type CloudinaryConfig,
} from "../photos/cloudinary.js";
import {
  OPEN_VISIT_STATUSES,
  Refused,
  entryViewOf,
  lockAssignment,
  lockedFailure,
  parseCompletionNotes,
  parseParts,
  parseTimeEntries,
  returnVisitMinimum,
  writeEntries,
  writeParts,
  type EntryView,
  type Failure,
  type ParsedEntry,
  type ParsedPart,
} from "../jobs/visit.js";

type WithReference = Request<{ reference: string }>;

export interface ContractorJobRoutesOptions {
  /** Feature 3003's seam, reused: the Cloudinary settings, or null for "not set up". */
  cloudinaryConfig?: () => CloudinaryConfig | null;
}

const READABLE = ["accepted", "in_progress", "completed"] as const;

export interface PartView {
  name: string;
  description: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  receiptAttachmentId: string | null;
  receipt: { fileName: string; thumbnailUrl: string; fullUrl: string } | null;
}

export interface UnpaidPaymentView {
  /** Whole cents, GST-inclusive -- the customer's total. */
  amount: number;
  paid: false;
  payLinkUrl: string | null;
  /** sent: email and text have both gone; failed: one could not be sent; sending: still on its way (or waiting for the link). */
  messages: "sent" | "sending" | "failed";
}

/** Feature 6002: once paid the card stays, with the total and nothing more to collect -- no link, no messages. */
export interface PaidPaymentView {
  amount: number;
  paid: true;
}

export type PaymentView = UnpaidPaymentView | PaidPaymentView;

/**
 * Feature 5002: a second visit row only comes from a booked return. Bob holds as many rows as the
 * assignment has booked blocks, and never fewer than the rows already saved (old data, a hold that
 * took the time off, Mike's own additions stay editable).
 */
async function visitsAllowedOf(db: Pick<PrismaClient, "calendarEvent">, assignmentId: string, saved: number): Promise<number> {
  const blocks = await db.calendarEvent.count({ where: { assignmentId, type: "job" } });
  return Math.max(blocks, saved, 1);
}

/** Feature 5002: the saved rows whose visit is over -- one per booked block after the first, never more than are saved. */
async function lockedVisitsOf(db: Pick<PrismaClient, "calendarEvent">, assignmentId: string, saved: number): Promise<number> {
  const blocks = await db.calendarEvent.count({ where: { assignmentId, type: "job" } });
  return Math.min(saved, Math.max(0, blocks - 1));
}

/** Feature 5002: inside the locked transaction, refuse a save that changes an earlier visit's row. */
async function holdEarlierVisits(tx: Prisma.TransactionClient, assignmentId: string, entries: readonly ParsedEntry[]): Promise<void> {
  const saved = await tx.assignmentTimeLog.findMany({ where: { assignmentId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
  const locked = saved.slice(0, await lockedVisitsOf(tx, assignmentId, saved.length));
  for (const row of locked) {
    const kept = entries.some(
      (entry) => entry.startedAt.getTime() === row.startedAt.getTime() && entry.endedAt.getTime() === row.endedAt.getTime() && (entry.note ?? "") === (row.note ?? ""),
    );
    if (!kept) throw new Refused({ ok: false, status: 409, error: "An earlier visit is over - ask the office to change it.", field: "timeEntries" });
  }
}

/** Feature 5002: inside the locked transaction, refuse a visit row no booked block stands behind. */
async function holdVisitLimit(tx: Prisma.TransactionClient, assignmentId: string, entries: readonly ParsedEntry[]): Promise<void> {
  await holdEarlierVisits(tx, assignmentId, entries);
  const rows = entries.length;
  const saved = await tx.assignmentTimeLog.count({ where: { assignmentId } });
  if (rows > (await visitsAllowedOf(tx, assignmentId, saved))) {
    throw new Refused({ ok: false, status: 409, error: "Book a return visit to add another visit.", field: "timeEntries" });
  }
}

async function returnVisitOf(db: Pick<PrismaClient, "returnReason">, assignmentId: string): Promise<ContractorJobView["returnVisit"]> {
  const row = await db.returnReason.findFirst({ where: { assignmentId }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  if (row === null) return null;
  return { reason: row.reason, otherText: row.otherText ?? "", officeNote: row.officeNote ?? "" };
}

/**
 * Feature 5002: "I've arrived" is for the visit that is due -- the next booked block not yet worked
 * (blocks in order, one per saved visit row) -- on its day or after it. Days before it, the screen
 * only says when the next visit is.
 */
async function visitDueBy(db: Pick<PrismaClient, "calendarEvent">, assignmentId: string, worked: number, zone: string, now: Date): Promise<boolean> {
  const blocks = await db.calendarEvent.findMany({
    where: { assignmentId, type: "job" },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    select: { startTime: true },
  });
  const next = blocks[worked];
  if (next === undefined) return blocks.length === 0; // no block at all (an old record): nothing to wait for
  return todayIn(zone, next.startTime) <= todayIn(zone, now);
}

export interface ContractorJobView extends JobFacts {
  reference: string;
  jobStatus: string;
  assignmentStatus: string;
  customerName: string;
  suburb: string;
  postcode: string;
  slotLabel: string | null;
  timeEntries: EntryView[];
  completionNotes: string;
  parts: PartView[];
  /**
   * Feature 6001: what Bob can tell the customer standing in front of him -- the total she
   * pays (whole cents, GST-inclusive; never his own pay), whether the invoice email and text
   * have gone, and the pay link as a QR. `payLinkUrl` is null while Stripe has not answered.
   * Null when there is nothing to pay (no invoice yet, or a zero-dollar one).
   */
  payment: PaymentView | null;
  /** Live, from what is saved; the screen recomputes it as he types. */
  billedHours: number;
  returnVisitMinimumMinutes: number;
  /** Cents, from settings -- the cap per part line. */
  maxContractorPartAmount: number;
  /** Completed: every control is locked. */
  frozen: boolean;
  /** "On site" is offered only while the visit is accepted. */
  canOnSite: boolean;
  /** Feature 5002: Book a return visit is offered on a scheduled or in-progress job whose visit is still open. */
  canBookReturn: boolean;
  /** Feature 5002: how many visit rows Bob may hold -- one per booked block, never fewer than the rows already saved. */
  visitsAllowed: number;
  /** Feature 5002: how many of the first saved visit rows are earlier visits (a return is booked after them): locked. */
  lockedVisits: number;
  /** Feature 5002: the Reason on the latest return asked for on this visit, or null. */
  returnVisit: { reason: "part_on_order" | "more_time_needed" | "other"; otherText: string; officeNote: string } | null;
  /** Feature 5004: null (no visit booked today), or whether On my way has gone for today's visit. */
  onMyWay: OnMyWayView;
  timezone: string;
  /** Feature 6004: the root original's reference when this job is a callback, else null. */
  callbackOn: string | null;
  /** Feature 6004: the original's notes, then each earlier finished callback's, oldest first; empty once his booking is over. */
  earlierNotes: EarlierJobNotes[];
  /** Feature 6004: his pick on a callback, true (charged), false (no charge) or null (not picked yet). */
  callbackChargeable: boolean | null;
}

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

function send(res: Response, failure: Failure): void {
  res.status(failure.status).json({ error: failure.error, field: failure.field });
}

/** His own assignment on the job, in a status the screen can show -- else null (a 404). */
async function loadOwn(client: PrismaClient, userId: string, reference: string) {
  return client.assignment.findFirst({
    where: {
      job: { reference },
      contractor: { userId },
      status: { in: [...READABLE] },
    },
    include: { ...assignmentInclude, timeLogs: true, parts: { include: { receiptAttachment: true } } },
  });
}

type OwnAssignment = NonNullable<Awaited<ReturnType<typeof loadOwn>>>;

/** Where the invoice's email and text stand, for Bob's confirmation line (a reissued invoice's are the Updated invoice kind -- Feature 6007). */
async function paymentOf(
  client: PrismaClient,
  invoice: { id: string; amount: number; stripePaymentLinkUrl: string | null },
): Promise<UnpaidPaymentView> {
  const rows = await client.notification.findMany({
    where: { relatedType: "invoice", relatedId: invoice.id, type: { in: ["invoice", "invoice_updated"] } },
    select: { channel: true, status: true },
  });
  const wentOut = (channel: "email" | "sms"): boolean =>
    rows.some((row) => row.channel === channel && (row.status === "sent" || row.status === "delivered"));
  const failed = (channel: "email" | "sms"): boolean =>
    !wentOut(channel) && rows.some((row) => row.channel === channel && row.status === "failed");
  const messages = wentOut("email") && wentOut("sms") ? "sent" : failed("email") || failed("sms") ? "failed" : "sending";
  return { amount: invoice.amount, paid: false, payLinkUrl: invoice.stripePaymentLinkUrl, messages };
}

async function viewOf(client: PrismaClient, assignment: OwnAssignment, now: Date): Promise<ContractorJobView> {
  const job = assignment.job;
  const zone = job.timezone;
  const settings = await client.platformSettings.findFirst({
    select: { returnVisitMinimumMinutes: true, maxContractorPartAmount: true },
  });
  const minimum = settings?.returnVisitMinimumMinutes ?? 30;
  const logs = [...assignment.timeLogs].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
  );
  const slot = job.status === "on_hold" ? null : (assignment.confirmedSlot ?? assignment.proposedSlot);
  const cloudName = process.env["CLOUDINARY_CLOUD_NAME"]?.trim();
  const facts = await jobFactsOf(client, job);
  const invoice =
    assignment.invoiceId === null
      ? null
      : await client.invoice.findUnique({
          where: { id: assignment.invoiceId },
          select: { id: true, amount: true, status: true, isZeroDollar: true, stripePaymentLinkUrl: true },
        });
  const payable = invoice !== null && invoice.status === "sent" && !invoice.isZeroDollar;
  const paid = invoice !== null && invoice.status === "paid" && !invoice.isZeroDollar;
  const payment: PaymentView | null = paid
    ? { amount: invoice.amount, paid: true }
    : !payable
      ? null
      : await paymentOf(client, invoice);

  const root =
    job.parentJobId === null ? null : await client.job.findUnique({ where: { id: job.parentJobId }, select: { reference: true } });

  return {
    ...facts,
    callbackOn: root?.reference ?? null,
    earlierNotes: await earlierNotesOf(client, job, assignment.status === "accepted" || assignment.status === "in_progress"),
    callbackChargeable: assignment.callbackChargeable,
    reference: job.reference,
    jobStatus: job.status,
    assignmentStatus: assignment.status,
    customerName: job.customer.name,
    suburb: suburbOf(job.serviceLocation),
    postcode: job.postcode,
    slotLabel: slot === null ? null : formatSlotLabel(zone, slot, now),
    timeEntries: logs.map((row) => entryViewOf(row, zone)),
    completionNotes: assignment.completionNotes ?? "",
    parts: [...assignment.parts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((part) => ({
        name: part.name,
        description: part.description ?? "",
        qty: Number(part.qty),
        unitPrice: part.unitPrice,
        lineTotal: part.lineTotal,
        receiptAttachmentId: part.receiptAttachmentId,
        receipt:
          part.receiptAttachment === null || !cloudName
            ? null
            : {
                fileName: part.receiptAttachment.fileName,
                ...photoUrls(part.receiptAttachment.storageKey, cloudName),
              },
      })),
    payment,
    billedHours:
      assignment.status === "completed" && assignment.billedHours !== null
        ? Number(assignment.billedHours)
        : billedHours(logs, minimum),
    returnVisitMinimumMinutes: minimum,
    maxContractorPartAmount: settings?.maxContractorPartAmount ?? 15_000,
    frozen: assignment.status === "completed",
    canOnSite: assignment.status === "accepted" && job.status === "scheduled" && (await visitDueBy(client, assignment.id, logs.length, zone, now)),
    returnVisit: await returnVisitOf(client, assignment.id),
    visitsAllowed: await visitsAllowedOf(client, assignment.id, logs.length),
    lockedVisits: await lockedVisitsOf(client, assignment.id, logs.length),
    canBookReturn: (job.status === "scheduled" || job.status === "in_progress") && (assignment.status === "accepted" || assignment.status === "in_progress"),
    onMyWay: await onMyWayOf(
      client,
      { id: assignment.id, jobStatus: job.status, assignmentStatus: assignment.status, timezone: zone },
      now,
    ),
    timezone: zone,
  };
}

interface VisitInput {
  entries: ParsedEntry[];
  notes: string | null;
  parts: ParsedPart[];
}

function parseVisit(body: unknown, zone: string, maxAmount: number): { ok: true; input: VisitInput } | Failure {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const entries = parseTimeEntries(b["timeEntries"] ?? [], zone);
  if (!entries.ok) return entries;
  const notes = parseCompletionNotes(b["completionNotes"]);
  if (!notes.ok) return notes;
  const parts = parseParts(b["parts"], maxAmount);
  if (!parts.ok) return parts;
  return { ok: true, input: { entries: entries.entries, notes: notes.notes, parts: parts.parts } };
}

export function contractorJobRoutes(client: PrismaClient, options: ContractorJobRoutesOptions = {}): Router {
  const router = createRouter();
  const cloudinaryConfig = options.cloudinaryConfig ?? readCloudinaryConfig;

  /** The route's first move: session -> his own assignment, or a 404. */
  async function own(req: WithReference, res: Response): Promise<OwnAssignment | null> {
    if (!req.authUser) {
      res.status(401).json({ error: "not authenticated" });
      return null;
    }
    const assignment = await loadOwn(client, req.authUser.id, req.params.reference);
    if (assignment === null) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return assignment;
  }

  router.get("/:reference", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      res.json(await viewOf(client, assignment, new Date()));
    })().catch(failWith(res, "GET /api/contractor/jobs/:reference"));
  });

  // Feature 6004: one earlier job's notes (the original or an earlier callback), read-only -- found
  // only among the notes on his own callback, so only while HIS booking on it is open.
  router.get("/:reference/earlier/:earlier", requireRole(Role.contractor), (req: Request<{ reference: string; earlier: string }>, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const open = assignment.status === "accepted" || assignment.status === "in_progress";
      const notes = await earlierNotesOf(client, assignment.job, open);
      const found = notes.find((note) => note.reference === req.params.earlier);
      if (found === undefined) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(found);
    })().catch(failWith(res, "GET /api/contractor/jobs/:reference/earlier/:earlier"));
  });

  router.post("/:reference/on-site", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const refused = await client.$transaction(async (tx): Promise<Failure | null> => {
        const locked = await lockAssignment(tx, assignment.jobId, assignment.id);
        if (locked.status === "in_progress") return null; // a second tap changes nothing
        if (locked.status !== "accepted") return lockedFailure(locked.status);
        await tx.assignment.update({ where: { id: locked.id }, data: { status: "in_progress" } });
        await tx.job.update({ where: { id: locked.jobId }, data: { status: "in_progress" } });
        return null;
      });
      if (refused !== null) {
        send(res, refused);
        return;
      }
      const fresh = await loadOwn(client, req.authUser?.id ?? "", req.params.reference);
      if (fresh === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await viewOf(client, fresh, new Date()));
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/on-site"));
  });

  // Feature 5004: the optional "On my way" tap. Changes no status. No visit today -> 409; already
  // sent for that visit -> 200 and nothing more is asked (the keys would land on the same rows anyway).
  router.post("/:reference/on-my-way", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const input = {
        id: assignment.id,
        jobStatus: assignment.job.status,
        assignmentStatus: assignment.status,
        timezone: assignment.job.timezone,
      };
      const visit = await todaysVisit(client, input, new Date());
      if (visit === null) {
        res.status(409).json({ error: "There is no visit booked for today." });
        return;
      }
      const already = await client.notification.findUnique({
        where: { idempotencyKey: onMyWayKey(assignment.id, visit.calendarEventId) },
        select: { id: true },
      });
      if (already === null) await sendOnMyWay(client, assignment.id, visit.calendarEventId);
      res.json(await viewOf(client, assignment, new Date()));
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/on-my-way"));
  });

  /** Save and Complete share this: parse, lock, write -- Complete adds its two needs and the freeze. */
  async function saveVisit(req: WithReference, res: Response, complete: boolean): Promise<void> {
    const assignment = await own(req, res);
    if (assignment === null) return;
    const settings = await client.platformSettings.findFirst({ select: { maxContractorPartAmount: true } });
    const parsed = parseVisit(req.body, assignment.job.timezone, settings?.maxContractorPartAmount ?? 15_000);
    if (!parsed.ok) {
      send(res, parsed);
      return;
    }
    const { entries, notes, parts } = parsed.input;
    // Feature 6004: "This callback is" belongs to a callback only; a normal job refuses a value.
    const isCallback = assignment.job.parentJobId !== null;
    const bodyRaw = req.body !== null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const sent = bodyRaw["callbackChargeable"];
    if (sent !== undefined && sent !== null && typeof sent !== "boolean") {
      send(res, { ok: false, status: 400, error: "callbackChargeable must be true, false or null", field: "callbackChargeable" });
      return;
    }
    if (!isCallback && typeof sent === "boolean") {
      send(res, { ok: false, status: 400, error: "Only a callback has this choice.", field: "callbackChargeable" });
      return;
    }
    const chargeable: boolean | null = !isCallback ? null : sent === undefined ? assignment.callbackChargeable : sent;
    if (complete) {
      if (isCallback && chargeable === null) {
        send(res, { ok: false, status: 400, error: "Pick whether this callback is charged.", field: "callbackChargeable" });
        return;
      }
      if (entries.length === 0) {
        send(res, { ok: false, status: 400, error: "Add at least one visit.", field: "timeEntries" });
        return;
      }
      if (notes === null) {
        send(res, { ok: false, status: 400, error: "Required.", field: "completionNotes" });
        return;
      }
    }
    const minimum = await returnVisitMinimum(client);
    let issuedInvoiceId: string | null = null;
    try {
      await client.$transaction(async (tx) => {
        const locked = await lockAssignment(tx, assignment.jobId, assignment.id);
        if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(locked.status)) throw new Refused(lockedFailure(locked.status));
        await holdVisitLimit(tx, locked.id, entries);
        await writeEntries(tx, locked.id, entries);
        await writeParts(tx, locked.id, parts);
        if (!complete) {
          await tx.assignment.update({
            where: { id: locked.id },
            data: { completionNotes: notes, ...(isCallback ? { callbackChargeable: chargeable } : {}) },
          });
          return;
        }
        // Freeze the visit AND issue its invoice in this one transaction (Feature 6001): a
        // completed visit never exists without its invoice. Nothing is sent here -- the pay
        // link is made after the commit, and the invoice email and text go once it exists.
        const completedAt = new Date();
        const hours = billedHours(entries, minimum);
        await tx.assignment.update({
          where: { id: locked.id },
          data: {
            completionNotes: notes,
            billedHours: hours,
            completedAt,
            status: "completed",
            ...(isCallback ? { callbackChargeable: chargeable } : {}),
          },
        });
        await tx.job.update({ where: { id: locked.jobId }, data: { status: "completed" } });
        const invoice = await issueInvoice(tx, {
          assignmentId: locked.id,
          entryStarts: entries.map((entry) => entry.startedAt),
          billedHours: hours,
          now: completedAt,
        });
        // Goodwill: no pay link will ever exist, so the customer is told here instead (6004).
        if (chargeable === false) {
          await askCallbackNoCharge(tx, invoice.id);
          // Feature 6009: no payment will ever follow, so the review is asked for here, beside it.
          await askReviewRequest(tx, locked.jobId);
        }
        else issuedInvoiceId = invoice.id;
      });
    } catch (error: unknown) {
      if (error instanceof Refused) {
        send(res, error.failure);
        return;
      }
      throw error;
    }
    // The normal case goes out within seconds; if Stripe does not answer, the loop keeps asking.
    if (issuedInvoiceId !== null) kickPayLink(client, issuedInvoiceId);
    const fresh = await loadOwn(client, req.authUser?.id ?? "", req.params.reference);
    if (fresh === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(await viewOf(client, fresh, new Date()));
  }

  // Feature 5002: Book a return visit (or Not yet). Saves the screen's times, notes and parts with the booking in ONE
  // transaction -- a refused booking saves nothing. Needs a time entry dated today in the job's zone.
  router.post("/:reference/return-visit", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const zone = assignment.job.timezone;
      const settings = await client.platformSettings.findFirst({ select: { maxContractorPartAmount: true } });
      const parsed = parseVisit(req.body, zone, settings?.maxContractorPartAmount ?? 15_000);
      if (!parsed.ok) {
        send(res, parsed);
        return;
      }
      const body = req.body !== null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const reason = parseReason(body);
      if (!reason.ok) {
        send(res, reason);
        return;
      }
      const notYet = body["notYet"] === true;
      let slot: ReturnType<typeof parseSlotInput> | null = null;
      if (!notYet) {
        slot = parseSlotInput(body["slot"] !== null && typeof body["slot"] === "object" ? (body["slot"] as Record<string, unknown>) : {});
        if (!slot.ok) {
          send(res, { ok: false, status: slot.status, error: slot.error, field: slot.field ?? "slot" });
          return;
        }
      }
      const now = new Date();
      const today = todayIn(zone, now);
      if (!parsed.input.entries.some((entry) => todayIn(zone, entry.startedAt) === today)) {
        send(res, { ok: false, status: 400, error: "Enter today's time on site first.", field: "timeEntries" });
        return;
      }
      let booked: BookedReturn | null = null;
      let held: HeldJob | null = null;
      try {
        await client.$transaction(async (tx) => {
          const locked = await lockAssignment(tx, assignment.jobId, assignment.id);
          if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(locked.status)) throw new Refused(lockedFailure(locked.status));
          await holdVisitLimit(tx, locked.id, parsed.input.entries);
          await writeEntries(tx, locked.id, parsed.input.entries);
          await writeParts(tx, locked.id, parsed.input.parts);
          await tx.assignment.update({ where: { id: locked.id }, data: { completionNotes: parsed.input.notes } });
          const actor = { kind: "contractor" as const, userId: req.authUser?.id ?? "" };
          if (notYet) {
            held = await putOnHoldIn(tx, { jobId: locked.jobId, assignmentId: locked.id, actor, reason: reason.data, now });
          } else if (slot?.ok) {
            booked = await bookReturnIn(tx, { jobId: locked.jobId, assignmentId: locked.id, actor, reason: reason.data, slot: slot.data, now });
          }
        });
      } catch (error: unknown) {
        if (error instanceof Refused) {
          send(res, error.failure);
          return;
        }
        throw error;
      }
      if (booked !== null) await sendReturnBooked(client, booked, now);
      if (held !== null) await sendHeldUpdate(client, held, now);
      const fresh = await loadOwn(client, req.authUser?.id ?? "", req.params.reference);
      if (fresh === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ ...(await viewOf(client, fresh, new Date())), returnBooked: booked === null ? null : { label: (booked as BookedReturn).bannerLabel } });
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/return-visit"));
  });

  // Feature 5002: the return picker's day -- his own calendar for the date, in the job's zone, the hours he has switched
  // off (he may still book them), and whether the date is a holiday.
  router.get("/:reference/day", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const date = req.query["date"];
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: "date must be a YYYY-MM-DD date" });
        return;
      }
      const zone = assignment.job.timezone;
      const contractor = await client.contractor.findUniqueOrThrow({
        where: { id: assignment.contractorId },
        select: { id: true, operatingState: true, defaultOpening: true, defaultClosing: true },
      });
      const hours = await client.platformSettings.findFirstOrThrow({ select: { openingTime: true, closingTime: true } });
      const dayStart = zonedDateTimeToUtc(zone, date, 0, 0);
      const next = new Date(dateOnlyAsUtcMidnight(date).getTime() + 86_400_000).toISOString().slice(0, 10);
      const dayEnd = zonedDateTimeToUtc(zone, next, 0, 0);
      const state = stateOfLocation(assignment.job.serviceLocation);
      const holiday = state === null ? null : await holidayOn(client, state, date);
      res.json({
        blocks: await loadContractorDay(client, contractor.id, date, zone),
        notAvailable: await notAvailableRunsOn(client, contractor, dayStart, dayEnd),
        closed: holiday?.name ?? null,
        openingTime: hours.openingTime,
        closingTime: hours.closingTime,
        timezone: zone,
      });
    })().catch(failWith(res, "GET /api/contractor/jobs/:reference/day"));
  });

  router.put("/:reference", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void saveVisit(req, res, false).catch(failWith(res, "PUT /api/contractor/jobs/:reference"));
  });

  router.post("/:reference/complete", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void saveVisit(req, res, true).catch(failWith(res, "POST /api/contractor/jobs/:reference/complete"));
  });

  // A receipt upload is for a contractor on his own OPEN assignment, in the
  // receipts folder -- never the enquiry folder. Not set up -> 503 and the
  // part cannot be added; the rest of the screen still saves.
  router.post("/:reference/receipt-signature", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(assignment.status)) {
        send(res, lockedFailure(assignment.status));
        return;
      }
      const config = cloudinaryConfig();
      if (config === null) {
        res.status(503).json({ error: "photo upload is unavailable" });
        return;
      }
      res.json(signReceiptUpload(config));
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/receipt-signature"));
  });

  router.post("/:reference/receipts", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(assignment.status)) {
        send(res, lockedFailure(assignment.status));
        return;
      }
      const b = req.body !== null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const storageKey = typeof b["storageKey"] === "string" ? b["storageKey"].trim() : "";
      const fileName = typeof b["fileName"] === "string" ? b["fileName"].trim().slice(0, 200) : "";
      if (!isReceiptKey(storageKey)) {
        res.status(400).json({ error: "not a receipt upload", field: "storageKey" });
        return;
      }
      const row = await client.attachment.create({
        data: {
          jobId: assignment.jobId,
          assignmentId: assignment.id,
          uploadedByRole: "contractor",
          storageKey,
          fileName: fileName === "" ? "receipt" : fileName,
        },
      });
      const cloudName = process.env["CLOUDINARY_CLOUD_NAME"]?.trim();
      res.status(201).json({
        id: row.id,
        fileName: row.fileName,
        ...(cloudName ? photoUrls(row.storageKey, cloudName) : { thumbnailUrl: "", fullUrl: "" }),
      });
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/receipts"));
  });

  return router;
}
