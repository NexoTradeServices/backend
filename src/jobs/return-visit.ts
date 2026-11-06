// Return visits and putting a job on hold -- Feature 5002.
//
// Contractor Workflow; Calendar & Scheduling; Ops job actions (see Job Lifecycle & Statuses). A job that cannot be
// finished in one visit either gets a SECOND block on the same visit (a return booked now) or is put ON HOLD for the
// office (Not yet). One path for both people: Bob from his job screen, Mike from the job page. The In functions run inside
// a transaction the caller holds (Bob's route saves his times, notes and parts in the same one); the messages are asked
// after the commit, so a refused booking sends nothing.
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ReturnReasonKind } from "../generated/prisma/enums.js";
import { applyChangesIn, notAvailableIn, switchOnChanges } from "../availability/index.js";
import { slotRefusal } from "../calendar/rules.js";
import { sendSlotConfirmed } from "../respond/messages.js";
import type { AnswerFacts } from "../respond/service.js";
import { formatSlotLabel } from "../time/index.js";
import { Refused, type Failure } from "./visit.js";
import { slotInstants, type SlotInput } from "./dispatch.js";
import { askJobUpdateForHold } from "./changes.js";

type Tx = Prisma.TransactionClient;

export type Actor = { kind: "contractor" | "ops"; userId: string };

export interface ReasonInput {
  reason: ReturnReasonKind;
  /** Required with "other". */
  otherText: string | null;
  /** Bob's note to the office on Not yet; optional. */
  officeNote: string | null;
}

const MAX_NOTE = 500;

function fail(status: number, error: string, field: string): Failure {
  return { ok: false, status, error, field };
}

/** The Reason from a request body: one of the three, and a text for Other. */
export function parseReason(body: Record<string, unknown>): { ok: true; data: ReasonInput } | Failure {
  const reason = body["reason"];
  if (reason !== "part_on_order" && reason !== "more_time_needed" && reason !== "other") return fail(400, "Required.", "reason");
  const text = (key: string, label: string): { ok: true; value: string | null } | Failure => {
    const raw = body[key];
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== "string") return fail(400, `${label} must be text`, key);
    const trimmed = raw.trim();
    if (trimmed.length > MAX_NOTE) return fail(400, `At most ${String(MAX_NOTE)} characters.`, key);
    return { ok: true, value: trimmed === "" ? null : trimmed };
  };
  const other = text("otherText", "Other");
  if (!other.ok) return other;
  const office = text("officeNote", "The note");
  if (!office.ok) return office;
  if (reason === "other" && other.value === null) return fail(400, "Required.", "otherText");
  return { ok: true, data: { reason, otherText: reason === "other" ? other.value : null, officeNote: office.value } };
}

export interface BookedReturn {
  jobId: string;
  assignmentId: string;
  contractorId: string;
  facts: AnswerFacts;
  blockId: string;
  /** "Thu 5 Nov at 2:00pm", the success banner's words. */
  bannerLabel: string;
}

/**
 * Book the second block. `assignment` has already been locked by the caller (job first, then assignment). Throws Refused
 * to roll the whole transaction back.
 */
export async function bookReturnIn(
  tx: Tx,
  input: { jobId: string; assignmentId: string; actor: Actor; reason: ReasonInput | null; slot: SlotInput; now: Date },
): Promise<BookedReturn> {
  const { actor, slot, now } = input;
  const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
  const assignment = await tx.assignment.findUniqueOrThrow({
    where: { id: input.assignmentId },
    include: { contractor: { include: { specialties: true } }, specialty: true },
  });
  if (!(job.status === "scheduled" || job.status === "in_progress" || (job.status === "on_hold" && actor.kind === "ops"))) {
    throw new Refused(fail(409, `The job is ${job.status} -- a return visit cannot be booked.`, "status"));
  }
  if (assignment.status !== "accepted" && assignment.status !== "in_progress") {
    throw new Refused(fail(409, "This job is not open for work.", "status"));
  }

  const { start, end } = slotInstants(job.timezone, slot);
  if (start.getTime() < now.getTime()) throw new Refused(fail(400, "A slot in the past cannot be booked.", "startMinutes"));

  // Holiday on the job's state, or outside opening hours: refused, an emergency included.
  const refusal = await slotRefusal(tx, job, slot);
  if (refusal !== null) throw new Refused(fail(400, refusal, "startMinutes"));

  // The contractor's row, locked: two bookings can never take one hour.
  await tx.$queryRaw`SELECT id FROM "Contractor" WHERE id = ${assignment.contractorId} FOR UPDATE`;
  const contractor = assignment.contractor;
  const own = actor.kind === "contractor";

  // Licence and insurance must run past the new date.
  const onDate = new Date(`${slot.date}T00:00:00.000Z`);
  if (
    assignment.specialty.licenceExpiry.getTime() <= onDate.getTime() ||
    (contractor.insuranceExpiry !== null && contractor.insuranceExpiry.getTime() <= onDate.getTime())
  ) {
    throw new Refused(
      fail(
        409,
        own
          ? "Your licence or insurance runs out before that date. Ring the office."
          : `${contractor.name.split(" ")[0] ?? contractor.name}'s licence or insurance runs out before that date.`,
        "startMinutes",
      ),
    );
  }

  const clash = await tx.calendarEvent.findFirst({
    where: { contractorId: contractor.id, startTime: { lt: end }, endTime: { gt: start } },
    include: { job: { select: { reference: true } } },
  });
  if (clash) {
    throw new Refused(fail(409, `That time clashes with ${clash.job?.reference ?? "another booking"}. Pick another time.`, "startMinutes"));
  }

  // Time switched off in Availability: the contractor may book their own and it becomes available, under their name;
  // Mike may not (the same refusal dispatch gives).
  const switchedOff = await notAvailableIn(tx, [contractor], { start, end });
  if (switchedOff.get(contractor.id)?.notAvailable === true) {
    if (!own) {
      throw new Refused(fail(409, "Not available at that time - pick another slot or another contractor.", "startMinutes"));
    }
    await applyChangesIn(tx, contractor.id, await switchOnChanges(tx, contractor, { start, end }), actor.userId, now);
  }

  if (input.reason !== null) {
    await tx.returnReason.create({
      data: {
        jobId: job.id,
        assignmentId: assignment.id,
        reason: input.reason.reason,
        otherText: input.reason.otherText,
        officeNote: null,
        byUserId: actor.userId,
        at: now,
      },
    });
  }
  const block = await tx.calendarEvent.create({
    data: { contractorId: contractor.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: start, endTime: end },
  });
  await tx.assignment.update({ where: { id: assignment.id }, data: { status: "accepted", confirmedSlot: start } });
  await tx.job.update({ where: { id: job.id }, data: { status: "scheduled" } });

  const trade = assignment.specialty.trade;
  return {
    jobId: job.id,
    assignmentId: assignment.id,
    contractorId: contractor.id,
    blockId: block.id,
    bannerLabel: formatSlotLabel(job.timezone, start, now).replace(/, /, " at "),
    facts: {
      assignmentId: assignment.id,
      jobId: job.id,
      jobReference: job.reference,
      jobTimezone: job.timezone,
      trade,
      contractorName: contractor.name,
      contractorCode: contractor.code,
      proposedSlot: start,
      slotLabel: formatSlotLabel(job.timezone, start, now),
      note: null,
      calendarEventId: block.id,
    },
  };
}

export interface HeldJob {
  jobId: string;
  assignmentId: string;
  /** The start of the future block that came off, when there was one: the customer is told. */
  removedSlot: Date | null;
}

/** Put the job on hold: the Reason is written, a future block comes off, the booking goes back to accepted. */
export async function putOnHoldIn(
  tx: Tx,
  input: { jobId: string; assignmentId: string; actor: Actor; reason: ReasonInput; now: Date },
): Promise<HeldJob> {
  const { actor, now } = input;
  const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId } });
  const assignment = await tx.assignment.findUniqueOrThrow({ where: { id: input.assignmentId } });
  if (job.status !== "scheduled" && job.status !== "in_progress") {
    throw new Refused(fail(409, `The job is ${job.status} -- it cannot be put on hold.`, "status"));
  }
  if (assignment.status !== "accepted" && assignment.status !== "in_progress") {
    throw new Refused(fail(409, "This job is not open for work.", "status"));
  }
  await tx.returnReason.create({
    data: {
      jobId: job.id,
      assignmentId: assignment.id,
      reason: input.reason.reason,
      otherText: input.reason.otherText,
      officeNote: input.reason.officeNote,
      byUserId: actor.userId,
      at: now,
    },
  });
  const future = await tx.calendarEvent.findMany({
    where: { assignmentId: assignment.id, startTime: { gt: now } },
    orderBy: { startTime: "asc" },
  });
  if (future.length > 0) await tx.calendarEvent.deleteMany({ where: { id: { in: future.map((block) => block.id) } } });
  await tx.assignment.update({ where: { id: assignment.id }, data: { status: "accepted" } });
  await tx.job.update({ where: { id: job.id }, data: { status: "on_hold" } });
  return { jobId: job.id, assignmentId: assignment.id, removedSlot: future[0]?.startTime ?? null };
}

/** After the commit: the customer is told the new time (email and text), the site contact too. */
export async function sendReturnBooked(client: PrismaClient, booked: BookedReturn, now: Date = new Date()): Promise<void> {
  await sendSlotConfirmed(client, booked.facts, now);
}

/** After the commit: when a booked time came off, the customer and the site contact get the existing Job update. */
export async function sendHeldUpdate(client: PrismaClient, held: HeldJob, now: Date = new Date()): Promise<void> {
  if (held.removedSlot === null) return;
  await askJobUpdateForHold(client, held.jobId, held.assignmentId, held.removedSlot, now, `hold:${String(now.getTime())}`);
}

// ---------------------------------------------------------------------------
// Mike's two doors
// ---------------------------------------------------------------------------

type Outcome<T> = ({ ok: true } & T) | Failure;

async function lockedBooking(tx: Tx, reference: string) {
  const found = await tx.job.findUnique({ where: { reference }, select: { id: true } });
  if (found === null) throw new Refused(fail(404, "not found", "reference"));
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${found.id} FOR UPDATE`;
  const assignment = await tx.assignment.findFirst({
    where: { jobId: found.id, status: { in: ["accepted", "in_progress"] } },
    orderBy: { dispatchedAt: "desc" },
  });
  if (assignment === null) throw new Refused(fail(409, "The job has no open booking.", "status"));
  await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${assignment.id} FOR UPDATE`;
  return { jobId: found.id, assignmentId: assignment.id };
}

export async function holdJobByOps(
  client: PrismaClient,
  reference: string,
  userId: string,
  reason: ReasonInput,
  now: Date = new Date(),
): Promise<Outcome<{ jobReference: string }>> {
  try {
    const held = await client.$transaction(async (tx) => {
      const ids = await lockedBooking(tx, reference);
      return putOnHoldIn(tx, { ...ids, actor: { kind: "ops", userId }, reason, now });
    });
    await sendHeldUpdate(client, held, now);
    return { ok: true, jobReference: reference };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

export async function bookReturnByOps(
  client: PrismaClient,
  reference: string,
  userId: string,
  slot: SlotInput,
  now: Date = new Date(),
): Promise<Outcome<{ jobReference: string; bannerLabel: string; contractorFirstName: string }>> {
  try {
    const booked = await client.$transaction(async (tx) => {
      const ids = await lockedBooking(tx, reference);
      return bookReturnIn(tx, { ...ids, actor: { kind: "ops", userId }, reason: null, slot, now });
    });
    await sendReturnBooked(client, booked, now);
    return {
      ok: true,
      jobReference: reference,
      bannerLabel: booked.bannerLabel,
      contractorFirstName: booked.facts.contractorName.split(" ")[0] ?? booked.facts.contractorName,
    };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}
