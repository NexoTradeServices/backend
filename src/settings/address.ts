// The business address on the settings row -- Feature 2006.
//
// Places shape, like Customer.billingAddress: a picked full street address,
// or nothing. The seed's placeholder has no placeId (it was never picked), so
// the id is optional here -- a save of the untouched seed still goes through.
import type { Prisma } from "../generated/prisma/client.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface StreetAddress {
  street: string;
  suburb: string;
  state: string;
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  placeId: string | null;
}

/** null stays null; a well-formed address is returned clean; anything else is `undefined` (an error). */
export function parseStreetAddress(value: unknown): (StreetAddress & Prisma.InputJsonObject) | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const { street, suburb, state, country, postcode, lat, lng, placeId } = v;
  if (
    !isNonEmptyString(street) ||
    !isNonEmptyString(suburb) ||
    !isNonEmptyString(state) ||
    !isNonEmptyString(country) ||
    !isNonEmptyString(postcode) ||
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lng)
  ) {
    return undefined;
  }
  if (placeId !== undefined && placeId !== null && typeof placeId !== "string") return undefined;
  return { street, suburb, state, country, postcode, lat, lng, placeId: placeId ?? null };
}

/** One line for a printed header: "1 Hay Street, Perth WA 6000, Australia". */
export function addressLine(address: unknown): string {
  if (address === null || typeof address !== "object") return "";
  const a = address as Record<string, unknown>;
  const text = (key: string): string => {
    const value = a[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const locality = [text("suburb"), text("state"), text("postcode")].filter(Boolean).join(" ");
  return [text("street"), locality, text("country")].filter(Boolean).join(", ");
}
