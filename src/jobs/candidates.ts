// The candidate list -- Feature 4002, dispatch to assignment.
//
// Dispatch Logic / MVP -- Manual: every active contractor with a specialty
// in the job's trade, in two groups (serves this postcode / outside their
// area), pickable first then greyed, each part nearest first. Plan decision
// 2: the guard is `readyToDispatch` -- one derivation, never a second copy
// -- run with `now` at UTC midnight of the slot's local date, plus a check
// of the specialty matching the job's trade (active, licence current
// through the slot). Plan decision 5: busy is any CalendarEvent overlapping
// the hold. Plan decision 6: distance is PostGIS ST_Distance, computed here,
// never stored.
import type { PrismaClient } from "../db/client.js";
import type { ContractorStatus } from "../generated/prisma/enums.js";
import { readyToDispatch, type ReadyInput } from "../contractors/ready.js";
import { dateOnlyAsUtcMidnight, formatTimeRangeLabel, formatPlainDateShort } from "../time/index.js";

export interface DispatchJob {
  trade: string;
  postcode: string;
  lat: number;
  lng: number;
}

export interface Rating {
  average: number;
  count: number;
}

export interface CandidateRow {
  code: string;
  name: string;
  /** the overall Ready / Not ready tag (readyToDispatch's own verdict). */
  ready: boolean;
  /** ready AND no other block (busy) -- Mike can send him. */
  pickable: boolean;
  /** the greyed reason, in the wording ready.ts or this module settles on; null when pickable. */
  why: string | null;
  /** true = his served-postcodes list carries the job's postcode (top group). */
  served: boolean;
  distanceKm: number | null;
  pay: { calloutRate: number; standardRate: number };
  rating: Rating | null;
}

export interface CandidatesResult {
  serves: CandidateRow[];
  outside: CandidateRow[];
}

/** Everything the guard and the row need, one query. */
async function loadContractorsForTrade(client: PrismaClient, trade: string) {
  return client.contractor.findMany({
    where: { status: "active", specialties: { some: { trade } } },
    include: {
      specialties: true,
      servedPostcodes: { select: { postcode: true } },
    },
  });
}

export interface ContractorForGuard {
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
  specialties: { status: ContractorStatus; licenceExpiry: Date }[];
  servedPostcodeCount: number;
}

/** Exported so the dispatch write path (a separate transaction, its own load shape) builds the same `ReadyInput` -- one derivation, never a second copy. */
export function readyInputOf(contractor: ContractorForGuard): ReadyInput {
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
    servedPostcodeCount: contractor.servedPostcodeCount,
  };
}

export interface SpecialtyGuardInput {
  status: ContractorStatus;
  licenceExpiry: Date;
}

/**
 * Plan decision 2, cell by cell: the overall Ready check, then -- only once
 * that passes -- the specialty matching this job's trade (active, licence
 * current through the slot). Shared by the read-only candidate list and the
 * dispatch write's own re-check under lock, so the two can never drift.
 */
export function guardReason(
  input: ReadyInput,
  specialty: SpecialtyGuardInput,
  trade: string,
  guardNow: Date,
): { ready: boolean; why: string | null } {
  const { ready, missing } = readyToDispatch(input, guardNow);
  if (!ready) {
    const blocking = missing.filter((item) => item.blocking).map((item) => item.copy);
    return { ready: false, why: `Not ready to dispatch - missing ${blocking.join(", ")}` };
  }
  if (specialty.status !== "active") {
    return { ready: true, why: `${trade} suspended` };
  }
  if (specialty.licenceExpiry.getTime() <= guardNow.getTime()) {
    return { ready: true, why: `${trade} licence expires ${formatPlainDateShort(specialty.licenceExpiry)}, before this slot` };
  }
  return { ready: true, why: null };
}

interface DistanceRow {
  id: string;
  km: number;
}

async function distancesFor(
  client: PrismaClient,
  ids: string[],
  job: DispatchJob,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<DistanceRow[]>`
    SELECT id,
           ST_Distance(
             ST_MakePoint(("coreLocation"->>'lng')::float8, ("coreLocation"->>'lat')::float8)::geography,
             ST_MakePoint(${job.lng}::float8, ${job.lat}::float8)::geography
           ) / 1000 AS km
      FROM "Contractor"
     WHERE id = ANY(${ids}) AND "coreLocation" IS NOT NULL
  `;
  return new Map(rows.map((row) => [row.id, Number(row.km)]));
}

interface BusyRow {
  contractorId: string;
  startTime: Date;
  endTime: Date;
  jobReference: string | null;
  suburb: string | null;
}

/** Plan decision 5: any CalendarEvent overlapping [holdStart, holdEnd) -- declined/cancelled blocks are deleted, so no status filter is needed. */
async function busyFor(
  client: PrismaClient,
  ids: string[],
  holdStart: Date,
  holdEnd: Date,
): Promise<Map<string, BusyRow>> {
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<BusyRow[]>`
    SELECT DISTINCT ON (ce."contractorId")
           ce."contractorId" AS "contractorId", ce."startTime", ce."endTime",
           j.reference AS "jobReference",
           j."serviceLocation"->>'suburb' AS suburb
      FROM "CalendarEvent" ce
      LEFT JOIN "Job" j ON j.id = ce."jobId"
     WHERE ce."contractorId" = ANY(${ids})
       AND ce."startTime" < ${holdEnd}
       AND ce."endTime" > ${holdStart}
     ORDER BY ce."contractorId", ce."startTime" ASC
  `;
  return new Map(rows.map((row) => [row.contractorId, row]));
}

function ratingOf(contractor: { averageRating: number | null; reviewCount: number | null }): Rating | null {
  if (contractor.averageRating === null || contractor.reviewCount === null) return null;
  return { average: contractor.averageRating, count: contractor.reviewCount };
}

/**
 * Plan decision 7: served before outside; inside each group pickable before
 * greyed, each part nearest first (no core location sorts last), then name.
 */
function sortRows(a: CandidateRow, b: CandidateRow): number {
  if (a.pickable !== b.pickable) return a.pickable ? -1 : 1;
  if (a.distanceKm === null && b.distanceKm !== null) return 1;
  if (a.distanceKm !== null && b.distanceKm === null) return -1;
  if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) {
    return a.distanceKm - b.distanceKm;
  }
  return a.name.localeCompare(b.name);
}

export interface CandidatesInput {
  job: DispatchJob;
  zone: string;
  /** the picked calendar day, YYYY-MM-DD, in the job's own zone. */
  date: string;
  holdStart: Date;
  holdEnd: Date;
}

export async function loadCandidates(client: PrismaClient, input: CandidatesInput): Promise<CandidatesResult> {
  const contractors = await loadContractorsForTrade(client, input.job.trade);
  const ids = contractors.map((c) => c.id);
  const [distances, busy] = await Promise.all([
    distancesFor(client, ids, input.job),
    busyFor(client, ids, input.holdStart, input.holdEnd),
  ]);

  // Plan decision 2: "run with now set to UTC midnight of the slot's local
  // date" -- the same frame licenceExpiry/insuranceExpiry are stored in, so
  // a plain-date comparison (never a zone conversion) decides "still current
  // through the slot".
  const guardNow = dateOnlyAsUtcMidnight(input.date);

  const serves: CandidateRow[] = [];
  const outside: CandidateRow[] = [];

  for (const contractor of contractors) {
    const specialty = contractor.specialties.find((s) => s.trade === input.job.trade);
    if (!specialty) continue; // not a candidate at all

    const guarded = guardReason(
      readyInputOf({ ...contractor, servedPostcodeCount: contractor.servedPostcodes.length }),
      specialty,
      input.job.trade,
      guardNow,
    );
    let why = guarded.why;
    if (why === null) {
      const clash = busy.get(contractor.id);
      if (clash) {
        const where = clash.jobReference ? ` - ${clash.jobReference}, ${clash.suburb ?? ""}` : "";
        why = `Busy ${formatTimeRangeLabel(input.zone, clash.startTime, clash.endTime)}${where}`;
      }
    }

    const row: CandidateRow = {
      code: contractor.code,
      name: contractor.name,
      ready: guarded.ready,
      pickable: guarded.ready && why === null,
      why,
      served: contractor.servedPostcodes.some((p) => p.postcode === input.job.postcode),
      distanceKm: distances.has(contractor.id) ? Math.round(distances.get(contractor.id)! * 10) / 10 : null,
      pay: { calloutRate: specialty.contractorCalloutRate, standardRate: specialty.contractorStandardRate },
      rating: ratingOf(contractor),
    };
    (row.served ? serves : outside).push(row);
  }

  serves.sort(sortRows);
  outside.sort(sortRows);
  return { serves, outside };
}

/** One row, for the dispatch endpoint's own re-check of the contractor Mike actually picked. */
export async function loadOneCandidate(
  client: PrismaClient,
  contractorCode: string,
  input: CandidatesInput,
): Promise<CandidateRow | null> {
  const { serves, outside } = await loadCandidates(client, input);
  return [...serves, ...outside].find((row) => row.code === contractorCode) ?? null;
}
