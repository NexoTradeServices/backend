// Shared pieces of the ops job module -- Feature 4001, ops job queue and job
// detail. The queue row and the job page read one job the same way: one
// include, one "which assignment is shown", one wording of where it stands.
import type { Prisma } from "../generated/prisma/client.js";
import type { AssignmentStatus, JobStatus, PreferredWindow } from "../generated/prisma/enums.js";
import { formatDateLabel, formatSlotLabel } from "../time/index.js";

/** Operations Admin Workflow / The job queue and the job page: open work only. */
export const OPEN_STATUSES: readonly JobStatus[] = ["new", "assigned", "scheduled", "in_progress", "on_hold"];
/** Reached through the Closed filter or search, never by scrolling past them. */
export const CLOSED_STATUSES: readonly JobStatus[] = ["completed", "cancelled"];

export const WINDOW_LABELS: Record<PreferredWindow, string> = {
  morning: "morning 7:00-12:00",
  afternoon: "afternoon 12:00-17:00",
  evening: "evening 17:00-20:00",
};

/**
 * The assignment a screen shows: the active one (Job Lifecycle & Statuses -
 * at most one active at a time), or on a completed job the visit that
 * completed it. Declined and cancelled attempts are history, never shown.
 */
const SHOWN_ASSIGNMENT_STATUSES: AssignmentStatus[] = ["assigned", "accepted", "in_progress", "completed"];

export const jobInclude = {
  customer: { select: { code: true, name: true, phone: true, email: true, billingAddress: true } },
  serviceType: { select: { trade: true, serviceLevelMultipliers: true } },
  assignments: {
    where: { status: { in: SHOWN_ASSIGNMENT_STATUSES } },
    orderBy: { dispatchedAt: "desc" },
    take: 1,
    include: { contractor: { select: { name: true, code: true } } },
  },
} satisfies Prisma.JobInclude;

export type JobWithRelations = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

/** A structured Places pick (Data Model / Location) -- never free text. */
export interface Address {
  street: string;
  suburb: string;
  state: string;
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  placeId: string;
  // Makes it assignable to Prisma's InputJsonObject for the Json columns
  // (same technique as contractors/routes.ts's PlacesAddress).
  [key: string]: string | number;
}

/** A stored address JSON value as the screens read it; anything not an object reads as none. */
export function asAddress(value: unknown): Address | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Address;
}

/** Same place: the same Places pick and the same street (plan decision 6). */
export function sameAddress(a: Address | null, b: Address | null): boolean {
  if (a === null || b === null) return a === b;
  return a.placeId === b.placeId && a.street === b.street;
}

/** Dispatch Logic -- MVP -- Manual: a job with no address at all cannot be dispatched. */
export const NO_ADDRESS_REASON = "Job site address required before dispatch.";

/** Feature 4002: the job's own site, or -- until one is picked -- the customer's billing address (Dispatch Logic). */
export function effectiveAddress(job: { siteAddress: unknown; customer: { billingAddress: unknown } }): Address | null {
  return asAddress(job.siteAddress) ?? asAddress(job.customer.billingAddress);
}

export function suburbOf(serviceLocation: unknown): string {
  if (serviceLocation !== null && typeof serviceLocation === "object") {
    const suburb = (serviceLocation as Record<string, unknown>)["suburb"];
    if (typeof suburb === "string") return suburb;
  }
  return "";
}

export function shownAssignment(job: JobWithRelations) {
  return job.assignments[0] ?? null;
}

/** Plan decision 5: the active assignment's slot, confirmed first, else proposed. */
export function sortSlot(job: JobWithRelations): Date | null {
  const assignment = shownAssignment(job);
  if (!assignment) return null;
  return assignment.confirmedSlot ?? assignment.proposedSlot;
}

export interface ContractorView {
  name: string;
  code: string;
  /** Where the assignment stands, in plain words, times in the job's zone. */
  standing: string;
}

export function contractorView(job: JobWithRelations, now: Date): ContractorView | null {
  const assignment = shownAssignment(job);
  if (!assignment) return null;
  const firstName = assignment.contractor.name.split(" ")[0] ?? assignment.contractor.name;
  const zone = job.timezone;
  let standing: string;
  if (assignment.status === "assigned") {
    standing = assignment.proposedSlot
      ? `Waiting for ${firstName}'s answer - proposed ${formatSlotLabel(zone, assignment.proposedSlot, now)}`
      : `Waiting for ${firstName}'s answer`;
  } else if (assignment.status === "completed") {
    standing = assignment.completedAt ? `Completed ${formatDateLabel(zone, assignment.completedAt)}` : "Completed";
  } else if (job.status === "on_hold") {
    // Job Lifecycle & Statuses: on hold means no return slot is booked yet,
    // whatever the original visit's confirmedSlot still holds.
    standing = "On hold - no return date yet";
  } else if (job.status === "in_progress") {
    standing = "On site - work underway";
  } else {
    const slot = assignment.confirmedSlot ?? assignment.proposedSlot;
    standing = slot ? `Booked - ${formatSlotLabel(zone, slot, now)}` : "Booked";
  }
  return { name: assignment.contractor.name, code: assignment.contractor.code, standing };
}

/** How long a new job has waited -- `12m`, `1h 28m`, `2d 3h`. A duration has no zone. */
export function waitingFor(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}
