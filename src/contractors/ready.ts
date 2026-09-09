// Ready to dispatch -- Feature 2001, contractor onboarding (Mike's path);
// extended by Feature 2003, contractor dashboard, plan decision 1: "one
// derivation, extended -- never a second copy."
//
// Feature 2001 -- contractor onboarding: plan decision 3. ONE server
// function, derived every time, never stored (design: Managing the
// contractor record). The list endpoint and the record endpoint both call
// this and return the missing-items list; the screen only renders it.
// Feature 4002 will call the same function against the slot date.
//
// Feature 2003 turned each plain string into a structured item (plan
// decision 2: "the server decides, the screen renders") so the contractor's
// own dashboard panel can point his own gaps at their fixing page and send
// Mike's gaps to the office, without the frontend ever holding a list of
// what is missing or whose pen it is. `copy` keeps the exact wording ops has
// shown since 2001 -- ops's list/record screens read `item.copy` in place of
// the old bare string, so their rendered text is unchanged.
//
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
  status: ContractorStatus;
  insurer: string | null;
  insurancePolicyNo: string | null;
  insuranceExpiry: Date | null;
  payoutBsb: string | null;
  payoutAccountNo: string | null;
  payoutAccountName: string | null;
  address: unknown;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  specialties: ReadySpecialty[];
  servedPostcodeCount: number;
}

/** Whose pen fixes this item -- Managing the contractor record / Pens. */
export type ReadinessPen = "own" | "mikes";

export interface ReadinessItem {
  /** stable identifier -- never re-derived from `copy` by a caller */
  key: string;
  /** the missing-item wording, unchanged since 2001 */
  copy: string;
  pen: ReadinessPen;
  /**
   * The contractor-portal route that fixes it, present only once that page
   * is built (plan decision 3, the nav's `built` flag pattern) -- null for
   * every Mike's-pen item (no action, ever) and for an own-pen item whose
   * page (2005, 2006) has not shipped yet.
   */
  route: string | null;
  /** counts toward "Not ready to dispatch" -- Managing the contractor record */
  blocking: boolean;
}

export interface ReadyResult {
  ready: boolean;
  missing: ReadinessItem[];
}

function isFuture(date: Date, now: Date): boolean {
  return date.getTime() > now.getTime();
}

function isEmptyAddress(address: unknown): boolean {
  if (address === null || address === undefined) return true;
  if (typeof address !== "object") return true;
  const street = (address as Record<string, unknown>)["street"];
  return typeof street !== "string" || street.trim() === "";
}

/** Every counted row of the Contractor record table, in the walkthrough's own order. */
export function readyToDispatch(input: ReadyInput, now: Date = new Date()): ReadyResult {
  const missing: ReadinessItem[] = [];

  if (!input.businessName) {
    missing.push({ key: "business_name", copy: "business name", pen: "mikes", route: null, blocking: true });
  }
  if (!input.abn) {
    missing.push({ key: "abn", copy: "ABN", pen: "mikes", route: null, blocking: true });
  }

  // Design, "Managing the contractor record": the contractor's own address
  // and the emergency contact pair never BLOCK -- licence, insurance, an
  // active trade and a service area are what make someone safe to send;
  // where they live is administrative and should never hold up a job. Since
  // 2003 they still ride the list, flagged non-blocking (decision 4).
  const hasCurrentActiveTrade = input.specialties.some(
    (specialty) => specialty.status === "active" && isFuture(specialty.licenceExpiry, now),
  );
  if (!hasCurrentActiveTrade) {
    missing.push({
      key: "active_trade",
      copy: "at least one active trade with a current licence",
      pen: "mikes",
      route: null,
      blocking: true,
    });
  }

  if (!input.insurer || !input.insurancePolicyNo) {
    missing.push({ key: "insurance_details", copy: "insurance details", pen: "mikes", route: null, blocking: true });
  }
  if (input.insuranceExpiry && !isFuture(input.insuranceExpiry, now)) {
    missing.push({
      key: "insurance_renewal",
      copy: "insurance renewal (expired)",
      pen: "mikes",
      route: null,
      blocking: true,
    });
  } else if (!input.insuranceExpiry) {
    missing.push({ key: "insurance_expiry", copy: "insurance expiry", pen: "mikes", route: null, blocking: true });
  }

  if (!input.payoutBsb || !input.payoutAccountNo || !input.payoutAccountName) {
    // Bank details are his own pen (Pens), but /contractor/details is 2005 --
    // no route until it ships (decision 3).
    missing.push({ key: "payout_details", copy: "payout details", pen: "own", route: null, blocking: true });
  }

  if (input.status !== "active") {
    missing.push({
      key: "contractor_deactivated",
      copy: "contractor is deactivated",
      pen: "mikes",
      route: null,
      blocking: true,
    });
  }
  if (input.servedPostcodeCount === 0) {
    missing.push({
      key: "service_area",
      copy: "service area (not set up yet)",
      pen: "own",
      route: "/contractor/service-area",
      blocking: true,
    });
  }

  // Non-blocking nudges (decision 4) -- his own pen, /contractor/details is
  // 2005, no route until it ships.
  if (isEmptyAddress(input.address)) {
    missing.push({ key: "address", copy: "own address", pen: "own", route: null, blocking: false });
  }
  if (!input.emergencyContactName || !input.emergencyContactPhone) {
    missing.push({
      key: "emergency_contact",
      copy: "emergency contact details",
      pen: "own",
      route: null,
      blocking: false,
    });
  }

  // Managing the contractor record / What the contractor sees on his
  // dashboard, and plan.md's Frontend task breakdown: "his own first ...
  // Mike's after" -- a stable sort, so ops's list (which reads this same
  // array) keeps every pen's items in the checks' own order, just grouped.
  const byPen = [...missing].sort((a, b) => (a.pen === b.pen ? 0 : a.pen === "own" ? -1 : 1));

  return { ready: missing.every((item) => !item.blocking), missing: byPen };
}
