// Missing public holidays -- Feature 1020, Calendar & Scheduling / Public holidays.
//
// Derived, never stored: which (state, year) pairs have fewer than MINIMUM_HOLIDAYS holidays
// entered. Feeds the morning run's email and the Needs attention list. `openStates()` is the one
// line feature 1021 replaces when operating states exist.
import type { PrismaClient } from "../db/client.js";

/** Fewer holidays than this in a state and year and the list counts as short. */
export const MINIMUM_HOLIDAYS = 7;

/** The states the business is open in (Feature 1021: the OperatingState rows ticked on Settings). */
export async function openStates(client: Pick<PrismaClient, "operatingState">): Promise<string[]> {
  const rows = await client.operatingState.findMany({ where: { open: true }, orderBy: { state: "asc" }, select: { state: true } });
  return rows.map((row) => row.state);
}

/** Is the business operating in `state`? Feature 1021. */
export async function isOpenState(client: Pick<PrismaClient, "operatingState">, state: string): Promise<boolean> {
  const row = await client.operatingState.findUnique({ where: { state }, select: { open: true } });
  return row?.open === true;
}

export interface MissingHolidays {
  state: string;
  year: number;
  /** How many are entered (0 to MINIMUM_HOLIDAYS - 1). */
  count: number;
  /** True when none are entered at all. */
  none: boolean;
}

/** The years watched on `today` (`YYYY-MM-DD`): the current one always, next year from 1 October. */
export function watchedYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return today.slice(5) >= "10-01" ? [year, year + 1] : [year];
}

export async function missingHolidays(
  client: Pick<PrismaClient, "publicHoliday" | "operatingState">,
  today: string,
): Promise<MissingHolidays[]> {
  const found: MissingHolidays[] = [];
  for (const state of await openStates(client)) {
    for (const year of watchedYears(today)) {
      const count = await client.publicHoliday.count({
        where: { state, date: { gte: new Date(`${String(year)}-01-01T00:00:00.000Z`), lt: new Date(`${String(year + 1)}-01-01T00:00:00.000Z`) } },
      });
      if (count < MINIMUM_HOLIDAYS) found.push({ state, year, count, none: count === 0 });
    }
  }
  return found;
}
