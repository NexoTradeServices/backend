// Service area: shared shapes, parsing and the save transaction -- Feature
// 2002, service area builder. Used by both the ops endpoint
// (/api/contractors/:code/service-area) and the contractor's own
// (/api/contractor/service-area, self only) -- one screen, one shape, two
// doors (plan decision 1).
import type { PrismaClient } from "../db/client.js";
import { inRangeSuburbs } from "../suburbs/in-range.js";

const VALID_KM = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
const DEFAULT_RADIUS_KM = 30;

// The Places suburb-only pick (frontend-conventions.md, Google Places field;
// plan decision 11): { suburb, state, country, postcode, lat, lng, placeId },
// NEVER a street -- a core location is a suburb pick only.
export interface SuburbPin {
  suburb: string;
  state: string;
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  placeId: string;
  // An index signature, not just the named fields, is what makes this
  // structurally assignable to Prisma's InputJsonObject for the Json column
  // (same technique as contractors/routes.ts's PlacesAddress).
  [key: string]: string | number;
}

export interface ServiceAreaDto {
  coreLocation: SuburbPin | null;
  radiusKm: number;
  postcodes: string[];
}

export interface ServiceAreaInput {
  coreLocation: SuburbPin;
  radiusKm: number;
  postcodes: string[];
}

interface FieldError {
  error: string;
  field: string;
}

type ParseResult = { ok: true; data: ServiceAreaInput } | ({ ok: false } & FieldError);
type SaveResult = { ok: true } | ({ ok: false } & FieldError);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decision 11: the suburb-only Places shape, and nothing else -- a
 * `coreLocation` carrying a `street` (the full-address variant's field) is
 * refused outright, never silently dropped.
 */
function parseCoreLocation(raw: unknown): { ok: true; data: SuburbPin } | ({ ok: false } & FieldError) {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "Pick the suburb the area is built around.", field: "coreLocation" };
  }
  const r = raw as Record<string, unknown>;
  if ("street" in r && isNonEmptyString(r["street"])) {
    return {
      ok: false,
      error: "A core location is a suburb pick only -- no street address.",
      field: "coreLocation",
    };
  }
  if (
    !isNonEmptyString(r["suburb"]) ||
    !isNonEmptyString(r["state"]) ||
    !isNonEmptyString(r["country"]) ||
    !isNonEmptyString(r["postcode"]) ||
    !isFiniteNumber(r["lat"]) ||
    !isFiniteNumber(r["lng"]) ||
    !isNonEmptyString(r["placeId"])
  ) {
    return { ok: false, error: "Pick the suburb from the list, or clear the field.", field: "coreLocation" };
  }
  return {
    ok: true,
    data: {
      suburb: r["suburb"],
      state: r["state"],
      country: r["country"],
      postcode: r["postcode"],
      lat: r["lat"],
      lng: r["lng"],
      placeId: r["placeId"],
    },
  };
}

export function parseServiceAreaInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object", field: "body" };
  }
  const b = body as Record<string, unknown>;

  const coreLocation = parseCoreLocation(b["coreLocation"]);
  if (!coreLocation.ok) return coreLocation;

  const radiusKm = b["radiusKm"];
  if (typeof radiusKm !== "number" || !VALID_KM.has(radiusKm)) {
    return { ok: false, error: "radiusKm must be 5-60 in steps of 5.", field: "radiusKm" };
  }

  const postcodesRaw = b["postcodes"];
  if (!Array.isArray(postcodesRaw) || !postcodesRaw.every(isNonEmptyString)) {
    return { ok: false, error: "postcodes must be a list of postcode strings.", field: "postcodes" };
  }
  if (postcodesRaw.length === 0) {
    return {
      ok: false,
      error: "Keep at least one postcode -- a service area with nothing in it cannot match a job.",
      field: "postcodes",
    };
  }

  return { ok: true, data: { coreLocation: coreLocation.data, radiusKm, postcodes: [...new Set(postcodesRaw)] } };
}

export function serviceAreaDtoOf(contractor: {
  coreLocation: unknown;
  lastRadiusKm: number | null;
  servedPostcodes: { postcode: string }[];
}): ServiceAreaDto {
  return {
    coreLocation: (contractor.coreLocation as SuburbPin | null) ?? null,
    radiusKm: contractor.lastRadiusKm ?? DEFAULT_RADIUS_KM,
    postcodes: contractor.servedPostcodes.map((row) => row.postcode),
  };
}

/**
 * Decision 8: the server re-derives the in-range set itself and refuses any
 * postcode that is neither in range of THIS save's pin+radius nor already on
 * the contractor's served list (a postcode kept from outside the new
 * radius -- decision 7). Nothing is written unless every postcode clears
 * that check; coreLocation + lastRadiusKm update and the served-row replace
 * happen together, in one transaction.
 */
export async function saveServiceArea(
  client: PrismaClient,
  contractorId: string,
  input: ServiceAreaInput,
): Promise<SaveResult> {
  const [existing, inRange] = await Promise.all([
    client.contractorServedPostcode.findMany({ where: { contractorId }, select: { postcode: true } }),
    inRangeSuburbs(client, { lat: input.coreLocation.lat, lng: input.coreLocation.lng, km: input.radiusKm }),
  ]);
  const existingSet = new Set(existing.map((row) => row.postcode));
  const inRangeSet = new Set(inRange.map((row) => row.postcode));

  const invalid = input.postcodes.find((pc) => !inRangeSet.has(pc) && !existingSet.has(pc));
  if (invalid) {
    return {
      ok: false,
      error: `"${invalid}" is neither in range of this pin and radius nor already served.`,
      field: "postcodes",
    };
  }

  await client.$transaction(async (tx) => {
    await tx.contractor.update({
      where: { id: contractorId },
      data: { coreLocation: input.coreLocation, lastRadiusKm: input.radiusKm },
    });
    await tx.contractorServedPostcode.deleteMany({ where: { contractorId } });
    await tx.contractorServedPostcode.createMany({
      data: input.postcodes.map((postcode) => ({ contractorId, postcode })),
    });
  });

  return { ok: true };
}
