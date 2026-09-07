// Ready to dispatch -- Feature 2001, contractor onboarding (Mike's path).
//
// Feature 2001 -- contractor onboarding: plan decision 3. ONE server
// function, derived every time, never stored (design: Managing the
// contractor record). The list endpoint and the record endpoint both call
// this and return the missing-items list by name; the screen only renders
// it. Feature 4002 will call the same function against the slot date.
//
// The missing-item strings are copy, not internal codes -- confirmed live
// on the Contractor onboarding flow walkthrough, 03 Sep 2026 (missingFor()).
// Two checks run independently rather than as an if/else chain: a
// contractor missing BOTH the insurer/policy AND the expiry gets both
// "insurance details" and "insurance expiry" named, not just one.
import type { ContractorStatus } from "../generated/prisma/enums.js";

export interface ReadySpecialty {
  status: ContractorStatus;
  licenceExpiry: Date;
}

export interface ReadyInput {
  businessName: string | null;
  abn: string | null;
  address: unknown;
  status: ContractorStatus;
  insurer: string | null;
  insurancePolicyNo: string | null;
  insuranceExpiry: Date | null;
  payoutBsb: string | null;
  payoutAccountNo: string | null;
  payoutAccountName: string | null;
  specialties: ReadySpecialty[];
  servedPostcodeCount: number;
}

export interface ReadyResult {
  ready: boolean;
  missing: string[];
}

function isFuture(date: Date, now: Date): boolean {
  return date.getTime() > now.getTime();
}

/** Every counted row of the Contractor record table, in the walkthrough's own order. */
export function readyToDispatch(input: ReadyInput, now: Date = new Date()): ReadyResult {
  const missing: string[] = [];

  if (!input.businessName) missing.push("business name");
  if (!input.abn) missing.push("ABN");
  if (!input.address) missing.push("address");

  const hasCurrentActiveTrade = input.specialties.some(
    (specialty) => specialty.status === "active" && isFuture(specialty.licenceExpiry, now),
  );
  if (!hasCurrentActiveTrade) missing.push("at least one active trade with a current licence");

  if (!input.insurer || !input.insurancePolicyNo) missing.push("insurance details");
  if (input.insuranceExpiry && !isFuture(input.insuranceExpiry, now)) {
    missing.push("insurance renewal (expired)");
  } else if (!input.insuranceExpiry) {
    missing.push("insurance expiry");
  }

  if (!input.payoutBsb || !input.payoutAccountNo || !input.payoutAccountName) {
    missing.push("payout details");
  }

  if (input.status !== "active") missing.push("contractor is deactivated");
  if (input.servedPostcodeCount === 0) missing.push("service area (not set up yet)");

  return { ready: missing.length === 0, missing };
}
