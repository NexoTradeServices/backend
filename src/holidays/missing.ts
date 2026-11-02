// Missing public holidays -- Feature 1020, Calendar & Scheduling / Public holidays.
//
// Derived, never stored: which (state, year) pairs have fewer than MINIMUM_HOLIDAYS holidays
// entered. Feeds the morning run's email and the Needs attention list. `openStates()` is the one
// line feature 1021 replaces when operating states exist.
import type { PrismaClient } from "../db/client.js";

/** Fewer holidays than this in a state and year and the list counts as short. */
export const MINIMUM_HOLIDAYS = 7;

/** The states the business is open in. WA only until 1021 adds operating states. */
export function openStates(): Promise<string[]> {
  return Promise.resolve(["WA"]);
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
  client: Pick<PrismaClient, "publicHoliday" | "platformSettings">,
  today: string,
): Promise<MissingHolidays[]> {
  const found: MissingHolidays[] = [];
  for (const state of await openStates()) {
    for (const year of watchedYears(today)) {
      const count = await client.publicHoliday.count({
        where: { state, date: { gte: new Date(`${String(year)}-01-01T00:00:00.000Z`), lt: new Date(`${String(year + 1)}-01-01T00:00:00.000Z`) } },
      });
      if (count < MINIMUM_HOLIDAYS) found.push({ state, year, count, none: count === 0 });
    }
  }
  return found;
}
