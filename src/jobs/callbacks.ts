// Callbacks -- Feature 6004, callbacks and no-shows.
//
// Callbacks (design): when a customer needs someone back after a finished job, Mike raises a
// callback from the completed job. It is a new job linked to the first one (Job.parentJobId,
// always the ROOT original, never another callback), dispatched and run like any job. Nothing is
// sent when it is raised. Also here: the read-only view of the original that the attending
// contractor opens from his callback.
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { nextReference } from "../db/reference.js";
import { dateOnlyAsUtcMidnight, formatDate, todayIn } from "../time/index.js";

export type Failure = { ok: false; status: number; error: string; field?: string };

export const MAX_CALLBACK_DESCRIPTION = 2000;

class Refused extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error);
  }
}

export function parseCallbackInput(body: unknown): { ok: true; description: string } | Failure {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const value = raw["description"];
  if (value !== undefined && typeof value !== "string") {
    return { ok: false, status: 400, error: "description must be text", field: "description" };
  }
  const description = (value ?? "").trim();
  if (description === "") return { ok: false, status: 400, error: "Required.", field: "description" };
  if (description.length > MAX_CALLBACK_DESCRIPTION) {
    return {
      ok: false,
      status: 400,
      error: `A description is at most ${String(MAX_CALLBACK_DESCRIPTION)} characters.`,
      field: "description",
    };
  }
  return { ok: true, description };
}

export interface RaiseSuccess {
  ok: true;
  jobReference: string;
}

/** Raise a callback on a completed job. One transaction; sends nothing. */
export async function raiseCallback(
  client: PrismaClient,
  reference: string,
  description: string,
  now: Date = new Date(),
): Promise<RaiseSuccess | Failure> {
  try {
    const created = await client.$transaction(async (tx) => {
      const found = await tx.job.findUnique({ where: { reference }, select: { id: true } });
      if (found === null) throw new Refused({ ok: false, status: 404, error: "not found" });
      await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${found.id} FOR UPDATE`;
      const job = await tx.job.findUniqueOrThrow({ where: { id: found.id }, include: { serviceType: true } });
      if (job.status !== "completed") {
        throw new Refused({ ok: false, status: 409, error: `The job is ${job.status} -- a callback is raised on a completed job.` });
      }
      const settings = await tx.platformSettings.findFirstOrThrow({ select: { timezone: true } });
      return tx.job.create({
        data: {
          reference: await nextReference("JOB", tx),
          parentJobId: job.parentJobId ?? job.id,
          customerId: job.customerId,
          serviceTypeId: job.serviceTypeId,
          // A new job, so Tier 1 again: the trade's live rate card, not the first job's snapshot.
          customerCalloutRate: job.serviceType.customerCalloutRate,
          customerStandardRate: job.serviceType.customerStandardRate,
          postcode: job.postcode,
          serviceLocation: job.serviceLocation as Prisma.InputJsonValue,
          siteAddress: job.siteAddress === null ? Prisma.DbNull : (job.siteAddress as Prisma.InputJsonValue),
          siteContact: job.siteContact === null ? Prisma.DbNull : (job.siteContact as Prisma.InputJsonValue),
          timezone: job.timezone,
          description,
          source: "phone",
          preferredWindow: job.preferredWindow,
          preferredDate: dateOnlyAsUtcMidnight(todayIn(settings.timezone, now)),
          status: "new",
        },
        select: { reference: true },
      });
    });
    return { ok: true, jobReference: created.reference };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

/** Mike's page: the root's reference (or null) and each callback's reference, oldest first. */
export async function callbackLinksOf(
  client: PrismaClient,
  job: { id: string; parentJobId: string | null },
): Promise<{ callbackOn: string | null; callbacks: string[] }> {
  const root =
    job.parentJobId === null ? null : await client.job.findUnique({ where: { id: job.parentJobId }, select: { reference: true } });
  const callbacks = await client.job.findMany({
    where: { parentJobId: job.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { reference: true },
  });
  return { callbackOn: root?.reference ?? null, callbacks: callbacks.map((row) => row.reference) };
}

export interface EarlierJobNotes {
  kind: "original" | "callback";
  reference: string;
  description: string;
  /** The day its completed visit was finished, on the business clock. */
  finished: string;
  workSummary: string;
  parts: { name: string; description: string; qty: number }[];
}

/**
 * What the contractor attending a callback may see of the work before it: the original, then each
 * earlier callback on that original that was completed, oldest first. Its words, when it was
 * finished, what was done and the parts -- never prices, time on site, who did it or the customer.
 * Empty unless the job is a callback and HIS booking on it is open (accepted or in progress).
 */
export async function earlierNotesOf(
  client: PrismaClient,
  job: { id: string; parentJobId: string | null; createdAt: Date },
  bookingOpen: boolean,
): Promise<EarlierJobNotes[]> {
  if (job.parentJobId === null || !bookingOpen) return [];
  const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true } });
  const earlier = await client.job.findMany({
    where: {
      status: "completed",
      OR: [{ id: job.parentJobId }, { parentJobId: job.parentJobId, id: { not: job.id }, createdAt: { lt: job.createdAt } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, reference: true, description: true, parentJobId: true },
  });
  const notes: EarlierJobNotes[] = [];
  for (const row of earlier) {
    const visit = await client.assignment.findFirst({
      where: { jobId: row.id, status: "completed" },
      orderBy: { completedAt: "desc" },
      include: { parts: { orderBy: { id: "asc" } } },
    });
    notes.push({
      kind: row.parentJobId === null ? "original" : "callback",
      reference: row.reference,
      description: row.description ?? "",
      finished: visit?.completedAt == null ? "" : formatDate(settings.timezone, visit.completedAt),
      workSummary: visit?.completionNotes ?? "",
      parts: (visit?.parts ?? []).map((part) => ({
        name: part.name,
        description: part.description ?? "",
        qty: Number(part.qty),
      })),
    });
  }
  return notes;
}
