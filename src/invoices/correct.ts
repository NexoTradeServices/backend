// Correct & reissue -- Feature 6007.
//
// Ops job actions / Correct & reissue. Mike fixes a completed visit after the fact: its time on
// site and its customer-side prices (DOWN only). ONE module, three doors:
//
//   correctionForm   the starting figures of the page (GET)
//   previewCorrection the What happens card, for given inputs, nothing saved (POST .../preview)
//   correctAndReissue does it (POST ...)
//
// THE CUSTOMER SIDE follows the invoice's state:
//   unpaid  -> voided (old -> new in the void reason), a new invoice issued with `replacesInvoiceId`,
//              the same `gstApplied`, lines worded as at issue, a fresh pay link (the pay-link loop
//              makes it and asks the Updated invoice message instead of the Invoice message);
//   paid    -> stays paid; the overcharge goes back as a partial refund (`makeRefund`), less refunds
//              already made, never more than is left;
//   neither -> hours went up, prices unchanged, a $0 invoice, a voided one: no invoice action.
// The customer is never billed for hours added later: her hours are the LOWER of the new and the
// invoiced hours. "Can only go down" is measured from the invoice being replaced.
//
// THE CONTRACTOR SIDE follows the corrected HOURS (a price never touches his pay), by where the
// visit sits: not on a settlement -> `contractorPay` recomputed; on his unapproved draft -> recomputed
// and the draft rebuilt through the sweep; on an approved or paid week -> his pay stays as paid and a
// signed `correction` row waits for the next run. His call-out pay on a no-show never changes, and
// the own-work goodwill callback stays at 0.
//
// ORDER. A refund asks Stripe first (it is its own transaction and nothing is saved on a no); then
// ONE transaction does everything else; the pay link is switched off and the messages asked after
// its commit.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { nextReference } from "../db/reference.js";
import { formatDollars } from "../enquiries/money.js";
import { billedHours } from "../jobs/billed-hours.js";
import { addCorrectionNote } from "../jobs/notes.js";
import {
  Refused,
  entryViewOf,
  lockAssignment,
  parseTimeEntries,
  returnVisitMinimum,
  savedEntries,
  writeEntries,
  type EntryView,
  type ParsedEntry,
} from "../jobs/visit.js";
import { leftByPayment, makeRefund, totalLeft } from "../refunds/service.js";
import { askRebuiltDraft, rebuildDraftIfAny } from "../settlements/adjustments.js";
import { sweepContractor } from "../settlements/sweep.js";
import { ymdOf } from "../settlements/calendar.js";
import { contractorMultiplierOf, gstWithin, labourTotal } from "./arithmetic.js";
import { billedToOf, hoursText } from "./issue.js";
import { kickPayLink } from "./pay-link.js";
import { switchOffAfterVoid, voidInTx } from "./void.js";

type Db = Prisma.TransactionClient;
type Reader = Db | PrismaClient;

export const CORRECTION_REASON_MAX = 500;

/** "$1,250.00" -- the card and the refusals always show cents. */
export function money2(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface Failed {
  ok: false;
  status: number;
  error: string;
  field?: string;
}

function failed(status: number, error: string, field?: string): Failed {
  return { ok: false, status, error, ...(field === undefined ? {} : { field }) };
}

const invoiceInclude = { lines: { orderBy: { id: "asc" } } } satisfies Prisma.InvoiceInclude;

async function loadContext(db: Reader, reference: string) {
  const job = await db.job.findUnique({
    where: { reference },
    include: { customer: true, serviceType: { select: { trade: true } } },
  });
  if (job === null) return failed(404, "not found");
  const invoice = await db.invoice.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" }, include: invoiceInclude });
  if (invoice === null) return failed(409, "This job has no invoice to correct.");
  const noShow = job.status === "cancelled" && job.cancelReason === "customer_no_show";
  if (job.status !== "completed" && !noShow) return failed(409, "Only a completed job can be corrected.");
  const assignment = await db.assignment.findUniqueOrThrow({
    where: { id: invoice.assignmentId },
    include: { contractor: { select: { id: true, name: true } }, settlement: { select: { id: true, status: true, periodEnd: true } } },
  });
  const settings = await db.platformSettings.findFirstOrThrow();
  const entries = await savedEntries(db, assignment.id);
  const minimum = await returnVisitMinimum(db);
  const refunds = await db.refund.aggregate({ where: { invoiceId: invoice.id, status: { not: "failed" } }, _sum: { amount: true } });
  const corrections = await db.contractorPayAdjustment.aggregate({
    where: { contractorId: assignment.contractorId, jobId: job.id, kind: "correction" },
    _sum: { amount: true },
  });
  const left = invoice.status === "paid" ? totalLeft(await leftByPayment(db, invoice.id)) : 0;
  return {
    ok: true as const,
    job,
    invoice,
    assignment,
    entries,
    minimum,
    settings,
    noShow,
    refundedSoFar: refunds._sum.amount ?? 0,
    leftToRefund: left,
    correctionsSoFar: corrections._sum.amount ?? 0,
  };
}

type Context = Extract<Awaited<ReturnType<typeof loadContext>>, { ok: true }>;

/** What the page can change on this invoice. */
type InvoiceKind = "visit" | "no_show" | "zero" | "void";

function kindOf(ctx: Context): InvoiceKind {
  if (ctx.invoice.status === "void") return "void";
  if (ctx.invoice.isZeroDollar) return "zero";
  return ctx.noShow ? "no_show" : "visit";
}

function lineOfKind(ctx: Context, kind: "labour" | "part" | "callout") {
  return ctx.invoice.lines.filter((line) => line.kind === kind);
}

/** The hours the invoice being replaced bills: the first hour plus its Additional line. */
function invoicedHoursOf(ctx: Context): number {
  const labour = lineOfKind(ctx, "labour");
  return 1 + Number(labour[1]?.qty ?? 0);
}

/** The hourly price "was": the invoice's Additional line; none when it bills no extra hours. */
function hourlyWas(ctx: Context): number | null {
  const extra = lineOfKind(ctx, "labour")[1];
  return extra === undefined ? null : extra.unitPrice;
}

export type PlaceOfPay = "unswept" | "draft" | "frozen";

function placeOf(ctx: Context): PlaceOfPay {
  const settlement = ctx.assignment.settlement;
  if (settlement === null) return "unswept";
  return settlement.status === "draft" ? "draft" : "frozen";
}

/** What his pay for the visit stands at now: as stored, plus any correction already waiting on a frozen week. */
function payNow(ctx: Context): number {
  return (ctx.assignment.contractorPay ?? 0) + (placeOf(ctx) === "frozen" ? ctx.correctionsSoFar : 0);
}

// ---------------------------------------------------------------------------
// The form (GET)
// ---------------------------------------------------------------------------

export interface CorrectionForm {
  reference: string;
  customerName: string;
  customerFirstName: string;
  trade: string;
  /** the job's zone: the time entries are written in it */
  timezone: string;
  contractorFirstName: string;
  kind: InvoiceKind;
  invoice: { reference: string; status: "sent" | "paid" | "void"; amount: number; isZeroDollar: boolean };
  /** null on a no-show: there is no time on site */
  timeEntries: EntryView[] | null;
  prices: {
    callout: { label: string; was: number } | null;
    hourly: { label: string; was: number } | null;
    parts: { id: string; label: string; was: number }[];
  } | null;
  contractor: { firstName: string; pay: number; place: PlaceOfPay };
  refundedSoFar: number;
}

export async function correctionForm(client: PrismaClient, reference: string): Promise<CorrectionForm | Failed> {
  const ctx = await loadContext(client, reference);
  if (!ctx.ok) return ctx;
  const kind = kindOf(ctx);
  const callout = lineOfKind(ctx, "callout")[0] ?? lineOfKind(ctx, "labour")[0];
  const hourly = hourlyWas(ctx);
  const takesPrices = kind === "visit" || kind === "no_show";
  return {
    reference: ctx.job.reference,
    customerName: ctx.job.customer.name,
    customerFirstName: firstNameOf(ctx.job.customer.name),
    trade: ctx.job.serviceType.trade,
    timezone: ctx.job.timezone,
    contractorFirstName: firstNameOf(ctx.assignment.contractor.name),
    kind,
    invoice: { reference: ctx.invoice.reference, status: ctx.invoice.status, amount: ctx.invoice.amount, isZeroDollar: ctx.invoice.isZeroDollar },
    timeEntries: ctx.noShow ? null : ctx.entries.map((entry) => entryViewOf(entry, ctx.job.timezone)),
    prices: !takesPrices || callout === undefined
      ? null
      : {
          callout: { label: kind === "no_show" ? "Call-out fee" : "Call-out + first hour", was: callout.unitPrice },
          hourly: kind === "visit" && hourly !== null ? { label: "Hourly rate after", was: hourly } : null,
          parts: lineOfKind(ctx, "part").map((line) => ({ id: line.id, label: line.description, was: line.unitPrice })),
        },
    contractor: { firstName: firstNameOf(ctx.assignment.contractor.name), pay: payNow(ctx), place: placeOf(ctx) },
    refundedSoFar: ctx.refundedSoFar,
  };
}

// ---------------------------------------------------------------------------
// Reading the inputs
// ---------------------------------------------------------------------------

export interface CorrectionInput {
  /** null = the time entries are left as they are */
  entries: ParsedEntry[] | null;
  callout?: number;
  hourly?: number;
  parts: Map<string, number>;
}

export interface FieldError {
  field: string;
  error: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A price in whole cents, down only: the field error, or the cents. */
function parsePrice(raw: unknown, was: number, field: string): { ok: true; cents: number } | { ok: false; error: FieldError } {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, error: { field, error: "Enter a price." } };
  }
  if (raw > was) return { ok: false, error: { field, error: `Can only go down - the most is ${money2(was)}.` } };
  return { ok: true, cents: raw };
}

export function parseInput(ctx: Context, body: unknown): { ok: true; input: CorrectionInput } | { ok: false; errors: FieldError[] } {
  const b = isObject(body) ? body : {};
  const errors: FieldError[] = [];
  const kind = kindOf(ctx);
  const input: CorrectionInput = { entries: null, parts: new Map() };

  if (b["timeEntries"] !== undefined && !ctx.noShow) {
    const parsed = parseTimeEntries(b["timeEntries"], ctx.job.timezone);
    if (!parsed.ok) errors.push({ field: parsed.field, error: parsed.error });
    else if (parsed.entries.length === 0) errors.push({ field: "timeEntries", error: "Add the time on site." });
    else input.entries = parsed.entries;
  }

  // Prices are taken on a visit invoice and on a no-show's call-out; a $0 or a voided invoice has none to lower.
  const prices = isObject(b["prices"]) ? b["prices"] : {};
  if (kind === "visit" || kind === "no_show") {
    const callout = lineOfKind(ctx, "callout")[0] ?? lineOfKind(ctx, "labour")[0];
    if (prices["callout"] !== undefined && callout !== undefined) {
      const parsed = parsePrice(prices["callout"], callout.unitPrice, "prices.callout");
      if (parsed.ok) input.callout = parsed.cents;
      else errors.push(parsed.error);
    }
    const hourly = hourlyWas(ctx);
    if (kind === "visit" && prices["hourly"] !== undefined && hourly !== null) {
      const parsed = parsePrice(prices["hourly"], hourly, "prices.hourly");
      if (parsed.ok) input.hourly = parsed.cents;
      else errors.push(parsed.error);
    }
    if (kind === "visit" && isObject(prices["parts"])) {
      for (const line of lineOfKind(ctx, "part")) {
        const raw = prices["parts"][line.id];
        if (raw === undefined) continue;
        const parsed = parsePrice(raw, line.unitPrice, `prices.parts.${line.id}`);
        if (parsed.ok) input.parts.set(line.id, parsed.cents);
        else errors.push(parsed.error);
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, input };
}

export function parseReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: FieldError } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason === "") return { ok: false, error: { field: "reason", error: "Required." } };
  if (reason.length > CORRECTION_REASON_MAX) {
    return { ok: false, error: { field: "reason", error: `At most ${String(CORRECTION_REASON_MAX)} characters.` } };
  }
  return { ok: true, reason };
}

// ---------------------------------------------------------------------------
// The plan: what would happen
// ---------------------------------------------------------------------------

interface NewLine {
  kind: "labour" | "part" | "callout";
  description: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CustomerPlan {
  from: number;
  to: number;
  /** reissue: voided and replaced; refund: stays paid, the overcharge goes back; none: stays as it is */
  action: "reissue" | "refund" | "none";
  refund: number;
  lines: NewLine[];
  labourAmount: number;
  materialsAmount: number;
  gstApplied: boolean;
  gstAmount: number;
  /** what changed, in a line, for the void reason */
  changes: string[];
}

export interface ContractorPlan {
  from: number;
  to: number;
  delta: number;
  place: PlaceOfPay;
  /** the visit's billed hours after the correction (stored unless the week is frozen) */
  hours: number;
}

export function customerPlanOf(ctx: Context, input: CorrectionInput): CustomerPlan {
  const kind = kindOf(ctx);
  const from = ctx.invoice.amount;
  const unchanged: CustomerPlan = {
    from,
    to: from,
    action: "none",
    refund: 0,
    lines: [],
    labourAmount: ctx.invoice.labourAmount,
    materialsAmount: ctx.invoice.materialsAmount,
    gstApplied: ctx.invoice.gstApplied,
    gstAmount: ctx.invoice.gstAmount ?? 0,
    changes: [],
  };
  if (kind === "zero" || kind === "void") return unchanged;

  const lines: NewLine[] = [];
  const changes: string[] = [];
  if (kind === "no_show") {
    const line = lineOfKind(ctx, "callout")[0];
    if (line === undefined) return unchanged;
    const price = input.callout ?? line.unitPrice;
    lines.push({ kind: "callout", description: line.description, qty: 1, unitPrice: price, lineTotal: price });
    if (price !== line.unitPrice) changes.push(`call-out fee ${money2(line.unitPrice)} -> ${money2(price)}`);
  } else {
    const tier1 = lineOfKind(ctx, "labour")[0];
    if (tier1 === undefined) return unchanged;
    const tier1Price = input.callout ?? tier1.unitPrice;
    const wasHourly = hourlyWas(ctx);
    const hourlyPrice = input.hourly ?? wasHourly ?? 0;
    // The customer is never billed for hours added later: the lower of the new and the invoiced hours.
    const newBilled = input.entries === null ? Number(ctx.assignment.billedHours ?? 0) : billedHours(input.entries, ctx.minimum);
    const hours = Math.min(newBilled, invoicedHoursOf(ctx));
    const labour = labourTotal({ calloutRate: tier1Price, standardRate: hourlyPrice }, 1, hours);
    lines.push({ kind: "labour", description: tier1.description, qty: 1, unitPrice: labour.tier1Rate, lineTotal: labour.tier1Rate });
    if (labour.extraHours > 0) {
      lines.push({
        kind: "labour",
        description: `Additional ${hoursText(labour.extraHours)} @ ${formatDollars(labour.tier2Rate)}/h`,
        qty: labour.extraHours,
        unitPrice: labour.tier2Rate,
        lineTotal: labour.tier2Total,
      });
    }
    if (tier1Price !== tier1.unitPrice) changes.push(`call-out + first hour ${money2(tier1.unitPrice)} -> ${money2(tier1Price)}`);
    if (wasHourly !== null && hourlyPrice !== wasHourly) changes.push(`hourly rate ${money2(wasHourly)} -> ${money2(hourlyPrice)}`);
    if (hours !== invoicedHoursOf(ctx)) changes.push(`hours ${hoursText(invoicedHoursOf(ctx))} -> ${hoursText(hours)}`);
    for (const line of lineOfKind(ctx, "part")) {
      const price = input.parts.get(line.id) ?? line.unitPrice;
      lines.push({ kind: "part", description: line.description, qty: Number(line.qty), unitPrice: price, lineTotal: Math.round(Number(line.qty) * price) });
      if (price !== line.unitPrice) changes.push(`${line.description} ${money2(line.unitPrice)} -> ${money2(price)}`);
    }
  }
  const labourAmount = lines.filter((line) => line.kind !== "part").reduce((sum, line) => sum + line.lineTotal, 0);
  const materialsAmount = lines.filter((line) => line.kind === "part").reduce((sum, line) => sum + line.lineTotal, 0);
  const to = labourAmount + materialsAmount;
  const gstApplied = ctx.invoice.gstApplied;
  const plan: CustomerPlan = {
    ...unchanged,
    to,
    lines,
    labourAmount,
    materialsAmount,
    gstAmount: gstWithin(to, Number(ctx.settings.gstRatePercent), gstApplied),
    changes,
  };
  // Hours up, or prices unchanged: the invoice never rises, so there is no customer action.
  if (to >= from) return unchanged;
  if (ctx.invoice.status === "sent") return { ...plan, action: "reissue" };
  // Paid: the difference, less what was already given back, never more than is left.
  const refund = Math.min(Math.max(0, from - to - ctx.refundedSoFar), ctx.leftToRefund);
  return { ...plan, action: refund > 0 ? "refund" : "none", refund };
}

export function contractorPlanOf(ctx: Context, input: CorrectionInput): ContractorPlan | null {
  if (ctx.noShow || input.entries === null) return null;
  const assignment = ctx.assignment;
  if (assignment.contractorCalloutRate === null || assignment.contractorStandardRate === null) return null;
  const newBilled = billedHours(input.entries, ctx.minimum);
  const place = placeOf(ctx);
  const from = payNow(ctx);
  // The own-work goodwill callback is paid nothing and stays that way.
  const ownWork = assignment.callbackChargeable === false && (assignment.contractorPay ?? 0) === 0;
  const earliest = new Date(Math.min(...input.entries.map((entry) => entry.startedAt.getTime())));
  const to = ownWork
    ? 0
    : labourTotal(
        { calloutRate: assignment.contractorCalloutRate, standardRate: assignment.contractorStandardRate },
        contractorMultiplierOf(ctx.job.timezone, earliest),
        newBilled,
      ).total;
  return { from, to, delta: to - from, place, hours: newBilled };
}

// ---------------------------------------------------------------------------
// The preview (POST .../preview): the What happens card
// ---------------------------------------------------------------------------

export interface Preview {
  ok: true;
  customer: { label: string; from: number; to: number; action: CustomerPlan["action"]; sentence: string };
  contractor: { label: string; from: number; to: number; sentence: string } | null;
}

function customerSentence(ctx: Context, plan: CustomerPlan): string {
  const first = firstNameOf(ctx.job.customer.name);
  if (plan.action === "reissue") {
    return plan.to === 0
      ? `${ctx.invoice.reference} is voided - ${first} owes nothing.`
      : `${ctx.invoice.reference} is voided and a new invoice is emailed to ${first}.`;
  }
  if (plan.action === "refund") return `${money2(plan.refund)} goes back to ${first} as a refund.`;
  return `${first}'s invoice stays as it is.`;
}

function contractorSentence(plan: ContractorPlan): string {
  if (plan.place === "unswept") return "It goes on their next payout.";
  if (plan.place === "draft") return "Their draft is rebuilt and sent to them again.";
  const sign = plan.delta < 0 ? "-" : "+";
  const amount = `${sign}${money2(Math.abs(plan.delta))}`;
  return plan.delta < 0 ? `Their week is paid, so ${amount} comes off their next payout.` : `Their week is paid, so ${amount} goes on their next payout.`;
}

export async function previewCorrection(client: PrismaClient, reference: string, body: unknown): Promise<Preview | Failed | { ok: false; status: 200; errors: FieldError[] }> {
  const ctx = await loadContext(client, reference);
  if (!ctx.ok) return ctx;
  const parsed = parseInput(ctx, body);
  if (!parsed.ok) return { ok: false, status: 200, errors: parsed.errors };
  const customer = customerPlanOf(ctx, parsed.input);
  const contractor = contractorPlanOf(ctx, parsed.input);
  const first = firstNameOf(ctx.job.customer.name);
  const him = firstNameOf(ctx.assignment.contractor.name);
  return {
    ok: true,
    customer: { label: `${first}'s invoice`, from: customer.from, to: customer.to, action: customer.action, sentence: customerSentence(ctx, customer) },
    contractor:
      contractor === null || contractor.delta === 0
        ? null
        : { label: `${him}'s pay`, from: contractor.from, to: contractor.to, sentence: contractorSentence(contractor) },
  };
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

export type CorrectionOutcome =
  | {
      ok: true;
      /** "Corrected - INV-2042 sent." | "Corrected - refund CN-1004 made." | "Corrected." */
      toast: string;
      newInvoiceReference: string | null;
      refundReference: string | null;
    }
  | Failed
  | { ok: false; status: 400; errors: FieldError[] };

function samePrice(a: number | undefined, b: number): boolean {
  return a === undefined || a === b;
}

function entriesChanged(ctx: Context, entries: ParsedEntry[] | null): boolean {
  if (entries === null) return false;
  if (entries.length !== ctx.entries.length) return true;
  const key = (e: { startedAt: Date; endedAt: Date }): string => `${String(e.startedAt.getTime())}-${String(e.endedAt.getTime())}`;
  const before = new Set(ctx.entries.map(key));
  return entries.some((entry) => !before.has(key(entry)));
}

export async function correctAndReissue(
  client: PrismaClient,
  reference: string,
  body: unknown,
  userId: string,
  now: Date = new Date(),
): Promise<CorrectionOutcome> {
  const ctx = await loadContext(client, reference);
  if (!ctx.ok) return ctx;
  const b = isObject(body) ? body : {};
  const reason = parseReason(b["reason"]);
  const parsed = parseInput(ctx, body);
  const errors: FieldError[] = [...(parsed.ok ? [] : parsed.errors), ...(reason.ok ? [] : [reason.error])];
  if (!parsed.ok || !reason.ok) return { ok: false, status: 400, errors };

  const input = parsed.input;
  const customer = customerPlanOf(ctx, input);
  const pricesChanged =
    !samePrice(input.callout, (lineOfKind(ctx, "callout")[0] ?? lineOfKind(ctx, "labour")[0])?.unitPrice ?? 0) ||
    !samePrice(input.hourly, hourlyWas(ctx) ?? 0) ||
    lineOfKind(ctx, "part").some((line) => !samePrice(input.parts.get(line.id), line.unitPrice));
  if (!pricesChanged && !entriesChanged(ctx, input.entries)) return failed(400, "Nothing to correct - change the time or a price.");

  // 1. A refund asks Stripe first. A no saves nothing.
  let refundReference: string | null = null;
  if (customer.action === "refund") {
    const refund = await makeRefund(client, { invoiceId: ctx.invoice.id, amount: customer.refund, reason: reason.reason, byUserId: userId, now });
    if (!refund.ok) {
      const status = refund.kind === "stripe" ? 502 : refund.kind === "not_set_up" ? 503 : 409;
      return failed(status, refund.message);
    }
    refundReference = refund.reference;
  }

  // 2. Everything else, in one transaction.
  const done = await client
    .$transaction(
      async (tx) => {
        const locked = await lockAssignment(tx, ctx.job.id, ctx.assignment.id);
        void locked;
        const fresh = await loadContext(tx, reference);
        if (!fresh.ok) throw new Refused({ ok: false, status: fresh.status, error: fresh.error, field: "status" });
        // The state the Mike looked at is the state it is done in.
        if (fresh.invoice.id !== ctx.invoice.id || fresh.invoice.status !== ctx.invoice.status) {
          throw new Refused({ ok: false, status: 409, error: "This invoice just changed - open the page again.", field: "status" });
        }
        const pay = contractorPlanOf(fresh, input);
        let newInvoice: { id: string; reference: string } | null = null;
        let rebuilt: { id: string; reference: string; testData: string | null } | null = null;

        if (input.entries !== null) await writeEntries(tx, fresh.assignment.id, input.entries);

        if (customer.action === "reissue") {
          const voidReason = `Corrected - ${customer.changes.join("; ")} (${money2(customer.from)} -> ${money2(customer.to)}). ${reason.reason}`;
          const outcome = await voidInTx(tx, { invoiceId: fresh.invoice.id, userId, reason: voidReason, now });
          if (outcome !== "voided") {
            throw new Refused({ ok: false, status: 409, error: "This invoice just changed - open the page again.", field: "status" });
          }
          const dueAt = new Date(now.getTime() + fresh.settings.paymentTermsDays * 24 * 60 * 60 * 1000);
          const created = await tx.invoice.create({
            data: {
              reference: await nextReference("INV", tx),
              jobId: fresh.job.id,
              assignmentId: fresh.assignment.id,
              customerId: fresh.job.customerId,
              amount: customer.to,
              labourAmount: customer.labourAmount,
              materialsAmount: customer.materialsAmount,
              gstApplied: customer.gstApplied,
              gstAmount: customer.gstAmount,
              isZeroDollar: customer.to === 0,
              status: "sent",
              sentAt: now,
              dueAt,
              // A reissue is a new issue: it takes a fresh copy of who it is billed to.
              billedTo: billedToOf(fresh.job.customer) as unknown as Prisma.InputJsonObject,
              replacesInvoiceId: fresh.invoice.id,
              lines: { create: customer.lines },
            },
            select: { id: true, reference: true },
          });
          await tx.assignment.update({
            where: { id: fresh.assignment.id },
            data: { invoiceId: created.id, customerTotal: customer.labourAmount },
          });
          newInvoice = created;
        }

        if (pay !== null && pay.delta !== 0) {
          if (pay.place === "frozen") {
            // His week is approved or paid: it is never reopened. The difference waits for the next run.
            await tx.contractorPayAdjustment.create({
              data: {
                contractorId: fresh.assignment.contractorId,
                amount: pay.delta,
                kind: "correction",
                reason: reason.reason,
                jobId: fresh.job.id,
                createdByUserId: userId,
                createdAt: now,
              },
            });
            rebuilt = await rebuildDraftIfAny(tx, fresh.assignment.contractorId, userId, now);
          } else {
            await tx.assignment.update({ where: { id: fresh.assignment.id }, data: { contractorPay: pay.to, billedHours: pay.hours } });
            if (pay.place === "draft" && fresh.assignment.settlement !== null) {
              const swept = await sweepContractor(tx, fresh.assignment.contractorId, {
                periodEnd: ymdOf(fresh.assignment.settlement.periodEnd),
                now,
                supersededByUserId: userId,
              });
              rebuilt = swept === null ? null : { id: swept.id, reference: swept.reference, testData: swept.testData };
            }
          }
        }
        // The hours are the facts: stored for every visit not on a frozen week (an approved or paid
        // invoice keeps reading true against the hours it was paid on).
        if (pay !== null && pay.place !== "frozen" && pay.delta === 0) {
          await tx.assignment.update({ where: { id: fresh.assignment.id }, data: { billedHours: pay.hours } });
        }

        await addCorrectionNote(tx, fresh.job.id, userId, reason.reason, fresh.assignment.id, now);
        return { newInvoice, rebuilt };
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Refused) return error.failure;
      throw error;
    });
  if ("ok" in done) {
    if (refundReference !== null) {
      console.error(`invoices: the refund ${refundReference} for ${reference} was made but the correction behind it was refused`);
    }
    return failed(done.status, done.error, done.field);
  }

  // 3. After the commit.
  if (done.newInvoice !== null) {
    await switchOffAfterVoid(client, ctx.invoice.id);
    if (customer.to > 0) kickPayLink(client, done.newInvoice.id);
  }
  await askRebuiltDraft(client, done.rebuilt, now);

  const toast =
    done.newInvoice !== null && customer.to > 0
      ? `Corrected - ${done.newInvoice.reference} sent.`
      : refundReference !== null
        ? `Corrected - refund ${refundReference} made.`
        : "Corrected.";
  return { ok: true, toast, newInvoiceReference: done.newInvoice?.reference ?? null, refundReference };
}
