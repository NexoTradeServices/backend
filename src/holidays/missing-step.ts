// The "public holidays missing" step of the morning run -- Feature 1020.
//
// For each state and year missing holidays: the current year every morning; next year on Mondays
// from 1 October and every morning from 1 December. Emails the business inbox once a day per pair
// (idempotency key carries the day). Honours `onlyLabel` the way the expiry step does: a browser
// test's run only reads and writes rows carrying its label.
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import { missingHolidays } from "./missing.js";
import { MINIMUM_HOLIDAYS } from "./missing.js";

/** Is `year` (a year after the current one) due its email on `today`? */
export function nextYearIsDue(today: string): boolean {
  const monthDay = today.slice(5);
  if (monthDay >= "12-01") return true;
  if (monthDay < "10-01") return false;
  // A Monday: the weekday of the plain date, read in UTC (a plain date has no zone).
  return new Date(`${today}T00:00:00.000Z`).getUTCDay() === 1;
}

export async function runPublicHolidaysMissing(
  client: PrismaClient,
  options: { today: string; onlyLabel?: string | null },
): Promise<{ sent: number }> {
  const result = { sent: 0 };
  const currentYear = Number(options.today.slice(0, 4));
  const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorEmail: true } });
  const webOrigin = process.env["WEB_ORIGIN"];
  for (const gap of await missingHolidays(client, options.today)) {
    if (gap.year > currentYear && !nextYearIsDue(options.today)) continue;
    if (options.onlyLabel) {
      // A label run only does work the test itself set up: the labelled holiday rows, or none at all.
      const labelled = await client.publicHoliday.count({ where: { state: gap.state, testData: options.onlyLabel } });
      const settingsLabelled = await client.platformSettings.count({ where: { testData: options.onlyLabel } });
      if (labelled === 0 && settingsLabelled === 0) continue;
    }
    const idempotencyKey = `public_holidays_missing:${gap.state}:${String(gap.year)}:${options.today}`;
    const already = await client.notification.findUnique({ where: { idempotencyKey }, select: { id: true } });
    if (already !== null) continue;
    try {
      await sendNotification(
        {
          type: "public_holidays_missing",
          channel: "email",
          recipientType: "ops",
          recipientId: settings.operatorEmail,
          idempotencyKey,
          context: {
            state: gap.state,
            year: String(gap.year),
            short: !gap.none && gap.count < MINIMUM_HOLIDAYS,
            ...(webOrigin ? { buttonUrl: `${webOrigin}/ops/settings/holidays` } : {}),
          },
        },
        client,
      );
      result.sent += 1;
    } catch (error: unknown) {
      console.error(`public holidays missing: ${gap.state} ${String(gap.year)} could not be asked`, error);
    }
  }
  return result;
}
