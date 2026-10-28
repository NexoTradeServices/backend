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
//
// Feature 3002: the qualifying postcodes come first through ST_DWithin on the
// GiST expression index (migration suburb_spatial_index); distances are then
// computed only for suburbs in those postcodes, never for all of Australia.
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
    WITH qualifying AS (
      SELECT DISTINCT postcode
      FROM "Suburb"
      WHERE ST_DWithin(
        ST_MakePoint("centroidLng", "centroidLat")::geography,
        ST_MakePoint(${lng}::float8, ${lat}::float8)::geography,
        ${km}::float8 * 1000
      )
    )
    SELECT s.postcode AS postcode,
           array_agg(s.name ORDER BY s.name) AS suburbs,
           MIN(ST_Distance(
             ST_MakePoint(s."centroidLng", s."centroidLat")::geography,
             ST_MakePoint(${lng}::float8, ${lat}::float8)::geography
           ) / 1000) AS "nearestKm"
    FROM "Suburb" s
    JOIN qualifying q ON q.postcode = s.postcode
    GROUP BY s.postcode
    ORDER BY "nearestKm" ASC
  `;
  return rows.map((row) => ({
    postcode: row.postcode,
    suburbs: row.suburbs,
    nearestKm: Number(row.nearestKm),
  }));
}
