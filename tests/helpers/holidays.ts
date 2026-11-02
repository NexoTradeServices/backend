// Seven public holidays for every state in every year 2025-2030 -- Feature 1020 (and 1021: the fixtures open NSW).
//
// The morning run now has a "public holidays missing" step that emails the office when a year has
// fewer than seven. A test that runs the whole morning run and counts emails seeds these so that step
// stays quiet; the tests that are ABOUT the step (holidays-missing.test.ts) enter their own.
import type { PrismaClient } from "../../src/db/client.js";

export async function seedWaHolidays(db: PrismaClient): Promise<void> {
  const data = [];
  for (const state of ["WA", "NSW", "VIC", "QLD", "SA", "TAS", "ACT", "NT"]) {
    for (let year = 2025; year <= 2030; year += 1) {
      for (let i = 0; i < 7; i += 1) data.push({ state, date: new Date(Date.UTC(year, i, 10)), name: `Test holiday ${String(i + 1)}` });
    }
  }
  await db.publicHoliday.createMany({ data, skipDuplicates: true });
}
