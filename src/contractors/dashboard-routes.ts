// GET /api/contractor/dashboard, GET /api/contractor/rates -- Feature 2003,
// contractor dashboard + rates screen.
//
// Both are the contractor's OWN screens: the contractor comes from the
// session, never the URL (plan decision 7) -- same door as
// service-area-routes.ts (2002).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import type { AssignmentStatus, JobStatus } from "../generated/prisma/enums.js";
import { formatSlotLabel } from "../time/index.js";
import { readyToDispatch, type ReadyInput } from "./ready.js";

async function loadOwnContractor(client: PrismaClient, userId: string) {
  return client.contractor.findUnique({
    where: { userId },
    include: { specialties: true, _count: { select: { servedPostcodes: true } } },
  });
}

function readyInputOf(contractor: NonNullable<Awaited<ReturnType<typeof loadOwnContractor>>>): ReadyInput {
  return {
    businessName: contractor.businessName,
    abn: contractor.abn,
    status: contractor.status,
    insurer: contractor.insurer,
    insurancePolicyNo: contractor.insurancePolicyNo,
    insuranceExpiry: contractor.insuranceExpiry,
    payoutBsb: contractor.payoutBsb,
    payoutAccountNo: contractor.payoutAccountNo,
    payoutAccountName: contractor.payoutAccountName,
    address: contractor.address,
    emergencyContactName: contractor.emergencyContactName,
    emergencyContactPhone: contractor.emergencyContactPhone,
    specialties: contractor.specialties.map((s) => ({ status: s.status, licenceExpiry: s.licenceExpiry })),
    servedPostcodeCount: contractor._count.servedPostcodes,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Job Lifecycle & Statuses: an "on_hold" job has no return slot booked yet --
 * that is what the status means, not an incidental null on the assignment's
 * own (past, original-visit) `confirmedSlot`. An "assigned" assignment is
 * always awaiting its proposed slot; anything else reads the job's confirmed
 * slot, or none while on hold.
 */
function slotFor(
  assignment: { status: AssignmentStatus; proposedSlot: Date | null; confirmedSlot: Date | null },
  jobStatus: JobStatus,
): Date | null {
  if (assignment.status === "assigned") return assignment.proposedSlot;
  if (jobStatus === "on_hold") return null;
  return assignment.confirmedSlot;
}

function suburbOf(serviceLocation: unknown): string {
  if (serviceLocation !== null && typeof serviceLocation === "object") {
    const suburb = (serviceLocation as Record<string, unknown>)["suburb"];
    if (typeof suburb === "string") return suburb;
  }
  return "";
}

export function contractorDashboardRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/dashboard", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const contractor = await loadOwnContractor(client, req.authUser.id);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const { ready, missing } = readyToDispatch(readyInputOf(contractor));

      // AC1: assigned, accepted or in_progress only -- a declined, cancelled
      // or completed assignment never appears (they are the job's history,
      // not its live engagement).
      const assignments = await client.assignment.findMany({
        where: { contractorId: contractor.id, status: { in: ["assigned", "accepted", "in_progress"] } },
        include: {
          job: { include: { customer: { select: { name: true } } } },
          specialty: { select: { trade: true } },
        },
      });

      const now = new Date();
      // Decision 5: unanswered first, then slot ascending, then anything
      // with no slot last.
      const sorted = [...assignments].sort((a, b) => {
        const aUnanswered = a.status === "assigned";
        const bUnanswered = b.status === "assigned";
        if (aUnanswered !== bUnanswered) return aUnanswered ? -1 : 1;
        const aSlot = slotFor(a, a.job.status);
        const bSlot = slotFor(b, b.job.status);
        if (aSlot === null && bSlot === null) return 0;
        if (aSlot === null) return 1;
        if (bSlot === null) return -1;
        return aSlot.getTime() - bSlot.getTime();
      });

      const jobs = sorted.map((assignment) => {
        const slot = slotFor(assignment, assignment.job.status);
        return {
          reference: assignment.job.reference,
          jobStatus: assignment.job.status,
          customerName: assignment.job.customer.name,
          trade: assignment.specialty.trade,
          suburb: suburbOf(assignment.job.serviceLocation),
          slotLabel: slot ? formatSlotLabel(assignment.job.timezone, slot, now) : null,
        };
      });

      res.json({ ready, missing, jobs });
    })().catch((error: unknown) => {
      console.error("GET /api/contractor/dashboard failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  // ---------------------------------------------------------------------------
  // Rates
  // ---------------------------------------------------------------------------

  router.get("/rates", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      // AC11: only the caller's own specialties -- there is no code/id
      // parameter this door accepts, so there is nothing for Bob to guess
      // his way into Dave's rates with.
      const contractor = await client.contractor.findUnique({
        where: { userId: req.authUser.id },
        include: { specialties: { orderBy: { trade: "asc" } } },
      });
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }

      // Contractor pay calculation: weekend = 1.5x, the contractor's own
      // ladder, read off the calendar -- never `Job.serviceLevel`. No third
      // (emergency) row: emergency prices the customer only.
      res.json({
        specialties: contractor.specialties.map((s) => ({
          trade: s.trade,
          status: s.status,
          licenceNumber: s.licenceNumber,
          licenceExpiry: s.licenceExpiry.toISOString().slice(0, 10),
          normal: { callout: s.contractorCalloutRate, standard: s.contractorStandardRate },
          weekend: {
            callout: Math.round(s.contractorCalloutRate * 1.5),
            standard: Math.round(s.contractorStandardRate * 1.5),
          },
        })),
      });
    })().catch((error: unknown) => {
      console.error("GET /api/contractor/rates failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
