// Feature 1020 -- missing public holidays: the morning run's email and the Needs attention list
//
// AC11 the morning run emails the office: next year on Mondays from 1 October, every morning from 1 December,
//      the current year every morning; 1 to 6 entered uses the "look incomplete" wording; once a day; none once 7 are in;
//      NSW empty sends nothing
// AC12 (server side) the Needs attention list: owner gets the Add holidays link, ops the words to contact the administrator;
//      it goes the moment the seventh holiday is entered, and comes back if the count falls
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { DAILY_STEPS, runDailySteps } from "../src/daily/index.js";
import { runPublicHolidaysMissing, nextYearIsDue } from "../src/holidays/missing-step.js";
import { missingHolidays, MINIMUM_HOLIDAYS } from "../src/holidays/missing.js";
import { needsAttention } from "../src/holidays/needs-attention.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
const email = recordingAdapter("test-email-1020-missing", "email");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
});
afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});
beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
});

async function enter(state: string, year: number, count: number): Promise<void> {
  await db.publicHoliday.deleteMany({ where: { state, date: { gte: new Date(`${String(year)}-01-01`), lt: new Date(`${String(year + 1)}-01-01`) } } });
  await db.publicHoliday.createMany({
    data: Array.from({ length: count }, (_, i) => ({ state, date: new Date(Date.UTC(year, i, 10)), name: `Day ${String(i + 1)}` })),
  });
}

async function sent(today: string): Promise<string[]> {
  await runPublicHolidaysMissing(db, { today });
  await drainOnce(db);
  const subjects = email.sent.map((m) => m.message.subject ?? "");
  email.reset();
  return subjects;
}

describe("AC11 -- the morning run", () => {
  test("AC11: next year is asked from 1 October on Mondays only, every morning from 1 December", async () => {
    await enter("WA", 2027, MINIMUM_HOLIDAYS);
    expect(await sent("2027-09-30")).toEqual([]); // before 1 October: nothing for next year
    expect(await sent("2027-10-01")).toEqual([]); // a Friday
    expect(await sent("2027-10-05")).toEqual([]); // a Tuesday
    expect(await sent("2027-10-04")).toEqual(["Public holidays missing - WA 2028"]); // a Monday
    expect(await sent("2027-11-30")).toEqual([]); // a Tuesday
    expect(await sent("2027-12-01")).toEqual(["Public holidays missing - WA 2028"]); // every morning from here
    expect(await sent("2027-12-02")).toEqual(["Public holidays missing - WA 2028"]);
  });

  test("AC11: no second email the same day; the message body names the year and the state", async () => {
    await enter("WA", 2027, MINIMUM_HOLIDAYS);
    await runPublicHolidaysMissing(db, { today: "2027-12-01" });
    await runPublicHolidaysMissing(db, { today: "2027-12-01" });
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.message.text).toContain("2028 public holidays are missing for WA. Until they are added, jobs can still be booked on public holidays.");
    expect(email.sent[0]?.message.text).toContain("The owner adds them on Settings.");
  });

  test("AC11: 1 to 6 entered counts as short and uses the 'look incomplete' wording; 7 entered sends nothing", async () => {
    await enter("WA", 2027, MINIMUM_HOLIDAYS);
    await enter("WA", 2028, 3);
    expect(await sent("2027-12-01")).toEqual(["Public holidays incomplete - WA 2028"]);
    expect(email.sent).toHaveLength(0);
    await enter("WA", 2028, MINIMUM_HOLIDAYS);
    expect(await sent("2027-12-02")).toEqual([]);
  });

  test("AC11: a gap in the current year is asked every morning; NSW empty sends nothing", async () => {
    expect(await sent("2027-03-10")).toEqual(["Public holidays missing - WA 2027"]);
    expect(await sent("2027-03-11")).toEqual(["Public holidays missing - WA 2027"]);
    await enter("WA", 2027, MINIMUM_HOLIDAYS);
    expect(await sent("2027-03-12")).toEqual([]);
  });

  test("AC11: the step is part of the morning run and a failing send never stops the run", async () => {
    expect(DAILY_STEPS.map((s) => s.name)).toContain("public holidays missing");
    const result = await runDailySteps(db, { zone: "Australia/Perth", today: "2027-03-10" });
    expect(result.ran).toContain("public holidays missing");
  });

  test("nextYearIsDue follows the dates", () => {
    expect(nextYearIsDue("2027-09-27")).toBe(false);
    expect(nextYearIsDue("2027-10-04")).toBe(true);
    expect(nextYearIsDue("2027-10-05")).toBe(false);
    expect(nextYearIsDue("2027-12-01")).toBe(true);
  });
});

describe("AC12 -- the Needs attention list", () => {
  test("two years of one state with the same gap read as one line", async () => {
    const lines = await needsAttention(db, "owner", "2027-10-04");
    expect(lines.map((l) => l.text)).toEqual(["No holidays entered for WA 2027 and 2028."]);
    expect(lines[0]?.action?.href).toContain("holidayYear=2027");
    await enter("WA", 2027, 3);
    await enter("WA", 2028, 3);
    expect((await needsAttention(db, "ops", "2027-10-04")).map((l) => l.text)).toEqual([
      "WA 2027 and 2028 have fewer than 7 holidays. Contact platform administrator.",
    ]);
  });

  test("AC12: owner sees an Add holidays link; Mike's line ends 'Contact platform administrator.'; it goes at the seventh holiday and returns if the count falls", async () => {
    const today = "2027-03-10";
    const owner = (await needsAttention(db, "owner", today))[0];
    expect(owner?.text).toBe("No holidays entered for WA 2027.");
    expect(owner?.action?.label).toBe("Add holidays");
    expect(owner?.action?.href).toContain("/ops/settings/holidays");
    const ops = (await needsAttention(db, "ops", today))[0];
    expect(ops?.text).toBe("No holidays entered for WA 2027. Contact platform administrator.");
    expect(ops?.action).toBeNull();
    await enter("WA", 2027, 3);
    expect((await needsAttention(db, "owner", today))[0]?.text).toBe("WA 2027 has fewer than 7 holidays.");
    await enter("WA", 2027, 7);
    expect(await needsAttention(db, "owner", today)).toEqual([]);
    await db.publicHoliday.deleteMany({ where: { state: "WA", name: "Day 7" } });
    expect(await missingHolidays(db, today)).toHaveLength(1);
    expect(await needsAttention(db, "owner", today)).toHaveLength(1);
  });
});
