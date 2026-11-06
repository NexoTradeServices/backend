// The three Reasons for a return visit or a hold -- Feature 5002. Apart so the job page's read can use them without
// importing the booking code.
import type { ReturnReasonKind } from "../generated/prisma/enums.js";

export const REASON_LABELS: Record<ReturnReasonKind, string> = {
  part_on_order: "Part on order",
  more_time_needed: "More time needed",
  other: "Other",
};
