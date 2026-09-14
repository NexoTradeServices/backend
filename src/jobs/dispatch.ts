// Dispatch to assignment -- Feature 4002.
//
// GET /api/jobs/:reference/dispatch        the job's facts + the slot defaults
// GET /api/jobs/:reference/dispatch/candidates?date=&startMinutes=&holdMinutes=&emergency=
//                                           the candidate list + the level/price for that slot
// POST /api/jobs/:reference/dispatch       the dispatch itself (plan decision 8)
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { sendNotification } from "../notifications/index.js";
import { CapabilityTokenType } from "../capability-tokens/index.js";
import { zonedDateTimeToUtc, formatSlotLabel } from "../time/index.js";
import { serviceLevelFor, priceFor, isServiceLevelMultipliers, type TierRates } from "./dispatch-level.js";
import { formatDollars } from "../enquiries/money.js";
import { loadCandidates, guardReason, readyInputOf, type CandidatesResult } from "./candidates.js";
import { asAddress, suburbOf, effectiveAddress, NO_ADDRESS_REASON, type Address } from "./shared.js";

const WINDOW_START_MINUTES: Record<string, number> = { morning: 420, afternoon: 720, evening: 1020 };

interface DispatchJobRow {
  id: string;
  reference: string;
  status: string;
  timezone: string;
  postcode: string;
  serviceLocation: unknown;
  siteAddress: unknown;
  customerCalloutRate: number;
  customerStandardRate: number;
  description: string | null;
  preferredDate: Date;
  preferredWindow: string;
  serviceType: { trade: string; serviceLevelMultipliers: unknown };
  customer: { name: string; billingAddress: unknown };
}

const dispatchJobInclude = {
  serviceType: { select: { trade: true, serviceLevelMultipliers: true } },
  customer: { select: { name: true, billingAddress: true } },
} satisfies Prisma.JobInclude;

async function loadDispatchJob(client: PrismaClient, reference: string): Promise<DispatchJobRow | null> {
  return client.job.findUnique({ where: { reference }, include: dispatchJobInclude });
}

export interface DispatchFacts {
  reference: string;
  trade: string;
  description: string | null;
  suburb: string;
  siteAddress: Address | null;
  customerName: string;
  defaults: { date: string; startMinutes: number; holdMinutes: number };
}

export function dispatchFactsOf(job: DispatchJobRow): DispatchFacts {
  const window = job.preferredWindow in WINDOW_START_MINUTES ? job.preferredWindow : "morning";
  return {
    reference: job.reference,
    trade: job.serviceType.trade,
    description: job.description,
    suburb: suburbOf(job.serviceLocation),
    siteAddress: effectiveAddress(job),
    customerName: job.customer.name,
    defaults: {
      date: job.preferredDate.toISOString().slice(0, 10),
      startMinutes: WINDOW_START_MINUTES[window] ?? 420,
      holdMinutes: 60,
    },
  };
}

// ---------------------------------------------------------------------------
// The slot -- shared parsing for the candidates read and the dispatch write.
// ---------------------------------------------------------------------------

export interface SlotInput {
  date: string;
  startMinutes: number;
  holdMinutes: number;
  emergency: boolean;
}

export type SlotFailure = { ok: false; status: number; error: string; field?: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function parseSlotInput(raw: Record<string, unknown>): { ok: true; data: SlotInput } | SlotFailure {
  const date = raw["date"];
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    return { ok: false, status: 400, error: "date must be a YYYY-MM-DD date", field: "date" };
  }
  const startMinutes = wholeNumber(raw["startMinutes"]);
  if (startMinutes === null || startMinutes < 0 || startMinutes >= 24 * 60 || startMinutes % 30 !== 0) {
    return { ok: false, status: 400, error: "startMinutes must be a whole number of minutes, on the half hour", field: "startMinutes" };
  }
  const holdMinutes = wholeNumber(raw["holdMinutes"]);
  if (holdMinutes === null || holdMinutes < 60 || holdMinutes > 480 || holdMinutes % 30 !== 0) {
    return { ok: false, status: 400, error: "holdMinutes must be 1 to 8 hours, on the half hour", field: "holdMinutes" };
  }
  const emergencyRaw = raw["emergency"];
  const emergency = emergencyRaw === true || emergencyRaw === "true";
  if (emergencyRaw !== undefined && typeof emergencyRaw !== "boolean" && emergencyRaw !== "true" && emergencyRaw !== "false") {
    return { ok: false, status: 400, error: "emergency must be a boolean", field: "emergency" };
  }
  return { ok: true, data: { date, startMinutes, holdMinutes, emergency } };
}

export function slotInstants(zone: string, slot: SlotInput): { start: Date; end: Date } {
  const hour = Math.floor(slot.startMinutes / 60);
  const minute = slot.startMinutes % 60;
  const start = zonedDateTimeToUtc(zone, slot.date, hour, minute);
  return { start, end: new Date(start.getTime() + slot.holdMinutes * 60_000) };
}

export interface CandidatesAndPrice {
  level: "normal" | "weekend" | "emergency";
  price: { calloutRate: number; standardRate: number };
  candidates: CandidatesResult;
}

export async function candidatesAndPriceFor(
  client: PrismaClient,
  job: DispatchJobRow,
  slot: SlotInput,
): Promise<CandidatesAndPrice | { error: string }> {
  const location = job.serviceLocation as { lat?: unknown; lng?: unknown } | null;
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
    return { error: "the job has no service location" };
  }
  const multipliers = job.serviceType.serviceLevelMultipliers;
  if (!isServiceLevelMultipliers(multipliers)) {
    return { error: "the trade's service level multipliers are misconfigured" };
  }
  const { start, end } = slotInstants(job.timezone, slot);
  const level = serviceLevelFor(job.timezone, start, slot.emergency);
  const base: TierRates = { calloutRate: job.customerCalloutRate, standardRate: job.customerStandardRate };
  const price = priceFor(base, multipliers, level);
  const candidates = await loadCandidates(client, {
    job: { trade: job.serviceType.trade, postcode: job.postcode, lat: location.lat, lng: location.lng },
    zone: job.timezone,
    date: slot.date,
    holdStart: start,
    holdEnd: end,
  });
  return { level, price, candidates };
}

// ---------------------------------------------------------------------------
// The dispatch write
// ---------------------------------------------------------------------------

export type DispatchFailure = { ok: false; status: number; error: string; field?: string };
export interface DispatchSuccess {
  ok: true;
  jobId: string;
  jobReference: string;
  jobTimezone: string;
  trade: string;
  assignmentId: string;
  contractorId: string;
  contractorFirstName: string;
  proposedSlot: Date;
  holdEnd: Date;
  level: "normal" | "weekend" | "emergency";
  siteAddress: Address;
}

class Refused extends Error {
  constructor(readonly failure: DispatchFailure) {
    super(failure.error);
  }
}

export async function dispatchJob(
  client: PrismaClient,
  reference: string,
  contractorCode: string,
  slot: SlotInput,
  now: Date = new Date(),
): Promise<DispatchSuccess | DispatchFailure> {
  try {
    const result = await client.$transaction(async (tx) => {
      const job = await tx.job.findUnique({
        where: { reference },
        include: dispatchJobInclude,
      });
      if (job === null) {
        throw new Refused({ ok: false, status: 404, error: "not found" });
      }

      const address = effectiveAddress(job);
      if (address === null) {
        throw new Refused({ ok: false, status: 400, error: NO_ADDRESS_REASON });
      }

      const location = job.serviceLocation as { lat?: unknown; lng?: unknown } | null;
      if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
        throw new Refused({ ok: false, status: 400, error: "the job has no service location" });
      }
      const multipliers = job.serviceType.serviceLevelMultipliers;
      if (!isServiceLevelMultipliers(multipliers)) {
        throw new Refused({ ok: false, status: 500, error: "the trade's service level multipliers are misconfigured" });
      }

      const { start, end } = slotInstants(job.timezone, slot);
      if (start.getTime() < now.getTime()) {
        throw new Refused({ ok: false, status: 400, error: "A slot in the past cannot be dispatched.", field: "startMinutes" });
      }

      // Lock the Job row (must still be `new`) -- 4001's pattern.
      await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${job.id} FOR UPDATE`;
      const freshStatus = (await tx.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status;
      if (freshStatus !== "new") {
        throw new Refused({ ok: false, status: 409, error: `The job is already ${freshStatus} -- it cannot be dispatched again.` });
      }

      // Lock the Contractor row -- two operators can never book one
      // contractor into the same hour (plan decision 8).
      const contractorId = (
        await tx.contractor.findUnique({ where: { code: contractorCode }, select: { id: true } })
      )?.id;
      if (!contractorId) {
        throw new Refused({ ok: false, status: 404, error: `no contractor "${contractorCode}"`, field: "contractorCode" });
      }
      await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${contractorId} FOR UPDATE`;

      const contractor = await tx.contractor.findUniqueOrThrow({
        where: { id: contractorId },
        include: { specialties: true, servedPostcodes: { select: { postcode: true } } },
      });
      const specialty = contractor.specialties.find((s) => s.trade === job.serviceType.trade);
      if (!specialty) {
        throw new Refused({ ok: false, status: 400, error: `${contractor.name} does not offer ${job.serviceType.trade}` });
      }

      const guardNow = new Date(`${slot.date}T00:00:00.000Z`);
      const guarded = guardReason(
        readyInputOf({ ...contractor, servedPostcodeCount: contractor.servedPostcodes.length }),
        specialty,
        job.serviceType.trade,
        guardNow,
      );
      if (!guarded.ready || guarded.why !== null) {
        throw new Refused({ ok: false, status: 409, error: guarded.why ?? "Not ready to dispatch" });
      }

      // Re-run under the contractor's own lock (AC27): sees any hold another
      // transaction just committed, so two operators can never book one
      // contractor into the same hour.
      const clash = await tx.calendarEvent.findFirst({
        where: { contractorId: contractor.id, startTime: { lt: end }, endTime: { gt: start } },
      });
      if (clash) {
        throw new Refused({ ok: false, status: 409, error: "Busy at that time - pick another slot or another contractor." });
      }

      const level = serviceLevelFor(job.timezone, start, slot.emergency);

      const updatedSite = asAddress(job.siteAddress) ?? address;
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: "assigned",
          serviceLevel: level,
          ...(job.siteAddress === null ? { siteAddress: { ...updatedSite } } : {}),
        },
      });

      const assignment = await tx.assignment.create({
        data: {
          jobId: job.id,
          contractorId: contractor.id,
          specialtyId: specialty.id,
          status: "assigned",
          proposedSlot: start,
          ratingAtDispatch: contractor.averageRating,
        },
      });

      await tx.calendarEvent.create({
        data: {
          contractorId: contractor.id,
          type: "job",
          jobId: job.id,
          assignmentId: assignment.id,
          startTime: start,
          endTime: end,
        },
      });

      return {
        ok: true as const,
        jobId: job.id,
        jobReference: job.reference,
        jobTimezone: job.timezone,
        trade: job.serviceType.trade,
        assignmentId: assignment.id,
        contractorId: contractor.id,
        contractorFirstName: contractor.name.split(" ")[0] ?? contractor.name,
        proposedSlot: start,
        holdEnd: end,
        level,
        siteAddress: updatedSite,
      };
    });
    return result;
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

/**
 * Plan decision 8: "the two messages are asked after commit, so a rolled
 * back dispatch sends nothing" -- called only once `dispatchJob` returns ok.
 */
export async function sendDispatchNotifications(client: PrismaClient, success: DispatchSuccess): Promise<void> {
  const address = success.siteAddress;
  const context = {
    firstName: success.contractorFirstName,
    jobReference: success.jobReference,
    trade: success.trade,
    street: address.street,
    suburb: address.suburb,
    slotLabel: formatSlotLabel(success.jobTimezone, success.proposedSlot),
  };
  for (const channel of ["email", "sms"] as const) {
    await sendNotification(
      {
        type: "job_dispatched",
        channel,
        recipientType: "contractor",
        recipientId: success.contractorId,
        idempotencyKey: `job_dispatched:assignment:${success.assignmentId}:${channel}`,
        relatedType: "assignment",
        relatedId: success.assignmentId,
        jobId: success.jobId,
        context,
        capabilityLink: {
          type: CapabilityTokenType.respond,
          assignmentId: success.assignmentId,
          expiresAt: success.proposedSlot.toISOString(),
        },
      },
      client,
    );
  }
}

export function formatDollarsPrice(price: { calloutRate: number; standardRate: number }): { calloutRate: string; standardRate: string } {
  return { calloutRate: formatDollars(price.calloutRate), standardRate: formatDollars(price.standardRate) };
}

export { loadDispatchJob };
