// The completion arithmetic -- Feature 6001, invoice at completion.
//
// Invoicing / Two-tier pricing; Contractor pay calculation. One pure module,
// whole cents throughout, no database and no clock: what Complete freezes goes
// in, both sides' money comes out.
//
// ONE LEVEL, TWO LADDERS. The customer's multiplier is the job's stamped
// service level (normal / emergency / weekend). Bob's multiplier is only ever
// "was the visit on a weekend" -- read off the earliest time entry's date in
// the job's zone, never off the service level. An emergency on a Tuesday pays
// him 1.0; an emergency stamped on a Saturday pays him 1.5.
//
// ONE ROUNDING RULE, both sides: each tier rate times its multiplier is rounded
// to the cent (as `priceFor` does for the display); Tier 2 is the extra hours
// times that rounded rate, rounded to the cent.
import type { ServiceLevel } from "../generated/prisma/enums.js";
import { isWeekend } from "../time/index.js";
import { serviceLevelFor, isServiceLevelMultipliers } from "../jobs/dispatch-level.js";

export const WEEKEND_CONTRACTOR_MULTIPLIER = 1.5;
export const WEEKDAY_CONTRACTOR_MULTIPLIER = 1;

export interface TierRates {
  calloutRate: number;
  standardRate: number;
}

export interface LabourTotal {
  /** The multiplied, rounded call-out rate -- Tier 1's price. */
  tier1Rate: number;
  /** The multiplied, rounded standard rate -- Tier 2's hourly price. */
  tier2Rate: number;
  /** Hours past the first, two decimals; 0 when the job is 1.0h or less. */
  extraHours: number;
  /** Tier 2's total in cents; 0 when there are no extra hours. */
  tier2Total: number;
  /** Tier 1 + Tier 2. */
  total: number;
}

/** `rate x multiplier`, rounded to the cent. */
export function multipliedRate(rate: number, multiplier: number): number {
  return Math.round(rate * multiplier);
}

/** One side's labour: Tier 1 for the first hour, Tier 2 for every hour after it. */
export function labourTotal(base: TierRates, multiplier: number, hours: number): LabourTotal {
  const tier1Rate = multipliedRate(base.calloutRate, multiplier);
  const tier2Rate = multipliedRate(base.standardRate, multiplier);
  // Hours are two decimals; work in hundredths so 2.25 x $180 carries no float dust.
  const extraHundredths = Math.max(0, Math.round(hours * 100) - 100);
  const tier2Total = Math.round((extraHundredths * tier2Rate) / 100);
  return {
    tier1Rate,
    tier2Rate,
    extraHours: extraHundredths / 100,
    tier2Total,
    total: tier1Rate + tier2Total,
  };
}

/**
 * The customer's multiplier: the trade's multiplier for the job's stamped
 * level. If the level is somehow empty the earliest visit's date decides it
 * (weekend or normal), the same call dispatch makes.
 */
export function customerMultiplierOf(
  multipliers: unknown,
  stamped: ServiceLevel | null,
  zone: string,
  earliestStart: Date,
): { level: ServiceLevel; multiplier: number } {
  if (!isServiceLevelMultipliers(multipliers)) {
    throw new Error("the trade's service level multipliers are misconfigured");
  }
  const level = stamped ?? serviceLevelFor(zone, earliestStart, false);
  return { level, multiplier: multipliers[level] };
}

/** Bob's multiplier: 1.5 when the visit began on a Saturday or Sunday in the job's zone, else 1.0. */
export function contractorMultiplierOf(zone: string, earliestStart: Date): number {
  return isWeekend(zone, earliestStart) ? WEEKEND_CONTRACTOR_MULTIPLIER : WEEKDAY_CONTRACTOR_MULTIPLIER;
}

export interface CompletionInput {
  hours: number;
  customerBase: TierRates;
  contractorBase: TierRates;
  customerMultiplier: number;
  contractorMultiplier: number;
  /** Lines of the parts Bob bought himself -- repaid in his payout. */
  contractorPartTotals: readonly number[];
}

export interface CompletionResult {
  customer: LabourTotal;
  contractor: LabourTotal;
  customerTotal: number;
  contractorPay: number;
  materialsReimbursement: number;
}

export function completionArithmetic(input: CompletionInput): CompletionResult {
  const customer = labourTotal(input.customerBase, input.customerMultiplier, input.hours);
  const contractor = labourTotal(input.contractorBase, input.contractorMultiplier, input.hours);
  return {
    customer,
    contractor,
    customerTotal: customer.total,
    contractorPay: contractor.total,
    materialsReimbursement: input.contractorPartTotals.reduce((sum, cents) => sum + cents, 0),
  };
}

/**
 * GST inside a GST-inclusive amount: `amount x rate / (100 + rate)`, to the cent.
 * 65500 at 10% -> 5955. Zero when the switch is off.
 */
export function gstWithin(amount: number, ratePercent: number, applied: boolean): number {
  if (!applied) return 0;
  return Math.round((amount * ratePercent) / (100 + ratePercent));
}
