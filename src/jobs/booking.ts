// Taking a booking off the books -- Feature 4006, reschedule / take off / cancel.
//
// One shared step for every way a held booking ends by Mike's hand (Ops job
// actions; Foundations / Ground rules, the audit-trail convention): the
// assignment reads cancelled with who and when, its calendar block is freed,
// and its respond link is expired (kept, so a dead link can say why).
// 6005's Mark no-show reuses it.
import type { Prisma } from "../generated/prisma/client.js";
import { CapabilityTokenType, revokeByAssignment } from "../capability-tokens/index.js";

type Tx = Prisma.TransactionClient;

export async function cancelBooking(tx: Tx, assignmentId: string, userId: string, now: Date): Promise<void> {
  await tx.assignment.update({
    where: { id: assignmentId },
    data: { status: "cancelled", cancelledByUserId: userId, cancelledAt: now },
  });
  await tx.calendarEvent.deleteMany({ where: { assignmentId } });
  await revokeByAssignment(tx, assignmentId, [CapabilityTokenType.respond], now);
}

/** What happened to a cancelled booking -- derived, never stored (plan: Job detail, Earlier bookings). */
export type CancelledKind = "moved" | "taken_off" | "cancelled";

export const CANCELLED_KIND_LABELS: Record<CancelledKind, string> = {
  moved: "Moved",
  taken_off: "Taken off",
  cancelled: "Cancelled",
};

interface CancelledAssignment {
  id: string;
  contractorId: string;
  cancelledAt: Date | null;
}

/**
 * Moved: a reschedule books the replacement in the same step, so the same
 * contractor's next booking was dispatched at the very moment this one was
 * cancelled. Cancelled: the job itself was closed at that moment. Anything
 * else is a take off (the job went back to New).
 */
export async function cancelledKindOf(
  db: Tx,
  assignment: CancelledAssignment,
  job: { id: string; status: string; cancelledAt: Date | null },
): Promise<CancelledKind> {
  const at = assignment.cancelledAt;
  if (at !== null) {
    const replacement = await db.assignment.findFirst({
      where: { jobId: job.id, contractorId: assignment.contractorId, id: { not: assignment.id }, dispatchedAt: at },
      select: { id: true },
    });
    if (replacement !== null) return "moved";
    if (job.status === "cancelled" && job.cancelledAt !== null && job.cancelledAt.getTime() === at.getTime()) {
      return "cancelled";
    }
    return "taken_off";
  }
  return job.status === "cancelled" ? "cancelled" : "taken_off";
}
