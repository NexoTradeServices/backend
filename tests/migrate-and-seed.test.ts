// Feature 1001 -- project/delivery/1001-schema-and-seed/plan.md
//
// AC1  migrate + base seed on an empty Postgres, and again with no change
// AC3  the PlatformSettings singleton
// AC4  the seeded ServiceType catalog
// AC5  the fixture seed mirrors project/design/cast.md
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  dropAllOwnedObjects,
  managedTableNames,
  migrateDeploy,
  testClient,
  truncateAll,
} from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

/** The one migration this feature ships -- read as a file by the AC1 guard below. */
const INIT_MIGRATION_SQL = new URL(
  "../prisma/migrations/20260818120000_init/migration.sql",
  import.meta.url,
);

/** Everything the base seed is responsible for, in a comparable shape. */
async function baseSeedSnapshot(client: PrismaClient): Promise<string> {
  const settings = await client.platformSettings.findMany({ orderBy: { id: "asc" } });
  const serviceTypes = await client.serviceType.findMany({ orderBy: { trade: "asc" } });
  const counts: Record<string, number> = {};
  for (const table of await managedTableNames(client)) {
    const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM public."${table}"`,
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return JSON.stringify({ settings, serviceTypes, counts }, null, 2);
}

beforeAll(() => {
  db = testClient();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- migrate + base seed, twice", () => {
  let firstRun: string;
  let secondRun: string;
  let firstDeployOutput: string;
  let secondDeployOutput: string;

  beforeAll(async () => {
    // A genuinely empty Postgres: drop every object this role owns. PostGIS
    // stays (it belongs to postgres), which is the real shape of dev and Neon.
    await dropAllOwnedObjects(db);

    firstDeployOutput = migrateDeploy();
    await seedBase(db);
    firstRun = await baseSeedSnapshot(db);

    secondDeployOutput = migrateDeploy();
    await seedBase(db);
    secondRun = await baseSeedSnapshot(db);
  });

  test("AC1: `prisma migrate deploy` applies the migration to an empty database", () => {
    expect(firstDeployOutput).toContain("20260818120000_init");
    expect(firstDeployOutput).toContain("All migrations have been successfully applied");
  });

  test("AC1: the second `prisma migrate deploy` finds nothing left to do", () => {
    expect(secondDeployOutput).toContain("No pending migrations to apply");
  });

  test("AC1: running migrate + base seed a second time changes nothing", () => {
    expect(secondRun).toEqual(firstRun);
  });

  // Review finding R1.5. This block used to hold one test, "the PostGIS
  // extension is present after migrating", and it could not fail. The wipe that
  // runs before migrating deliberately leaves PostGIS standing -- it belongs to
  // `postgres`, not to the app role -- so the extension was already there before
  // `migrate deploy` was called, and the assertion passed by construction.
  //
  // The deeper fact behind that, verified rather than assumed: the app role
  // CANNOT create the extension at all. `CREATE EXTENSION postgis` as
  // `tradeservice` returns "permission denied to create extension postgis,
  // HINT: Must be superuser to create this extension." So the migration's
  // `CREATE EXTENSION IF NOT EXISTS postgis` is a silent no-op on .40, and no
  // test run here can ever exercise it. PostGIS is a PRECONDITION of migrating,
  // not a product of it (setup/01 installs it on .40, setup/03 on Neon).
  //
  // The two tests below are what is honestly coverable, and both can fail.

  test("AC1: the init migration still carries the PostGIS extension statement", async () => {
    // Guards the statement against silent deletion. It is the only thing that
    // makes the migration correct wherever the migrating role IS allowed to
    // create extensions -- Neon grants ordinary roles exactly that, and that is
    // the environment where nobody is standing by with a superuser shell.
    const sql = await readFile(INIT_MIGRATION_SQL, "utf8");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS postgis;");
  });

  test("AC1: PostGIS is present and usable by the app role (a precondition, not a product, of migrating)", async () => {
    const extensions = await db.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'postgis'
    `;
    expect(
      extensions,
      `PostGIS is missing from this database. It is not installed by the migration -- the app role is not a superuser and cannot install it. Provision it first: see project/setup/01-dev-environment.md (.40) or 03-prod-environment.md (Neon).`,
    ).toHaveLength(1);

    // Present in the catalog is not the same as callable by this role, and it is
    // the call that AC9 depends on.
    const usable = await db.$queryRaw<{ km: number }[]>`
      SELECT ST_DistanceSphere(ST_MakePoint(0, 0), ST_MakePoint(0, 1)) / 1000 AS km
    `;
    expect(usable[0]?.km).toBeGreaterThan(0);
  });
});

describe("AC3 -- the PlatformSettings singleton", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
  });

  test("AC3: exactly one PlatformSettings row exists after the base seed", async () => {
    expect(await db.platformSettings.count()).toBe(1);
  });

  test("AC3: it carries the settled values -- GST off at 10%, 7-day terms, 30-minute return-visit floor, $150 part cap", async () => {
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.gstRegistered).toBe(false);
    expect(settings.gstRatePercent.toString()).toBe("10");
    expect(settings.paymentTermsDays).toBe(7);
    expect(settings.returnVisitMinimumMinutes).toBe(30);
    expect(settings.maxContractorPartAmount).toBe(15_000);
  });

  test("AC3: the payout run is Mike's Friday one", async () => {
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.payoutCycle).toBe("weekly");
    expect(settings.payoutDay).toBe("fri");
  });

  test("AC3: the owner's placeholders are seeded and non-empty (they are edited in 1006)", async () => {
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.serviceReachKm).toBeGreaterThan(0);
    expect(settings.calloutFee).toBeGreaterThan(0);
    expect(settings.operatorPhone.length).toBeGreaterThan(0);
  });

  test("AC3: a second base seed does not add a second row", async () => {
    await seedBase(db);
    expect(await db.platformSettings.count()).toBe(1);
  });
});

describe("AC4 -- the ServiceType catalog", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
  });

  test("AC4: Plumbing carries the rates behind INV-2041 -- $250 call-out, $180/h", async () => {
    const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    expect(plumbing.customerCalloutRate).toBe(25_000);
    expect(plumbing.customerStandardRate).toBe(18_000);
  });

  test("AC4: Electrical and Air conditioning are seeded with placeholder rates", async () => {
    for (const trade of ["Electrical", "Air conditioning"]) {
      const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade } });
      expect(serviceType.customerCalloutRate).toBeGreaterThan(0);
      expect(serviceType.customerStandardRate).toBeGreaterThan(0);
    }
  });

  test("AC4: every service type carries the three service-level multipliers", async () => {
    const serviceTypes = await db.serviceType.findMany();
    expect(serviceTypes).toHaveLength(3);
    for (const serviceType of serviceTypes) {
      expect(serviceType.serviceLevelMultipliers).toEqual({
        normal: 1,
        emergency: 1.5,
        weekend: 1.5,
      });
    }
  });
});

describe("AC5 -- the fixture seed mirrors the cast", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
    await seedFixtures(db);
  });

  test("AC5: Bob Reilly is CON-014, plumbing at 20000/15000 cents, licence PL-8841", async () => {
    const bob = await db.contractor.findUniqueOrThrow({
      where: { code: "CON-014" },
      include: { specialties: true },
    });
    expect(bob.name).toBe("Bob Reilly");
    expect(bob.specialties).toHaveLength(1);
    const plumbing = bob.specialties[0];
    expect(plumbing.trade).toBe("Plumbing");
    expect(plumbing.contractorCalloutRate).toBe(20_000);
    expect(plumbing.contractorStandardRate).toBe(15_000);
    expect(plumbing.licenceNumber).toBe("PL-8841");
  });

  test("AC5: Bob's core location is Fremantle", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    expect(bob.coreLocation).toMatchObject({ suburb: "Fremantle", postcode: "6160", state: "WA" });
  });

  test("AC5: Dave Hurst is CON-021 with BOTH electrical 21000/15500 and air conditioning 21500/16000", async () => {
    const dave = await db.contractor.findUniqueOrThrow({
      where: { code: "CON-021" },
      include: { specialties: { orderBy: { trade: "asc" } } },
    });
    expect(dave.name).toBe("Dave Hurst");
    expect(dave.specialties.map((s) => s.trade)).toEqual(["Air conditioning", "Electrical"]);
    const aircon = dave.specialties[0];
    const electrical = dave.specialties[1];
    expect(aircon.contractorCalloutRate).toBe(21_500);
    expect(aircon.contractorStandardRate).toBe(16_000);
    expect(electrical.contractorCalloutRate).toBe(21_000);
    expect(electrical.contractorStandardRate).toBe(15_500);
  });

  test("AC5: Priya Nair is CON-030, electrical at 21500/16000", async () => {
    const priya = await db.contractor.findUniqueOrThrow({
      where: { code: "CON-030" },
      include: { specialties: true },
    });
    expect(priya.name).toBe("Priya Nair");
    expect(priya.specialties).toHaveLength(1);
    expect(priya.specialties[0].trade).toBe("Electrical");
    expect(priya.specialties[0].contractorCalloutRate).toBe(21_500);
    expect(priya.specialties[0].contractorStandardRate).toBe(16_000);
  });

  test("AC5: Sarah Chen is CUS-1050 in Hilton 6163 and is a GUEST -- no userId", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.name).toBe("Sarah Chen");
    expect(sarah.userId).toBeNull();
    expect(sarah.billingAddress).toMatchObject({ suburb: "Hilton", postcode: "6163" });
  });

  test("AC5: every seeded contractor has a login; the guest customer does not", async () => {
    const contractorUsers = await db.user.findMany({ where: { role: "contractor" } });
    expect(contractorUsers).toHaveLength(3);
    expect(await db.user.count({ where: { role: "customer" } })).toBe(0);
  });

  test("AC5: running the fixture seed again creates no duplicates", async () => {
    const before = await db.contractor.count();
    const result = await seedFixtures(db);
    expect(result.contractorsCreated).toEqual([]);
    expect(result.customersCreated).toEqual([]);
    expect(await db.contractor.count()).toBe(before);
  });
});
