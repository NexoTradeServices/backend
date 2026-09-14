// Service level and price -- Feature 4002, dispatch to assignment.
//
// Plan decision 9: one function turns a slot into a level. Dispatch stamps
// Job.serviceLevel from the slot's date in the job's zone (Dispatch Logic --
// "Service level is set here, and the date decides it"): Saturday/Sunday is
// weekend, every other day normal. Emergency is the one level set by hand
// and overrides the day.
import type { ServiceLevel } from "../generated/prisma/enums.js";
import { isWeekend } from "../time/index.js";
import { formatDollars } from "../enquiries/money.js";

export function serviceLevelFor(zone: string, start: Date, emergency: boolean): ServiceLevel {
  if (emergency) return "emergency";
  return isWeekend(zone, start) ? "weekend" : "normal";
}

export interface ServiceLevelMultipliers {
  normal: number;
  emergency: number;
  weekend: number;
}

export function isServiceLevelMultipliers(value: unknown): value is ServiceLevelMultipliers {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["normal"] === "number" && typeof v["emergency"] === "number" && typeof v["weekend"] === "number";
}

export interface TierRates {
  calloutRate: number;
  standardRate: number;
}

/**
 * Plan decision 10: the job's frozen (unmultiplied) rates times the level's
 * multiplier, rounded to whole cents -- for display only, never stored
 * (Invoicing / Two-tier pricing -- rate snapshots).
 */
export function priceFor(base: TierRates, multipliers: ServiceLevelMultipliers, level: ServiceLevel): TierRates {
  const multiplier = multipliers[level];
  return {
    calloutRate: Math.round(base.calloutRate * multiplier),
    standardRate: Math.round(base.standardRate * multiplier),
  };
}

/** "First hour (includes call-out) $250, then $180/h" -- the dispatch page and job page's own wording. */
export function priceLine(base: TierRates, multipliers: ServiceLevelMultipliers, level: ServiceLevel): string {
  const price = priceFor(base, multipliers, level);
  return `First hour (includes call-out) ${formatDollars(price.calloutRate)}, then ${formatDollars(price.standardRate)}/h`;
}
