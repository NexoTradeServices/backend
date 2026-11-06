// Contractor Availability -- Feature 2004, Calendar & Scheduling / Availability.
//
// THE ONE HOME for the rules. A half hour is, for one contractor, exactly one of:
//   available      he can be booked then
//   not_available  he switched it off - or it lies outside the hours he started from (his defaults)
//   booked         a job holds it (to_answer / in progress / finished jobs all lock it too)
//   to_answer      a dispatched job he has not answered yet holds it
//   closed         a public holiday of his Operating state - locked, whole day
//   past           already gone, read in the zone of his Operating state - locked
// A half hour with no saved row is Available inside the contractor's defaults (the business hours he was made under)
// and Not available outside them. Only CHANGED half hours are written (ContractorAvailability), with who and when.
// Everything that changes them runs in one transaction under the contractor's row lock - the same lock dispatch takes - so a
// job arriving mid-edit wins.
import type { PrismaClient } from "../db/client.js";
import { minutesOf } from "../calendar/rules.js";
import { clockTimeIn, formatTimeRangeLabel, todayIn, zoneForState, zonedDateTimeToUtc } from "../time/index.js";

type Db = Pick<PrismaClient, "platformSettings" | "contractorAvailability" | "publicHoliday" | "calendarEvent" | "contractor">;

export type SlotState = "available" | "not_available" | "booked" | "in_progress" | "to_answer" | "closed" | "past";

export interface AvailabilityContractor {
  id: string;
  operatingState: string;
  defaultOpening: string;
  defaultClosing: string;
}

export interface Slot {
  /** minutes since midnight in the contractor's zone, on the half hour */
  minutes: number;
  state: SlotState;
  /** the reference of the job holding this half hour, for the label on the grid */
  job: string | null;
  /** the saved-or-default answer ignoring jobs, holidays and the past - what Copy carries */
  effective: boolean;
}

export interface DayStates {
  date: string;
  /** the holiday's name when the whole day is closed */
  closed: string | null;
  slots: Slot[];
}

export const HALF_HOUR_MINUTES = 30;

export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 === 0 ? "00" : "30"}`;
}

export function addDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday on or before `date` (a plain calendar date). */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

/** The contractor's zone: the zone of his Operating state. */
export function zoneOf(contractor: { operatingState: string }): string {
  return zoneForState(contractor.operatingState);
}

function dayDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function effectiveOf(contractor: AvailabilityContractor, rows: Map<string, boolean>, date: string, minutes: number): boolean {
  const saved = rows.get(`${date}|${clockOf(minutes)}`);
  if (saved !== undefined) return saved;
  return minutes >= minutesOf(contractor.defaultOpening) && minutes < minutesOf(contractor.defaultClosing);
}

/** Each of `dates` (plain dates, the contractor's zone), every half hour within the business opening hours. */
export async function dayStates(
  client: Db,
  contractor: AvailabilityContractor,
  dates: string[],
  now: Date = new Date(),
): Promise<DayStates[]> {
  if (dates.length === 0) return [];
  const zone = zoneOf(contractor);
  const settings = await client.platformSettings.findFirstOrThrow({ select: { openingTime: true, closingTime: true } });
  const open = minutesOf(settings.openingTime);
  const close = minutesOf(settings.closingTime);
  const sorted = [...dates].sort();
  const first = sorted[0] ?? dates[0] ?? "";
  const last = sorted[sorted.length - 1] ?? first;

  const savedRows = await client.contractorAvailability.findMany({
    where: { contractorId: contractor.id, date: { gte: dayDate(first), lte: dayDate(last) } },
  });
  const rows = new Map(savedRows.map((row) => [`${row.date.toISOString().slice(0, 10)}|${row.startTime}`, row.available]));
  const holidays = new Map(
    (await client.publicHoliday.findMany({ where: { state: contractor.operatingState, date: { gte: dayDate(first), lte: dayDate(last) } } })).map(
      (h) => [h.date.toISOString().slice(0, 10), h.name],
    ),
  );
  const rangeStart = zonedDateTimeToUtc(zone, first, 0, 0);
  const rangeEnd = zonedDateTimeToUtc(zone, addDays(last, 1), 0, 0);
  const events = await client.calendarEvent.findMany({
    where: { contractorId: contractor.id, type: "job", startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
    select: { startTime: true, endTime: true, assignment: { select: { status: true } }, job: { select: { reference: true } } },
  });

  return dates.map((date): DayStates => {
    const closed = holidays.get(date) ?? null;
    const slots: Slot[] = [];
    for (let minutes = open; minutes < close; minutes += HALF_HOUR_MINUTES) {
      const start = zonedDateTimeToUtc(zone, date, Math.floor(minutes / 60), minutes % 60);
      const end = new Date(start.getTime() + HALF_HOUR_MINUTES * 60_000);
      const effective = effectiveOf(contractor, rows, date, minutes);
      let state: SlotState = effective ? "available" : "not_available";
      const holding = events.filter((e) => e.startTime < end && e.endTime > start);
      if (holding.length > 0) {
        state = holding.some((e) => e.assignment?.status === "in_progress")
          ? "in_progress"
          : holding.some((e) => e.assignment?.status !== "assigned")
            ? "booked"
            : "to_answer";
      }
      if (closed !== null) state = "closed";
      else if (start.getTime() < now.getTime()) state = "past";
      slots.push({ minutes, state, job: holding[0]?.job?.reference ?? null, effective });
    }
    return { date, closed, slots };
  });
}

export interface Change {
  date: string;
  /** "HH:MM" on the half hour */
  time: string;
  available: boolean;
}

export interface ApplyResult {
  written: number;
  skipped: number;
}

const LOCKED: ReadonlySet<SlotState> = new Set<SlotState>(["booked", "in_progress", "to_answer", "closed", "past"]);

export function parseChanges(raw: unknown): Change[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: Change[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r["date"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r["date"])) return null;
    if (typeof r["time"] !== "string" || !/^([01]\d|2[0-3]):(00|30)$/.test(r["time"])) return null;
    if (typeof r["available"] !== "boolean") return null;
    out.push({ date: r["date"], time: r["time"], available: r["available"] });
  }
  return out;
}

async function loadContractor(client: Db, contractorId: string) {
  return client.contractor.findUniqueOrThrow({
    where: { id: contractorId },
    select: { id: true, operatingState: true, defaultOpening: true, defaultClosing: true, availabilitySavedAt: true },
  });
}

/**
 * Writes the changed half hours that may change. A locked half hour (booked, to answer, closed, past, or outside the opening
 * hours) is skipped; a half hour already at the asked value is not written. The contractor's row is locked for the duration,
 * so a dispatch arriving mid-edit either committed first (and the half hour is booked here) or waits.
 */
export async function applyChanges(
  client: PrismaClient,
  contractorId: string,
  changes: Change[],
  byUserId: string | null,
  now: Date = new Date(),
): Promise<ApplyResult> {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${contractorId} FOR UPDATE`;
    const contractor = await loadContractor(tx, contractorId);
    const dates = [...new Set(changes.map((c) => c.date))];
    const states = new Map((await dayStates(tx, contractor, dates, now)).map((d) => [d.date, d]));
    let written = 0;
    let skipped = 0;
    for (const change of changes) {
      const slot = states.get(change.date)?.slots.find((s) => clockOf(s.minutes) === change.time);
      if (slot === undefined || LOCKED.has(slot.state)) {
        skipped += 1;
        continue;
      }
      if ((slot.state === "available") === change.available) continue; // nothing changed - nothing written
      await tx.contractorAvailability.upsert({
        where: { contractorId_date_startTime: { contractorId, date: dayDate(change.date), startTime: change.time } },
        create: { contractorId, date: dayDate(change.date), startTime: change.time, available: change.available, changedByUserId: byUserId },
        update: { available: change.available, changedByUserId: byUserId, changedAt: now },
      });
      written += 1;
    }
    if (contractor.availabilitySavedAt === null) {
      await tx.contractor.update({ where: { id: contractorId }, data: { availabilitySavedAt: now } });
    }
    return { written, skipped };
  });
}

/** What Copy carries from a source day: each half hour's own answer; a job's hours arrive Available. */
function copyPlan(source: DayStates, targetDate: string): Change[] {
  return source.slots.map((slot) => ({
    date: targetDate,
    time: clockOf(slot.minutes),
    available: slot.state === "booked" || slot.state === "in_progress" || slot.state === "to_answer" ? true : slot.effective,
  }));
}

export async function copyDay(
  client: PrismaClient,
  contractorId: string,
  input: { from: string; changes: Change[]; byUserId: string | null },
  now: Date = new Date(),
): Promise<ApplyResult & { target: string }> {
  if (input.changes.length > 0) await applyChanges(client, contractorId, input.changes, input.byUserId, now);
  const contractor = await loadContractor(client, contractorId);
  const target = addDays(input.from, 1);
  const [source] = await dayStates(client, contractor, [input.from], now);
  if (source === undefined) return { written: 0, skipped: 0, target };
  const result = await applyChanges(client, contractorId, copyPlan(source, target), input.byUserId, now);
  return { ...result, target };
}

/** Copy a day onto every later day of the same Monday-to-Sunday week (a Sunday has none left: nothing is written). */
export async function copyRestOfWeek(
  client: PrismaClient,
  contractorId: string,
  input: { from: string; changes: Change[]; byUserId: string | null },
  now: Date = new Date(),
): Promise<ApplyResult & { targets: string[] }> {
  if (input.changes.length > 0) await applyChanges(client, contractorId, input.changes, input.byUserId, now);
  const sunday = addDays(mondayOf(input.from), 6);
  const targets: string[] = [];
  for (let day = addDays(input.from, 1); day <= sunday; day = addDays(day, 1)) targets.push(day);
  if (targets.length === 0) return { written: 0, skipped: 0, targets };
  const contractor = await loadContractor(client, contractorId);
  const [source] = await dayStates(client, contractor, [input.from], now);
  if (source === undefined) return { written: 0, skipped: 0, targets };
  const plan = targets.flatMap((target) => copyPlan(source, target));
  const result = await applyChanges(client, contractorId, plan, input.byUserId, now);
  return { ...result, targets };
}

export type CopyWeekResult = (ApplyResult & { needsReplace: false; targetWeek: string }) | { needsReplace: true; targetWeek: string };

export async function copyWeek(
  client: PrismaClient,
  contractorId: string,
  input: { fromWeek: string; replace: boolean; changes: Change[]; byUserId: string | null },
  now: Date = new Date(),
): Promise<CopyWeekResult> {
  const targetWeek = addDays(input.fromWeek, 7);
  const targetDates = Array.from({ length: 7 }, (_, i) => addDays(targetWeek, i));
  const existing = await client.contractorAvailability.count({
    where: { contractorId, date: { gte: dayDate(targetWeek), lte: dayDate(addDays(targetWeek, 6)) } },
  });
  if (existing > 0 && !input.replace) return { needsReplace: true, targetWeek };
  if (input.changes.length > 0) await applyChanges(client, contractorId, input.changes, input.byUserId, now);
  const contractor = await loadContractor(client, contractorId);
  const sourceDates = Array.from({ length: 7 }, (_, i) => addDays(input.fromWeek, i));
  const sources = await dayStates(client, contractor, sourceDates, now);
  const plan = sources.flatMap((source, i) => copyPlan(source, targetDates[i] ?? addDays(input.fromWeek, 7 + i)));
  const result = await applyChanges(client, contractorId, plan, input.byUserId, now);
  return { ...result, needsReplace: false, targetWeek };
}

/**
 * For dispatch: which of these contractors have a half hour of the hold switched off? The hold is `date` + `startMinutes` in
 * the JOB's zone; each half hour it touches is read in the contractor's own zone. Time outside the opening hours is the
 * hours rule's business, not Availability's.
 */
export async function notAvailableIn(
  client: Db,
  contractors: (AvailabilityContractor & { availabilitySavedAt: Date | null })[],
  hold: { start: Date; end: Date },
): Promise<Map<string, { notAvailable: boolean; notSet: boolean }>> {
  const out = new Map<string, { notAvailable: boolean; notSet: boolean }>();
  for (const contractor of contractors) {
    const zone = zoneOf(contractor);
    const touched: { date: string; minutes: number }[] = [];
    for (let t = hold.start.getTime(); t < hold.end.getTime(); t += HALF_HOUR_MINUTES * 60_000) {
      const at = new Date(t);
      const [h, m] = clockTimeIn(zone, at).split(":").map(Number);
      touched.push({ date: todayIn(zone, at), minutes: Math.floor(((h ?? 0) * 60 + (m ?? 0)) / HALF_HOUR_MINUTES) * HALF_HOUR_MINUTES });
    }
    const dates = [...new Set(touched.map((s) => s.date))].sort();
    const savedRows = await client.contractorAvailability.findMany({
      where: { contractorId: contractor.id, date: { gte: dayDate(dates[0] ?? ""), lte: dayDate(dates[dates.length - 1] ?? "") } },
    });
    const rows = new Map(savedRows.map((row) => [`${row.date.toISOString().slice(0, 10)}|${row.startTime}`, row.available]));
    const notAvailable = touched.some((s) => !effectiveOf(contractor, rows, s.date, s.minutes));
    out.set(contractor.id, { notAvailable, notSet: contractor.availabilitySavedAt === null });
  }
  return out;
}

/**
 * For the dispatch day view: the runs of one calendar day (drawn in the day's own zone, from `dayStart` to `dayEnd`) in which
 * the contractor is switched off. Same rule as `notAvailableIn`; minutes are counted from `dayStart`.
 */
export async function notAvailableRunsOn(
  client: Db,
  contractor: AvailabilityContractor,
  dayStart: Date,
  dayEnd: Date,
): Promise<{ startMinutes: number; endMinutes: number }[]> {
  const zone = zoneOf(contractor);
  const slots: { offset: number; date: string; minutes: number }[] = [];
  for (let t = dayStart.getTime(); t < dayEnd.getTime(); t += HALF_HOUR_MINUTES * 60_000) {
    const at = new Date(t);
    const [h, m] = clockTimeIn(zone, at).split(":").map(Number);
    slots.push({
      offset: Math.round((t - dayStart.getTime()) / 60_000),
      date: todayIn(zone, at),
      minutes: Math.floor(((h ?? 0) * 60 + (m ?? 0)) / HALF_HOUR_MINUTES) * HALF_HOUR_MINUTES,
    });
  }
  if (slots.length === 0) return [];
  const dates = [...new Set(slots.map((s) => s.date))].sort();
  const savedRows = await client.contractorAvailability.findMany({
    where: { contractorId: contractor.id, date: { gte: dayDate(dates[0] ?? ""), lte: dayDate(dates[dates.length - 1] ?? "") } },
  });
  const rows = new Map(savedRows.map((row) => [`${row.date.toISOString().slice(0, 10)}|${row.startTime}`, row.available]));
  const runs: { startMinutes: number; endMinutes: number }[] = [];
  for (const slot of slots) {
    if (effectiveOf(contractor, rows, slot.date, slot.minutes)) continue;
    const end = slot.offset + HALF_HOUR_MINUTES;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.endMinutes === slot.offset) last.endMinutes = end;
    else runs.push({ startMinutes: slot.offset, endMinutes: end });
  }
  return runs;
}

export type CalendarStatus = "booked" | "to_answer" | "in_progress" | "finished";

export interface CalendarBlock {
  startMinutes: number;
  endMinutes: number;
  /** the job's own clock, plain (the contractor reading his own job) */
  timeLabel: string;
  jobReference: string | null;
  suburb: string | null;
  status: CalendarStatus;
}

export interface CalendarDay {
  date: string;
  closed: string | null;
  past: boolean;
  blocks: CalendarBlock[];
  /** the Not available runs inside the business hours */
  notAvailable: { startMinutes: number; endMinutes: number }[];
  jobCount: number;
}

const STATUS_OF: Record<string, CalendarStatus> = {
  assigned: "to_answer",
  accepted: "booked",
  in_progress: "in_progress",
  completed: "finished",
};

/** The calendar for `from`..`to` inclusive (plain dates in the contractor's zone). */
export async function calendarRange(
  client: Db,
  contractor: AvailabilityContractor,
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<CalendarDay[]> {
  const zone = zoneOf(contractor);
  const dates: string[] = [];
  for (let d = from, n = 0; d <= to && n < 62; d = addDays(d, 1), n += 1) dates.push(d);
  const states = await dayStates(client, contractor, dates, now);
  const rangeStart = zonedDateTimeToUtc(zone, from, 0, 0);
  const rangeEnd = zonedDateTimeToUtc(zone, addDays(dates[dates.length - 1] ?? from, 1), 0, 0);
  const events = await client.calendarEvent.findMany({
    where: { contractorId: contractor.id, type: "job", startTime: { lt: rangeEnd }, endTime: { gt: rangeStart } },
    orderBy: { startTime: "asc" },
    include: {
      job: { select: { reference: true, serviceLocation: true, timezone: true } },
      assignment: { select: { status: true } },
    },
  });
  return states.map((day): CalendarDay => {
    const dayStart = zonedDateTimeToUtc(zone, day.date, 0, 0);
    const dayEnd = zonedDateTimeToUtc(zone, addDays(day.date, 1), 0, 0);
    const blocks = events
      .filter((e) => e.startTime < dayEnd && e.endTime > dayStart)
      .map((e): CalendarBlock => {
        const suburb = (e.job?.serviceLocation as Record<string, unknown> | null | undefined)?.["suburb"];
        return {
          startMinutes: Math.max(0, Math.round((e.startTime.getTime() - dayStart.getTime()) / 60_000)),
          endMinutes: Math.min(1440, Math.round((e.endTime.getTime() - dayStart.getTime()) / 60_000)),
          timeLabel: formatTimeRangeLabel(e.job?.timezone ?? zone, e.startTime, e.endTime),
          jobReference: e.job?.reference ?? null,
          suburb: typeof suburb === "string" ? suburb : null,
          status: STATUS_OF[e.assignment?.status ?? "accepted"] ?? "booked",
        };
      });
    const notAvailable: { startMinutes: number; endMinutes: number }[] = [];
    for (const slot of day.slots) {
      if (slot.state !== "not_available") continue;
      const run = notAvailable[notAvailable.length - 1];
      if (run !== undefined && run.endMinutes === slot.minutes) run.endMinutes += HALF_HOUR_MINUTES;
      else notAvailable.push({ startMinutes: slot.minutes, endMinutes: slot.minutes + HALF_HOUR_MINUTES });
    }
    const past = day.slots.length > 0 && day.slots.every((s) => s.state === "past");
    return { date: day.date, closed: day.closed, past, blocks, notAvailable, jobCount: blocks.length };
  });
}
