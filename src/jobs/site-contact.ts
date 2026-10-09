// The site contact -- Feature 4008.
//
// Operations Admin Workflow / The job queue and the job page: whoever lets
// the contractor in, taken by Mike on the confirming call. Rides the
// Addresses save (plan decision 1): one request, all or nothing. Stored as
// { name, phone } or { name, phone, email }, each trimmed, an empty email
// left out, all three empty stored as null (decision 2).
import { EMAIL_PATTERN } from "../contractors/routes.js";
import type { JobStatus } from "../generated/prisma/enums.js";

export interface SiteContact {
  name: string;
  phone: string;
  email?: string;
  [key: string]: string | undefined;
}

/** The job page's view: the three fields always present, the email null when none was given. */
export interface SiteContactView {
  name: string;
  phone: string;
  email: string | null;
}

/** Decision 4: closed means completed or cancelled -- the enum has no other terminal state. */
export function isClosed(status: JobStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export type SiteContactFailure = { ok: false; status: number; error: string; field: string };

/**
 * undefined = the request said nothing about the site contact (leave it);
 * null = clear it.
 */
export type SiteContactInput = SiteContact | null | undefined;

function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : null;
}

export function parseSiteContact(raw: unknown): { ok: true; data: SiteContactInput } | SiteContactFailure {
  if (raw === undefined) return { ok: true, data: undefined };
  if (raw === null) return { ok: true, data: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "siteContact must be an object", field: "siteContact" };
  }
  const r = raw as Record<string, unknown>;
  const name = textOf(r["name"]);
  const phone = textOf(r["phone"]);
  const email = textOf(r["email"]);
  if (name === null || phone === null || email === null) {
    return { ok: false, status: 400, error: "siteContact fields must be text", field: "siteContact" };
  }
  if (name === "" && phone === "" && email === "") return { ok: true, data: null };
  // All-or-nothing group (Patterns / Validation timing): name and phone together.
  if (name === "") return { ok: false, status: 400, error: "Required.", field: "siteContactName" };
  if (phone === "") return { ok: false, status: 400, error: "Required.", field: "siteContactPhone" };
  if (email !== "" && !EMAIL_PATTERN.test(email)) {
    return {
      ok: false,
      status: 400,
      error: "That does not look like an email address.",
      field: "siteContactEmail",
    };
  }
  return { ok: true, data: email === "" ? { name, phone } : { name, phone, email } };
}

/** A stored value as the screens read it; anything malformed reads as none. */
export function asSiteContact(value: unknown): SiteContactView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["name"] !== "string" || typeof v["phone"] !== "string") return null;
  return { name: v["name"], phone: v["phone"], email: typeof v["email"] === "string" ? v["email"] : null };
}

export function sameSiteContact(a: SiteContactView | null, b: SiteContactInput | null): boolean {
  if (a === null || b === null || b === undefined) return a === null && (b === null || b === undefined);
  return a.name === b.name && a.phone === b.phone && a.email === (b.email ?? null);
}

/**
 * Decision 6, changed by Feature 4006: the name only -- the site contact's, otherwise the customer's. The
 * contractor reaches the person through the office, so no phone rides in the email or the text.
 */
export function siteContactLine(siteContact: unknown, customerName: string): string {
  const contact = asSiteContact(siteContact);
  return contact === null ? customerName : contact.name;
}
