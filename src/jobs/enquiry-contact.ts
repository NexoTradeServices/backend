// What the customer typed on the request -- Feature 3010, per-job contact details.
//
// The email is who a customer is: a request with a known email joins that customer and never changes
// her record. What she typed (name, phone, business name) is kept on the job as `enquiryContact`, this
// job's texts go to its phone, and the job page says where the phone or business name differs from the
// record. A different name alone is shown, never flagged. Derived on every read, never stored.
import type { Prisma } from "../generated/prisma/client.js";

export interface EnquiryContact {
  name: string;
  phone: string;
  businessName?: string;
}

export function asEnquiryContact(value: unknown): EnquiryContact | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["name"] !== "string" || typeof v["phone"] !== "string") return null;
  return {
    name: v["name"],
    phone: v["phone"],
    ...(typeof v["businessName"] === "string" && v["businessName"].trim() !== "" ? { businessName: v["businessName"] } : {}),
  };
}

/** The value written on a new job: business name only when not empty. */
export function enquiryContactOf(input: { name: string; phone: string; businessName: string | null }): Prisma.InputJsonValue {
  return {
    name: input.name,
    phone: input.phone,
    ...(input.businessName !== null && input.businessName.trim() !== "" ? { businessName: input.businessName.trim() } : {}),
  };
}

const digitsOf = (value: string): string => value.replace(/\D/g, "");
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface GivenDetails {
  name: string | null;
  phone: string | null;
  businessName: string | null;
  /** The phone or the business name differs from the record. The name never counts. */
  newDetails: boolean;
}

/** Each given value, or null where it is empty or matches the record (phones compared on their digits). */
export function givenDetails(
  contact: EnquiryContact | null,
  record: { name: string; phone: string | null; businessName: string | null },
): GivenDetails {
  if (contact === null) return { name: null, phone: null, businessName: null, newDetails: false };
  const name = contact.name.trim() !== "" && !same(contact.name, record.name) ? contact.name.trim() : null;
  const phone =
    contact.phone.trim() !== "" && digitsOf(contact.phone) !== digitsOf(record.phone ?? "") ? contact.phone.trim() : null;
  const businessName =
    contact.businessName !== undefined && contact.businessName.trim() !== "" && !same(contact.businessName, record.businessName ?? "")
      ? contact.businessName.trim()
      : null;
  return { name, phone, businessName, newDetails: phone !== null || businessName !== null };
}
