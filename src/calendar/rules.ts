// Calendar rules -- Feature 1020, Calendar & Scheduling / Opening hours and Public holidays.
//
// THE ONE HOME other features call to ask "may a job be booked then?". Dispatch and reschedule call
// `slotRefusal`; the two forms and the request edit call `holidayRefusalForDate`; 5002 (return
// visits) calls `slotRefusal` too.
import type { PrismaClient } from "../db/client.js";

/** Anything with the Prisma read methods this module needs (the client or a transaction). */
type Reader = Pick<PrismaClient, "publicHoliday" | "platformSettings">;

export interface PublicHolidayRow {
  id: string;
  state: string;
  date: Date;
  name: string;
}

/** `YYYY-MM-DD` of a plain DATE column value. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The state of a job's `serviceLocation`, or null when it carries none. */
export function stateOfLocation(serviceLocation: unknown): string | null {
  if (serviceLocation !== null && typeof serviceLocation === "object") {
    const state = (serviceLocation as Record<string, unknown>)["state"];
    if (typeof state === "string" && state !== "") return state;
  }
  return null;
}

/** "HH:MM" on the half hour -> minutes since midnight. */
export function minutesOf(clock: string): number {
  const [hour, minute] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** True for "HH:MM" on a half-hour step. */
export function isHalfHourClock(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):(00|30)$/.test(value);
}

/** The holiday the business observes on `date` (`YYYY-MM-DD`) in `state`, or null. */
export async function holidayOn(
  client: Pick<PrismaClient, "publicHoliday">,
  state: string,
  date: string,
): Promise<PublicHolidayRow | null> {
  return client.publicHoliday.findUnique({
    where: { state_date: { state, date: new Date(`${date}T00:00:00.000Z`) } },
    select: { id: true, state: true, date: true, name: true },
  });
}

/** "Closed for Christmas Day. Pick another day." -- the dispatch and reschedule words. */
export function holidaySlotWords(name: string): string {
  return `Closed for ${name}. Pick another day.`;
}

/** "We're closed on Christmas Day. Please pick another date." -- the wanted-date words. */
export function holidayDateWords(name: string): string {
  return `We're closed on ${name}. Please pick another date.`;
}

export const OUTSIDE_HOURS_WORDS = "That time is outside opening hours. Pick another time.";

/**
 * The refusal words for a slot, or null when the slot is fine: the holiday check on the job's state
 * first, then the opening hours check on the start and the end (start + hold) of the slot.
 */
export async function slotRefusal(
  client: Reader,
  job: { serviceLocation: unknown },
  slot: { date: string; startMinutes: number; holdMinutes: number },
): Promise<string | null> {
  const state = stateOfLocation(job.serviceLocation);
  if (state !== null) {
    const holiday = await holidayOn(client, state, slot.date);
    if (holiday !== null) return holidaySlotWords(holiday.name);
  }
  const settings = await client.platformSettings.findFirstOrThrow({ select: { openingTime: true, closingTime: true } });
  if (slot.startMinutes < minutesOf(settings.openingTime) || slot.startMinutes + slot.holdMinutes > minutesOf(settings.closingTime)) {
    return OUTSIDE_HOURS_WORDS;
  }
  return null;
}

/** The wanted-date refusal words for a holiday in `state`, or null. */
export async function holidayRefusalForDate(
  client: Pick<PrismaClient, "publicHoliday">,
  state: string,
  date: string,
): Promise<string | null> {
  const holiday = await holidayOn(client, state, date);
  return holiday === null ? null : holidayDateWords(holiday.name);
}
