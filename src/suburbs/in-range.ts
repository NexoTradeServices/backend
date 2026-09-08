// GET /api/suburbs/in-range -- Feature 2002, service area builder, plan
// decision 3.
//
// The postcode chips do not come from Google (it has no "list every suburb
// within Xkm" call) -- they come from our own Suburb table, seeded in 1002
// (design: Service Area Matching / Where the chips come from). One PostGIS
// query: every postcode carrying at least one suburb whose centroid is
// within `km` of the pin, each row labelled with ALL its suburbs (not just
// the in-range ones -- "6008 - Daglish, Shenton Park, Subiaco" even if only
// one of the three is actually inside the radius), sorted nearest first.
import type { PrismaClient } from "../db/client.js";

export interface InRangePostcode {
  postcode: string;
  suburbs: string[];
  nearestKm: number;
}

interface InRangeRow {
  postcode: string;
  suburbs: string[];
  nearestKm: number;
}

export async function inRangeSuburbs(
  client: PrismaClient,
  { lat, lng, km }: { lat: number; lng: number; km: number },
): Promise<InRangePostcode[]> {
  const rows = await client.$queryRaw<InRangeRow[]>`
    WITH distances AS (
      SELECT postcode, name,
        ST_Distance(
          ST_MakePoint("centroidLng", "centroidLat")::geography,
          ST_MakePoint(${lng}::float8, ${lat}::float8)::geography
        ) / 1000 AS km
      FROM "Suburb"
    ),
    qualifying AS (
      SELECT DISTINCT postcode
      FROM "Suburb"
      WHERE ST_DWithin(
        ST_MakePoint("centroidLng", "centroidLat")::geography,
        ST_MakePoint(${lng}::float8, ${lat}::float8)::geography,
        ${km}::float8 * 1000
      )
    )
    SELECT d.postcode AS postcode,
           array_agg(d.name ORDER BY d.name) AS suburbs,
           MIN(d.km) AS "nearestKm"
    FROM distances d
    JOIN qualifying q ON q.postcode = d.postcode
    GROUP BY d.postcode
    ORDER BY "nearestKm" ASC
  `;
  return rows.map((row) => ({
    postcode: row.postcode,
    suburbs: row.suburbs,
    nearestKm: Number(row.nearestKm),
  }));
}
