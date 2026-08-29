// Human-readable references and codes -- Feature 1001, schema and seed.
//
// The design's Data Model: records a person quotes, or that leave the system as a
// document, carry a short unique SEQUENTIAL identifier beside the internal id.
//   - documents use `reference`: Job JOB-, Invoice INV-, ContractorSettlement CINV-,
//     Refund CN- (credit note / ATO adjustment note)
//   - parties use `code`: Customer CUS-, Contractor CON-
//
// "Prefixes and the starting number are config. Each sequence is independent."
// This file IS that config. One Postgres sequence per prefix, created in the
// first migration; nextReference() in src/db/reference.ts issues the values.
//
// START NUMBERS sit PAST the cast (project/design/cast.md) so a seeded fixture
// code can never collide with a generated one: the cast holds CON-014, CON-021,
// CON-030, CUS-1050, JOB-1042, INV-2041 and CINV-517, and the features that
// compute those reference jobs create them by hand in their own tests.

export const REFERENCE_PREFIXES = ["JOB", "INV", "CINV", "CN", "CUS", "CON"] as const;

export type ReferencePrefix = (typeof REFERENCE_PREFIXES)[number];

export interface ReferenceSequenceConfig {
  /** the human prefix, e.g. "JOB" -> JOB-1043 */
  prefix: ReferencePrefix;
  /** the Postgres sequence backing it (created in the first migration) */
  sequenceName: string;
  /** first value this sequence ever issues -- past the cast's numbers */
  start: number;
  /** zero-padding width, matching how the cast writes each one */
  padWidth: number;
}

export const REFERENCE_SEQUENCES: Record<ReferencePrefix, ReferenceSequenceConfig> = {
  // cast: JOB-1042 (Sarah's mixer tap) -> start after it
  JOB: { prefix: "JOB", sequenceName: "job_reference_seq", start: 1043, padWidth: 4 },
  // cast: INV-2041 (its invoice)
  INV: { prefix: "INV", sequenceName: "invoice_reference_seq", start: 2042, padWidth: 4 },
  // cast: CINV-517 (the settlement that pays Bob for it)
  CINV: { prefix: "CINV", sequenceName: "settlement_reference_seq", start: 518, padWidth: 3 },
  // no cast credit note yet; start at a readable four-digit number
  CN: { prefix: "CN", sequenceName: "refund_reference_seq", start: 1001, padWidth: 4 },
  // cast: CUS-1050 (Sarah Chen)
  CUS: { prefix: "CUS", sequenceName: "customer_code_seq", start: 1051, padWidth: 4 },
  // cast: CON-014 Bob, CON-021 Dave, CON-030 Priya
  CON: { prefix: "CON", sequenceName: "contractor_code_seq", start: 31, padWidth: 3 },
};

/** "JOB" + 1043 -> "JOB-1043" */
export function formatReference(prefix: ReferencePrefix, value: number): string {
  return `${prefix}-${String(value).padStart(REFERENCE_SEQUENCES[prefix].padWidth, "0")}`;
}

/** "CON-014" -> 14; null when the string is not this prefix's shape. */
export function parseReference(prefix: ReferencePrefix, reference: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(reference);
  return match ? Number(match[1]) : null;
}
