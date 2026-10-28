// Coverage tiers -- Feature 3002, Service Area Matching / Coverage tiers at
// enquiry.
//
// One derivation, used by the enquiry check and the ops queue -- never a
// second copy. The tier is worked out every time it is shown and never
// stored: covered (an active contractor lists the postcode), near_miss
// (nobody lists it, but an active core is within `serviceReachKm`) or
// out_of_reach. Trade-blind, and only active contractors count.
import type { PrismaClient } from "../db/client.js";

export type CoverageTier = "covered" | "near_miss" | "out_of_reach";

export interface Coverage {
  tier: CoverageTier;
  /** km from the point to the nearest active contractor's core; null when no active core exists. */
  nearestKm: number | null;
}

export interface CoverageInput {
  postcode: string;
  lat: number;
  lng: number;
}

interface NearestRow {
  idx: number;
  km: number | null;
}

/** The batch form: one answer per input, in the same order, from a fixed number of queries. */
export async function coverageFor(client: PrismaClient, inputs: CoverageInput[]): Promise<Coverage[]> {
  if (inputs.length === 0) return [];
  const settings = await client.platformSettings.findFirst({ select: { serviceReachKm: true } });
  const reachKm = settings?.serviceReachKm ?? 25;

  const postcodes = [...new Set(inputs.map((input) => input.postcode))];
  const served = await client.contractorServedPostcode.findMany({
    where: { postcode: { in: postcodes }, contractor: { status: "active" } },
    select: { postcode: true },
    distinct: ["postcode"],
  });
  const servedSet = new Set(served.map((row) => row.postcode));

  const open = inputs.map((input, idx) => ({ ...input, idx })).filter((input) => !servedSet.has(input.postcode));
  const nearest = new Map<number, number | null>();
  if (open.length > 0) {
    const idxs = open.map((input) => input.idx);
    const lats = open.map((input) => input.lat);
    const lngs = open.map((input) => input.lng);
    const rows = await client.$queryRaw<NearestRow[]>`
      SELECT p.idx::int AS idx,
             MIN(ST_Distance(
               ST_MakePoint((c."coreLocation"->>'lng')::float8, (c."coreLocation"->>'lat')::float8)::geography,
               ST_MakePoint(p.lng, p.lat)::geography
             ) / 1000) AS km
        FROM UNNEST(${idxs}::int[], ${lats}::float8[], ${lngs}::float8[]) AS p(idx, lat, lng)
        LEFT JOIN "Contractor" c ON c.status = 'active' AND c."coreLocation" IS NOT NULL
       GROUP BY p.idx
    `;
    for (const row of rows) nearest.set(row.idx, row.km === null ? null : Number(row.km));
  }

  return inputs.map((input, idx): Coverage => {
    if (servedSet.has(input.postcode)) return { tier: "covered", nearestKm: null };
    const nearestKm = nearest.get(idx) ?? null;
    if (nearestKm !== null && nearestKm <= reachKm) return { tier: "near_miss", nearestKm };
    return { tier: "out_of_reach", nearestKm };
  });
}

export async function coverageOf(client: PrismaClient, input: CoverageInput): Promise<Coverage> {
  const [coverage] = await coverageFor(client, [input]);
  return coverage;
}
