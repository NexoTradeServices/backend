// The visit's own records -- Feature 5001, contractor job screen and Complete.
//
// Contractor Workflow step 8: the time entries, completion notes and parts of
// one assignment. One parser and one writer, read by the contractor's job
// screen (PUT, Complete) and by the ops job page (time entries only), so the
// entry rules are the same on both sides. Entries are entered as a date plus
// a start and a finish at any minute, in the JOB's zone (Data Model / Time),
// and stored as real instants.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { billedHours } from "./billed-hours.js";
import { clockTimeIn, todayIn, zonedDateTimeToUtc } from "../time/index.js";

type Db = Prisma.TransactionClient;

export type Failure = { ok: false; status: number; error: string; field: string };

export const MAX_ENTRIES = 30;
export const MAX_PARTS = 30;
const MAX_NOTE = 500;
const MAX_COMPLETION_NOTES = 5000;
const MAX_PART_TEXT = 200;

/** Assignment statuses a visit can still be written in. */
export const OPEN_VISIT_STATUSES = ["accepted", "in_progress"] as const;

export interface ParsedEntry {
  startedAt: Date;
  endedAt: Date;
  note: string | null;
}

export interface ParsedPart {
  name: string;
  description: string | null;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  receiptAttachmentId: string | null;
}

/** An entry as the screens read and write it: the job's own date and clock. */
export interface EntryView {
  date: string;
  start: string;
  end: string;
  note: string;
}

function fail(status: number, error: string, field: string): Failure {
  return { ok: false, status, error, field };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A date on the calendar -- 2026-02-31 would roll over to March, so it is refused. */
function isCalendarDate(zone: string, date: string): boolean {
  return DATE_PATTERN.test(date) && todayIn(zone, zonedDateTimeToUtc(zone, date, 12, 0)) === date;
}

function instantOf(zone: string, date: string, time: string): Date | null {
  const match = TIME_PATTERN.exec(time);
  return match === null ? null : zonedDateTimeToUtc(zone, date, Number(match[1]), Number(match[2]));
}

export function parseTimeEntries(raw: unknown, zone: string): { ok: true; entries: ParsedEntry[] } | Failure {
  if (!Array.isArray(raw)) return fail(400, "timeEntries must be a list", "timeEntries");
  if (raw.length > MAX_ENTRIES) return fail(400, `At most ${String(MAX_ENTRIES)} visits.`, "timeEntries");
  const entries: ParsedEntry[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `timeEntries[${String(i)}]`;
    if (!isObject(item)) return fail(400, "Each time entry must be an object", at);
    const date = typeof item["date"] === "string" ? item["date"].trim() : "";
    const start = typeof item["start"] === "string" ? item["start"].trim() : "";
    const end = typeof item["end"] === "string" ? item["end"].trim() : "";
    if (date === "") return fail(400, "Required.", `${at}.date`);
    if (start === "") return fail(400, "Required.", `${at}.start`);
    if (end === "") return fail(400, "Required.", `${at}.end`);
    if (!isCalendarDate(zone, date)) return fail(400, "Not a date.", `${at}.date`);
    const startedAt = instantOf(zone, date, start);
    if (startedAt === null) return fail(400, "Not a time.", `${at}.start`);
    const endedAt = instantOf(zone, date, end);
    if (endedAt === null) return fail(400, "Not a time.", `${at}.end`);
    if (endedAt.getTime() <= startedAt.getTime()) return fail(400, "Finish must be after start.", `${at}.end`);
    const noteRaw = item["note"];
    if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string") {
      return fail(400, "Note must be text", `${at}.note`);
    }
    const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
    if (note.length > MAX_NOTE) return fail(400, `A note is at most ${String(MAX_NOTE)} characters.`, `${at}.note`);
    entries.push({ startedAt, endedAt, note: note === "" ? null : note });
  }
  return { ok: true, entries };
}

export function parseCompletionNotes(raw: unknown): { ok: true; notes: string | null } | Failure {
  if (raw === undefined || raw === null) return { ok: true, notes: null };
  if (typeof raw !== "string") return fail(400, "completionNotes must be text", "completionNotes");
  const notes = raw.trim();
  if (notes.length > MAX_COMPLETION_NOTES) {
    return fail(400, `Notes are at most ${String(MAX_COMPLETION_NOTES)} characters.`, "completionNotes");
  }
  return { ok: true, notes: notes === "" ? null : notes };
}

/** "$150" for whole dollars, "$150.50" otherwise -- the cap as the refusal words it. */
function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${String(cents / 100)}` : `$${(cents / 100).toFixed(2)}`;
}

export function parseParts(raw: unknown, maxAmount: number): { ok: true; parts: ParsedPart[] } | Failure {
  if (raw === undefined) return { ok: true, parts: [] };
  if (!Array.isArray(raw)) return fail(400, "parts must be a list", "parts");
  if (raw.length > MAX_PARTS) return fail(400, `At most ${String(MAX_PARTS)} parts.`, "parts");
  const parts: ParsedPart[] = [];
  let runningTotal = 0;
  for (const [i, item] of raw.entries()) {
    const at = `parts[${String(i)}]`;
    if (!isObject(item)) return fail(400, "Each part must be an object", at);
    const name = typeof item["name"] === "string" ? item["name"].trim() : "";
    if (name === "") return fail(400, "Required.", `${at}.name`);
    if (name.length > MAX_PART_TEXT) return fail(400, `At most ${String(MAX_PART_TEXT)} characters.`, `${at}.name`);
    const descriptionRaw = item["description"];
    if (descriptionRaw !== undefined && descriptionRaw !== null && typeof descriptionRaw !== "string") {
      return fail(400, "Description must be text", `${at}.description`);
    }
    const description = typeof descriptionRaw === "string" ? descriptionRaw.trim() : "";
    if (description.length > MAX_COMPLETION_NOTES) {
      return fail(400, `At most ${String(MAX_COMPLETION_NOTES)} characters.`, `${at}.description`);
    }
    const qty = item["qty"];
    if (typeof qty !== "number" || !Number.isFinite(qty)) return fail(400, "Required.", `${at}.qty`);
    if (qty <= 0) return fail(400, "Must be more than zero.", `${at}.qty`);
    if (qty > 99_999_999 || Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) {
      return fail(400, "At most two decimals.", `${at}.qty`);
    }
    const unitPrice = item["unitPrice"];
    if (typeof unitPrice !== "number" || !Number.isInteger(unitPrice)) return fail(400, "Required.", `${at}.unitPrice`);
    if (unitPrice <= 0) return fail(400, "Must be more than zero.", `${at}.unitPrice`);
    const lineTotal = Math.round(qty * unitPrice);
    // The cap is on ALL the contractor's parts on the job added up, not on each line:
    // the refusal lands on the line that tips the total over.
    runningTotal += lineTotal;
    if (runningTotal > maxAmount) {
      return fail(400, `Parts are over ${dollars(maxAmount)} in total - ring the office, they order it`, `${at}.unitPrice`);
    }
    const receipt = item["receiptAttachmentId"];
    if (typeof receipt !== "string" || receipt.trim() === "") return fail(400, "Required.", `${at}.receipt`);
    parts.push({
      name,
      description: description === "" ? null : description,
      qty: Math.round(qty * 100) / 100,
      unitPrice,
      lineTotal,
      receiptAttachmentId: receipt.trim(),
    });
  }
  return { ok: true, parts };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function entryViewOf(
  row: { startedAt: Date; endedAt: Date; note: string | null },
  zone: string,
): EntryView {
  return {
    date: todayIn(zone, row.startedAt),
    start: clockTimeIn(zone, row.startedAt),
    end: clockTimeIn(zone, row.endedAt),
    note: row.note ?? "",
  };
}

export async function savedEntries(db: Db | PrismaClient, assignmentId: string) {
  return db.assignmentTimeLog.findMany({ where: { assignmentId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
}

export async function returnVisitMinimum(db: Db | PrismaClient): Promise<number> {
  const settings = await db.platformSettings.findFirst({ select: { returnVisitMinimumMinutes: true } });
  return settings?.returnVisitMinimumMinutes ?? 30;
}

export async function liveBilledHours(db: Db | PrismaClient, assignmentId: string): Promise<number> {
  const rows = await savedEntries(db, assignmentId);
  return billedHours(rows, await returnVisitMinimum(db));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Thrown inside a transaction to roll it back with a refusal the route can answer. */
export class Refused extends Error {
  constructor(readonly failure: Failure) {
    super("refused");
  }
}

/** Lock the job, then the assignment (the job first, as dispatch and respond do), and read the assignment as it now stands. */
export async function lockAssignment(tx: Db, jobId: string, assignmentId: string) {
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${assignmentId} FOR UPDATE`;
  return tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
}

export function lockedFailure(status: string): Failure {
  return status === "completed"
    ? fail(409, "Locked - this job was completed.", "status")
    : fail(409, "This job is not open for work.", "status");
}

export async function writeEntries(tx: Db, assignmentId: string, entries: readonly ParsedEntry[]): Promise<void> {
  await tx.assignmentTimeLog.deleteMany({ where: { assignmentId } });
  if (entries.length === 0) return;
  await tx.assignmentTimeLog.createMany({
    data: entries.map((entry) => ({ assignmentId, startedAt: entry.startedAt, endedAt: entry.endedAt, note: entry.note })),
  });
}

/** Each receipt must be a contractor upload on THIS assignment -- a stranger's attachment id is refused. */
export async function writeParts(tx: Db, assignmentId: string, parts: readonly ParsedPart[]): Promise<void> {
  for (const [i, part] of parts.entries()) {
    const receipt = await tx.attachment.findFirst({
      where: { id: part.receiptAttachmentId ?? "", assignmentId, uploadedByRole: "contractor" },
      select: { id: true },
    });
    if (receipt === null) throw new Refused(fail(400, "Add the receipt photo.", `parts[${String(i)}].receipt`));
  }
  await tx.assignmentPart.deleteMany({ where: { assignmentId } });
  if (parts.length === 0) return;
  await tx.assignmentPart.createMany({
    data: parts.map((part) => ({
      assignmentId,
      suppliedBy: "contractor" as const,
      name: part.name,
      description: part.description,
      qty: part.qty,
      unitPrice: part.unitPrice,
      lineTotal: part.lineTotal,
      receiptAttachmentId: part.receiptAttachmentId,
    })),
  });
}
