// Pay adjustments -- Feature 6007, correct & reissue and pay adjustments.
//
// Contractor Settlement / Pay adjustments and corrections. Mike adds a one-off amount to a
// contractor's pay (add only): an amount above 0, a required reason, and the job when there is one.
// WHERE IT LANDS is one rule, shared with a correction (`landFor`): the contractor has an unapproved
// draft -> it is rebuilt through the sweep with the new line and resent; otherwise it waits for the
// next run (an approved draft is never touched, and neither is a paid one).
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { currentLabel } from "../test-data/label.js";
import { dayLabel, nextRunMonday, payDayFor, ymdOf } from "./calendar.js";
import { askDraftEmail } from "./messages.js";
import { sweepContractor } from "./sweep.js";

type Db = Prisma.TransactionClient;

export const ADJUSTMENT_REASON_MAX = 500;

export type Landing = "draft" | "approved" | "next_run";

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

/**
 * A browser test's request (its cookie carries the e2e label) only ever meets drafts of its own label: it
 * never rebuilds, or reports, a draft that belongs to the owner's hand check or to a real contractor.
 */
function ownDrafts(): { testData?: string } {
  const label = currentLabel();
  return label === null ? {} : { testData: label };
}

/** Where a new line for this contractor lands, and the muted sentence the dialog shows. */
export async function landingOf(db: Db | PrismaClient, contractorId: string, now: Date): Promise<{ landing: Landing; sentence: string }> {
  const settings = await db.platformSettings.findFirstOrThrow();
  const contractor = await db.contractor.findUniqueOrThrow({ where: { id: contractorId }, select: { name: true } });
  const name = firstNameOf(contractor.name);
  const draft = await db.contractorSettlement.findFirst({ where: { contractorId, status: "draft", ...ownDrafts() }, select: { id: true } });
  if (draft !== null) {
    return {
      landing: "draft",
      sentence: `Goes on ${possessive(name)} draft for ${dayLabel(payDayFor(settings, now), now)} - their draft is resent to approve.`,
    };
  }
  const approved = await db.contractorSettlement.findFirst({
    where: { contractorId, status: "approved", ...ownDrafts() },
    select: { id: true },
  });
  if (approved !== null) {
    return { landing: "approved", sentence: `${name} has approved this week - it goes on next week's draft.` };
  }
  return {
    landing: "next_run",
    sentence: `Goes on ${possessive(name)} next payout - invoiced ${dayLabel(nextRunMonday(settings, now), now)}.`,
  };
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/**
 * After a line is written (an adjustment, or a correction on an approved or paid week): when the
 * contractor has an unapproved draft, rebuild it through the sweep so it carries the line. Returns
 * the new draft when one was made, so the caller asks its email after the commit.
 */
export async function rebuildDraftIfAny(
  tx: Db,
  contractorId: string,
  userId: string,
  now: Date,
): Promise<{ id: string; reference: string; testData: string | null } | null> {
  await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${contractorId} FOR UPDATE`;
  const label = currentLabel();
  const draft = await tx.contractorSettlement.findFirst({ where: { contractorId, status: "draft", ...ownDrafts() } });
  if (draft === null) return null;
  const swept = await sweepContractor(tx, contractorId, {
    periodEnd: ymdOf(draft.periodEnd),
    now,
    supersededByUserId: userId,
    ...(label === null ? {} : { onlyLabel: label }),
  });
  return swept === null ? null : { id: swept.id, reference: swept.reference, testData: swept.testData };
}

export type AdjustmentOutcome =
  | { ok: true; contractorFirstName: string; landing: Landing; draft: { id: string; reference: string; testData: string | null } | null }
  | { ok: false; status: number; error: string; field?: string };

export interface AdjustmentInput {
  contractorId: unknown;
  amount: unknown;
  reason: unknown;
  jobReference: unknown;
}

export async function addPayAdjustment(client: PrismaClient, input: AdjustmentInput, userId: string, now: Date): Promise<AdjustmentOutcome> {
  if (typeof input.contractorId !== "string" || input.contractorId === "") {
    return { ok: false, status: 400, error: "Required.", field: "contractor" };
  }
  if (typeof input.amount !== "number" || !Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, status: 400, error: "Enter an amount more than $0.", field: "amount" };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason === "") return { ok: false, status: 400, error: "Required.", field: "reason" };
  if (reason.length > ADJUSTMENT_REASON_MAX) {
    return { ok: false, status: 400, error: `At most ${String(ADJUSTMENT_REASON_MAX)} characters.`, field: "reason" };
  }
  const contractor = await client.contractor.findUnique({ where: { id: input.contractorId }, select: { id: true, name: true } });
  if (contractor === null) return { ok: false, status: 400, error: "Pick a contractor.", field: "contractor" };
  let jobId: string | null = null;
  const jobText = typeof input.jobReference === "string" ? input.jobReference.trim() : "";
  if (jobText !== "") {
    const job = await client.job.findUnique({ where: { reference: jobText.toUpperCase() }, select: { id: true } });
    if (job === null) return { ok: false, status: 400, error: "No job with that number.", field: "job" };
    jobId = job.id;
  }
  const amount = input.amount;
  const result = await client.$transaction(async (tx) => {
    const { landing } = await landingOf(tx, contractor.id, now);
    await tx.contractorPayAdjustment.create({
      data: { contractorId: contractor.id, amount, kind: "adjustment", reason, jobId, createdByUserId: userId, createdAt: now },
    });
    const draft = landing === "draft" ? await rebuildDraftIfAny(tx, contractor.id, userId, now) : null;
    return { landing, draft };
  });
  return { ok: true, contractorFirstName: firstNameOf(contractor.name), landing: result.landing, draft: result.draft };
}

/** After the commit: the rebuilt draft's email. A message that cannot be asked is logged, never turned into a failure. */
export async function askRebuiltDraft(client: PrismaClient, draft: { id: string; reference: string; testData: string | null } | null, now: Date): Promise<void> {
  if (draft === null) return;
  try {
    await askDraftEmail(client, draft, now);
  } catch (error: unknown) {
    console.error(`settlements: ${draft.reference} was rebuilt but its email could not be asked`, error);
  }
}
