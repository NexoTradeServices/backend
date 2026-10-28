// Feature 1001, schema and seed
//
// AC9  PostGIS answers a distance query
// 3002 AC13 the Suburb table carries its GiST expression index, and the in-range qualifying query uses it
//
// This is the query behind the operator's distance number at dispatch: how far
// is Bob from the job? Coordinates are already stored (Places supplies them), so
// no geocoding step is involved -- PostGIS just measures.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

interface LatLng {
  lat: number;
  lng: number;
}

beforeAll(async () => {
  db = testClient();
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC9 -- Fremantle to Hilton", () => {
  test("AC9: one PostGIS call returns 1-10 km between Bob's core location and Sarah's Hilton address", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });

    const bobAt = bob.coreLocation as unknown as LatLng;
    const sarahAt = sarah.billingAddress as unknown as LatLng;

    // ::geography measures on the globe, in metres -- the honest distance, not a
    // flat-earth approximation of degrees.
    const rows = await db.$queryRaw<{ km: number }[]>`
      SELECT ST_Distance(
               ST_MakePoint(${bobAt.lng}::float8, ${bobAt.lat}::float8)::geography,
               ST_MakePoint(${sarahAt.lng}::float8, ${sarahAt.lat}::float8)::geography
             ) / 1000 AS km
    `;

    const km = rows[0].km;
    expect(km).toBeGreaterThan(1);
    expect(km).toBeLessThan(10);
  });

  test("AC9: the distance is symmetric and zero to itself", async () => {
    const rows = await db.$queryRaw<{ there: number; back: number; self: number }[]>`
      SELECT ST_Distance(a, b) AS there, ST_Distance(b, a) AS back, ST_Distance(a, a) AS self
        FROM (SELECT
                ST_MakePoint(115.7439::float8, -32.0569::float8)::geography AS a,
                ST_MakePoint(115.7797::float8, -32.0731::float8)::geography AS b
             ) AS points
    `;
    const { there, back, self } = rows[0];
    expect(there).toBeCloseTo(back, 6);
    expect(self).toBe(0);
  });
});

describe("3002 AC13 -- the Suburb spatial index", () => {
  test("the index exists after migrating (a later migration that drops it is caught here)", async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'Suburb' AND indexname = 'Suburb_centroid_geog_idx'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/USING gist/i);
  });

  test("the qualifying-postcodes query reads through it (seq scan switched off: the table is tiny)", async () => {
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRaw<{ "QUERY PLAN": string }[]>`
        EXPLAIN SELECT DISTINCT postcode FROM "Suburb"
        WHERE ST_DWithin(
          ST_MakePoint("centroidLng", "centroidLat")::geography,
          ST_MakePoint(${115.0}::float8, ${-32.0}::float8)::geography,
          ${10}::float8 * 1000
        )
      `;
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("Suburb_centroid_geog_idx");
  });
});
