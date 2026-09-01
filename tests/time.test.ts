// Feature 1008 -- time foundation
//
// AC1  the migration backfills an existing PlatformSettings row, and a fresh seed
// AC2  the state map: one assertion per AU state
// AC3  a weekend moment is decided in the job's zone, not UTC's
// AC4  labelled rendering, in the job's zone
// AC5  "today" and the payout-week boundary derive through PlatformSettings.timezone
// AC6  (B-005) the safe raw-SQL fragment agrees across sessions in different zones
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase, PLATFORM_SETTINGS_ID } from "../src/db/seed/base.js";
import {
  zoneForState,
  isWeekend,
  formatLabelled,
  todayIn,
  startOfWeekUtc,
  NOW_UTC_SQL,
} from "../src/time/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

const TIME_FOUNDATION_MIGRATION = new URL(
  "../prisma/migrations/20260901090000_time_foundation/migration.sql",
  import.meta.url,
);

beforeAll(() => {
  db = testClient();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- the migration backfills an existing row, and a fresh seed", () => {
  beforeAll(async () => {
    await truncateAll(db);
  });

  test("AC1: applied to a database with a pre-existing settings row, it backfills Australia/Perth", async () => {
    await seedBase(db); // the one PlatformSettings row, today's (post-1008) schema

    // Roll both columns back to the shape dev and prod actually had before
    // this feature's migration ran: Job carried no timezone column at all,
    // and the one existing PlatformSettings row had none either.
    await db.$executeRawUnsafe(`ALTER TABLE "PlatformSettings" DROP COLUMN "timezone"`);
    await db.$executeRawUnsafe(`ALTER TABLE "Job" DROP COLUMN "timezone"`);

    // The migration itself, verbatim from the file `prisma migrate deploy` runs.
    const migrationSql = await readFile(TIME_FOUNDATION_MIGRATION, "utf8");
    await db.$executeRawUnsafe(migrationSql);

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.timezone).toBe("Australia/Perth");
  });

  test("AC1: a fresh migrate + seed also carries Australia/Perth", async () => {
    await truncateAll(db);
    await seedBase(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.timezone).toBe("Australia/Perth");
  });
});

describe("AC2 -- the state map, one AU state at a time", () => {
  test.each([
    ["WA", "Australia/Perth"],
    ["NSW", "Australia/Sydney"],
    ["VIC", "Australia/Melbourne"],
    ["QLD", "Australia/Brisbane"],
    ["SA", "Australia/Adelaide"],
    ["TAS", "Australia/Hobart"],
    ["ACT", "Australia/Sydney"],
    ["NT", "Australia/Darwin"],
  ])("AC2: a %s serviceLocation yields %s", (state, zone) => {
    expect(zoneForState(state)).toBe(zone);
  });

  test("AC2: an unmapped state throws rather than silently guessing a zone", () => {
    expect(() => zoneForState("XX")).toThrow(/no IANA zone mapped/);
  });
});

describe("AC3 -- a weekend moment is decided in the job's zone", () => {
  // 2026-01-16T20:00:00Z is still Friday in UTC, but 4:00am Saturday in Perth
  // (UTC+8) -- the weekend-pricing rule's exact shape.
  const moment = new Date("2026-01-16T20:00:00Z");

  test("AC3: Saturday morning in Perth, still Friday in UTC, is decided a WEEKEND moment through the job zone", () => {
    expect(isWeekend(zoneForState("WA"), moment)).toBe(true);
  });

  test("AC3: the same instant, read in a zone still on Friday, is not a weekend moment", () => {
    expect(isWeekend("UTC", moment)).toBe(false);
  });
});

describe("AC4 -- labelled rendering, in the job's zone", () => {
  // 2026-01-15T00:00:00Z is 8:00am in Perth (UTC+8, no daylight saving).
  const moment = new Date("2026-01-15T00:00:00Z");

  test("AC4: rendering JOB-1042's moment for Perth produces 8:00am AWST", () => {
    expect(formatLabelled(zoneForState("WA"), moment)).toBe("8:00am AWST");
  });

  test("AC4: the same instant labels differently in Sydney's zone -- proof it is zone-driven, not hardcoded", () => {
    expect(formatLabelled(zoneForState("NSW"), moment)).toBe("11:00am AEDT");
  });
});

describe("AC5 -- today and the payout-week boundary derive through PlatformSettings.timezone", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
  });

  // 2026-01-16T20:00:00Z: already 4:00am Saturday 17 Jan in Perth, still
  // 9:00am Friday 16 Jan in Pacific/Midway (UTC-11) -- one calendar day and
  // one payout week apart, purely because of which zone is asked.
  const moment = new Date("2026-01-16T20:00:00Z");

  async function setTimezone(zone: string): Promise<string> {
    const settings = await db.platformSettings.update({
      where: { id: PLATFORM_SETTINGS_ID },
      data: { timezone: zone },
    });
    return settings.timezone;
  }

  test("AC5: flipping PlatformSettings.timezone moves the 'today' answer for the same moment", async () => {
    const midway = await setTimezone("Pacific/Midway");
    expect(todayIn(midway, moment)).toBe("2026-01-16");

    const perth = await setTimezone("Australia/Perth");
    expect(todayIn(perth, moment)).toBe("2026-01-17");
  });

  test("AC5: flipping PlatformSettings.timezone moves the payout-week boundary the same way", async () => {
    const midway = await setTimezone("Pacific/Midway");
    expect(startOfWeekUtc(midway, "fri", moment).toISOString()).toBe("2026-01-16T11:00:00.000Z");

    const perth = await setTimezone("Australia/Perth");
    expect(startOfWeekUtc(perth, "fri", moment).toISOString()).toBe("2026-01-15T16:00:00.000Z");
  });
});

describe("AC6 (B-005) -- the safe raw-SQL fragment", () => {
  /** One raw comparison, run inside a transaction pinned to `sessionZone`. */
  async function compareUnder(
    sessionZone: string,
    storedUtc: Date,
  ): Promise<{ safe: boolean; bare: boolean }> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${sessionZone}'`);
      const rows = await tx.$queryRawUnsafe<{ safe: boolean; bare: boolean }[]>(
        `SELECT ($1::timestamp <= ${NOW_UTC_SQL}) AS safe, ($1::timestamp <= now()) AS bare`,
        storedUtc,
      );
      return rows[0];
    });
  }

  test("AC6: a stored timestamp compares identically against NOW_UTC_SQL on a Perth-zone session and a UTC session", async () => {
    // 2 hours out: past due only if 8 (or more) hours were wrongly added, as
    // B-005's bare `now()` on a Perth session does.
    const storedFutureUtc = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const perth = await compareUnder("Australia/Perth", storedFutureUtc);
    const utc = await compareUnder("UTC", storedFutureUtc);

    expect(perth.safe).toBe(false);
    expect(utc.safe).toBe(false);
  });

  test("AC6: the bare now() comparison is exactly the B-005 trap it replaces -- session-dependent, and wrong on Perth", async () => {
    const storedFutureUtc = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const perth = await compareUnder("Australia/Perth", storedFutureUtc);
    const utc = await compareUnder("UTC", storedFutureUtc);

    // The Perth session's bare now() is 8 hours ahead of the stored UTC
    // frame, so a moment only 2 hours out already looks due there -- the
    // 8-hours-early bug is impossible through NOW_UTC_SQL above, and this is
    // what it would look like without it.
    expect(perth.bare).toBe(true);
    expect(utc.bare).toBe(false);
  });
});
