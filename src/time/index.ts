// Time -- Feature 1008, time foundation.
//
// THE ONE MODULE every screen, template and rule formats and decides time
// through -- see Data Model / Time. No other file may re-derive a day, hour
// or date-boundary answer, or format a moment for a person, by hand; that is
// drift for the reviewer to catch.
//
// Every point in time is stored as a UTC moment (a plain `Date` / Prisma
// `DateTime`, TIMESTAMP(3) WITHOUT TIME ZONE holding UTC -- see the raw-SQL
// safe fragment below).
// Nothing here ever reads the machine's clock zone or a browser's: every
// question about a day, hour or date boundary converts the stored moment
// into an IANA zone FIRST, using the caller-supplied zone (`Job.timezone` for
// anything belonging to one job, `PlatformSettings.timezone` for anything
// spanning jobs or belonging to the business). A plain DATE (preferredDate,
// licenceExpiry, settlement periods, ...) carries no zone and is untouched by
// anything in this module.

/** The state-to-IANA-zone map (Data Model / Time): stamps `Job.timezone` at
 * creation from `serviceLocation`'s state -- never typed by anyone. IANA
 * carries no separate Canberra zone, so ACT shares Sydney's (same clock,
 * same DST rules). */
const STATE_ZONES: Readonly<Record<string, string>> = {
  WA: "Australia/Perth",
  NSW: "Australia/Sydney",
  VIC: "Australia/Melbourne",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  TAS: "Australia/Hobart",
  ACT: "Australia/Sydney",
  NT: "Australia/Darwin",
};

export function zoneForState(state: string): string {
  const zone = STATE_ZONES[state];
  if (zone === undefined) {
    throw new Error(`no IANA zone mapped for state "${state}"`);
  }
  return zone;
}

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const WEEKDAY_ORDER: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Ymd {
  year: number;
  month: number; // 1-12
  day: number;
}

/** The calendar date `moment` falls on, read in `zone`'s own wall clock. */
function ymdIn(zone: string, moment: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(moment);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addDays(ymd: Ymd, delta: number): Ymd {
  const shifted = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** `zone`'s UTC offset, in minutes east of UTC, at the instant `utcMillis`. */
function offsetMinutesAt(zone: string, utcMillis: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asIfUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return (asIfUtc - utcMillis) / 60_000;
}

/**
 * The UTC instant at which `zone`'s wall clock reads the given local time.
 *
 * Guesses the offset from the naive instant, then re-checks it once against
 * the guess -- the only case that changes the answer is a moment that lands
 * inside a DST transition, and AU zones move by exactly one step (an hour),
 * so one re-check is always enough.
 */
function zonedTimeToUtc(zone: string, ymd: Ymd, hour = 0, minute = 0, second = 0): Date {
  const naive = Date.UTC(ymd.year, ymd.month - 1, ymd.day, hour, minute, second);
  const guessOffset = offsetMinutesAt(zone, naive);
  const guess = naive - guessOffset * 60_000;
  const realOffset = offsetMinutesAt(zone, guess);
  return new Date(realOffset === guessOffset ? guess : naive - realOffset * 60_000);
}

/** The calendar date `zone` is showing `moment` (default: now) as, `YYYY-MM-DD`. */
export function todayIn(zone: string, moment: Date = new Date()): string {
  const { year, month, day } = ymdIn(zone, moment);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The UTC instant of local midnight, at the start of `zone`'s calendar day for `moment`. */
export function startOfDayUtc(zone: string, moment: Date = new Date()): Date {
  return zonedTimeToUtc(zone, ymdIn(zone, moment));
}

/** Which day of the week `moment` falls on on `zone`'s wall clock. */
export function weekdayIn(zone: string, moment: Date): Weekday {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(moment);
  return short.slice(0, 3).toLowerCase() as Weekday;
}

/** Saturday or Sunday, decided in `zone` -- the weekend-pricing rule's exact shape. */
export function isWeekend(zone: string, moment: Date): boolean {
  const day = weekdayIn(zone, moment);
  return day === "sat" || day === "sun";
}

/**
 * The UTC instant `zone`'s calendar week (starting `weekStartDay`) most
 * recently crossed, on/before `moment` -- the payout-week boundary, and any
 * other "which week is this" question, all decided in the business zone.
 */
export function startOfWeekUtc(zone: string, weekStartDay: Weekday, moment: Date = new Date()): Date {
  const todayYmd = ymdIn(zone, moment);
  const todayStart = zonedTimeToUtc(zone, todayYmd);
  const currentWeekday = weekdayIn(zone, todayStart);
  const daysSinceStart = (WEEKDAY_ORDER.indexOf(currentWeekday) - WEEKDAY_ORDER.indexOf(weekStartDay) + 7) % 7;
  return zonedTimeToUtc(zone, addDays(todayYmd, -daysSinceStart));
}

/**
 * `moment` rendered for a person, in `zone`, labelled -- e.g. `8:00am AWST`.
 * Never the machine's zone or the browser's; always the job's or the
 * business's, passed in by the caller.
 */
export function formatLabelled(zone: string, moment: Date): string {
  const timeParts = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(moment);
  const part = (type: string): string => timeParts.find((entry) => entry.type === type)?.value ?? "";

  const zoneParts = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    timeZoneName: "short",
    hour: "numeric",
  }).formatToParts(moment);
  const zoneName = zoneParts.find((entry) => entry.type === "timeZoneName")?.value ?? zone;

  return `${part("hour")}:${part("minute")}${part("dayPeriod")} ${zoneName}`;
}

/**
 * `zone`'s wall-clock TODAY at `hour:minute` (default: now's calendar day).
 * Feature 2003's fixture seed uses this to keep "accepted for today" true on
 * whichever day the seed actually runs.
 */
export function todayAt(zone: string, hour: number, minute: number, from: Date = new Date()): Date {
  return zonedTimeToUtc(zone, ymdIn(zone, from), hour, minute);
}

/**
 * The next `target` weekday strictly AFTER `from`'s calendar day in `zone`,
 * at `hour:minute` -- e.g. "the next Thursday, 8am". Never today, even if
 * `from` already falls on `target` (feature 2003's fixture seed: a proposed
 * slot always reads in the future).
 */
export function nextWeekdayAt(
  zone: string,
  target: Weekday,
  hour: number,
  minute: number,
  from: Date = new Date(),
): Date {
  const todayYmd = ymdIn(zone, from);
  const currentWeekday = weekdayIn(zone, from);
  const delta = ((WEEKDAY_ORDER.indexOf(target) - WEEKDAY_ORDER.indexOf(currentWeekday) + 7) % 7) || 7;
  return zonedTimeToUtc(zone, addDays(todayYmd, delta), hour, minute);
}

/**
 * `moment` rendered for a dashboard card, in `zone` -- `Today, 1:00pm AWST`
 * on the same calendar day as `now`, otherwise `Thu 10/09, 8:00am AWST`
 * (Contractor Workflow step 3; Flow walkthrough "Contractor dashboard and
 * rates (2003)", state 1).
 */
export function formatSlotLabel(zone: string, moment: Date, now: Date = new Date()): string {
  const time = formatLabelled(zone, moment);
  if (todayIn(zone, moment) === todayIn(zone, now)) {
    return `Today, ${time}`;
  }
  const weekdayLabel = new Intl.DateTimeFormat("en-AU", { timeZone: zone, weekday: "short" }).format(moment);
  const { month, day } = ymdIn(zone, moment);
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${weekdayLabel} ${dd}/${mm}, ${time}`;
}

/**
 * The calendar date `moment` falls on in `zone`, for a person -- `Tue 08/09/26`.
 * Carries the year, unlike formatSlotLabel: the ops queue reaches closed
 * jobs from any year through its Closed filter and search (Feature 4001).
 */
export function formatDateLabel(zone: string, moment: Date): string {
  const weekdayLabel = new Intl.DateTimeFormat("en-AU", { timeZone: zone, weekday: "short" }).format(moment);
  const { year, month, day } = ymdIn(zone, moment);
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const yy = String(year % 100).padStart(2, "0");
  return `${weekdayLabel} ${dd}/${mm}/${yy}`;
}

/**
 * `moment` as a dated time for a person, in `zone` -- `Today, 9:14am AWST`
 * on the same calendar day as `now`, otherwise `Tue 08/09/26, 3:20pm AWST`.
 * When a job arrived, when a note was written (Feature 4001).
 */
export function formatDateTimeLabel(zone: string, moment: Date, now: Date = new Date()): string {
  const time = formatLabelled(zone, moment);
  if (todayIn(zone, moment) === todayIn(zone, now)) {
    return `Today, ${time}`;
  }
  return `${formatDateLabel(zone, moment)}, ${time}`;
}

/**
 * A plain DATE (preferredDate, an expiry) for a person -- `Fri 11/09/26`.
 * A plain date carries no zone and is stored at UTC midnight, so it is read
 * in UTC, the frame it is stored in: no zone conversion happens here.
 */
export function formatPlainDate(date: Date): string {
  return formatDateLabel("UTC", date);
}

/**
 * Interpolate this in place of a bare `now()` whenever raw SQL
 * compares against a stored timestamp. Prisma's `DateTime` is
 * `TIMESTAMP(3) WITHOUT TIME ZONE` holding UTC, while bare `now()` is a
 * `timestamptz` that Postgres renders in the SESSION's zone before comparing
 * -- eight hours ahead of the stored frame on a Perth-zone session (a Perth
 * dev box), exactly right on a UTC session (Fly). This fragment puts both
 * sides of the comparison in the frame the column is actually stored in, so
 * the answer no longer depends on which zone the connecting session happens
 * to be in. 1004's dispatcher hit this first and carries its own local fix
 * (out of this feature's scope); 6003, 6008 and 7002 are this fragment's
 * first callers.
 */
export const NOW_UTC_SQL = "(now() AT TIME ZONE 'UTC')";
