// The settlement calendar -- Feature 6003, settlement run.
//
// Contractor Settlement / Draft -> approve -> paid: the run, the period and the pay day. All
// of it is decided on the BUSINESS clock (PlatformSettings.timezone), as plain `YYYY-MM-DD`
// dates: nothing here reads the machine's clock or zone, and `now` always comes in.
//
//   - The run happens at 6:00am every Monday (every second Monday when fortnightly, counted
//     from a fixed anchor Monday so every machine agrees which Mondays count).
//   - The period a run covers is the cycle just ended: the Sunday before the run Monday is its
//     `periodEnd`, and `periodStart` is the Monday a cycle earlier.
//   - Pay day is `PlatformSettings.payoutDay`; a contractor is always told the NEXT one, today
//     counting. Work not yet invoiced is paid on the first pay day AFTER the next run.
import type { PlatformSettings } from "../generated/prisma/client.js";
import { todayIn, zonedDateTimeToUtc } from "../time/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The hour the Monday run starts, business time. */
export const RUN_HOUR = 6;

/** Fortnightly counts every second Monday from this Monday (5 Jan 2026). */
export const FORTNIGHT_ANCHOR = "2026-01-05";

type CalendarSettings = Pick<PlatformSettings, "timezone" | "payoutCycle" | "payoutDay">;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const PAYOUT_DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function atUtcMidnight(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function addDays(ymd: string, days: number): string {
  return new Date(atUtcMidnight(ymd).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((atUtcMidnight(to).getTime() - atUtcMidnight(from).getTime()) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday, for a plain date. */
function weekdayIndex(ymd: string): number {
  return atUtcMidnight(ymd).getUTCDay();
}

/** `YYYY-MM-DD` -> the UTC-midnight Date a `@db.Date` column stores. */
export function plainDate(ymd: string): Date {
  return atUtcMidnight(ymd);
}

/** A `@db.Date` value back to `YYYY-MM-DD`. */
export function ymdOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "Wed 21 Oct" -- the short form a person is told a day in. */
export function dayLabel(ymd: string): string {
  const date = atUtcMidnight(ymd);
  return `${WEEKDAYS[date.getUTCDay()] ?? ""} ${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** "14 Oct 2026" -- the friendly full date. */
export function friendlyDate(ymd: string): string {
  const date = atUtcMidnight(ymd);
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}`;
}

/** "12 Oct - 18 Oct 2026"; the year shows on both ends only when they differ. */
export function periodLabel(startYmd: string, endYmd: string): string {
  const start = atUtcMidnight(startYmd);
  const end = atUtcMidnight(endYmd);
  const short = (date: Date): string => `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`;
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${short(start)} - ${short(end)} ${String(end.getUTCFullYear())}`;
  }
  return `${short(start)} ${String(start.getUTCFullYear())} - ${short(end)} ${String(end.getUTCFullYear())}`;
}

/** The days in one cycle: a week, or a fortnight. */
export function cycleDays(settings: Pick<CalendarSettings, "payoutCycle">): number {
  return settings.payoutCycle === "fortnightly" ? 14 : 7;
}

function mondayOnOrBefore(ymd: string): string {
  return addDays(ymd, -((weekdayIndex(ymd) + 6) % 7));
}

function isRunMonday(settings: CalendarSettings, monday: string): boolean {
  if (settings.payoutCycle !== "fortnightly") return true;
  const apart = daysBetween(FORTNIGHT_ANCHOR, monday);
  return ((apart % 14) + 14) % 14 === 0;
}

/** The latest run Monday whose 6:00am (business time) has already passed. */
export function latestRunMonday(settings: CalendarSettings, now: Date): string {
  let monday = mondayOnOrBefore(todayIn(settings.timezone, now));
  while (!isRunMonday(settings, monday) || zonedDateTimeToUtc(settings.timezone, monday, RUN_HOUR, 0).getTime() > now.getTime()) {
    monday = addDays(monday, -7);
  }
  return monday;
}

/** The first run Monday whose 6:00am is still to come. */
export function nextRunMonday(settings: CalendarSettings, now: Date): string {
  return addDays(latestRunMonday(settings, now), cycleDays(settings));
}

export interface RunPeriod {
  /** the Monday the run belongs to */
  runMonday: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * The period the run due NOW covers: the last Sunday whose following Monday 6:00am has passed
 * (the target Sunday), and the Monday a cycle earlier.
 */
export function periodFor(settings: CalendarSettings, now: Date): RunPeriod {
  const runMonday = latestRunMonday(settings, now);
  return { runMonday, periodStart: addDays(runMonday, -cycleDays(settings)), periodEnd: addDays(runMonday, -1) };
}

/** `PlatformSettings.payoutDay` as an index; the seed's Wednesday when none is set. */
function payoutIndex(settings: Pick<CalendarSettings, "payoutDay">): number {
  return PAYOUT_DAY_INDEX[settings.payoutDay ?? "wed"] ?? 3;
}

/** The next pay day, today counting. */
export function payDayFor(settings: CalendarSettings, now: Date): string {
  const today = todayIn(settings.timezone, now);
  const ahead = (payoutIndex(settings) - weekdayIndex(today) + 7) % 7;
  return addDays(today, ahead);
}

/** The first pay day strictly after a given day. */
export function payDayAfter(settings: CalendarSettings, ymd: string): string {
  const ahead = (payoutIndex(settings) - weekdayIndex(ymd) + 7) % 7;
  return addDays(ymd, ahead === 0 ? 7 : ahead);
}

/** The business-clock day a moment falls on. */
export function workDayOf(settings: Pick<CalendarSettings, "timezone">, moment: Date): string {
  return todayIn(settings.timezone, moment);
}
