// The respond page's engine -- Feature 4003, accept / decline.
//
// Contractor Workflow steps 5 and 6; Identity & Access / Passwordless
// capability links (the `/a/<token>` row, A dead link explains itself).
//
//   readRespond     the page's read -- open, or the reason it is dead
//   acceptAssignment / declineAssignment
//                   one transaction per answer (plan decision 2): the
//                   assignment, the job, the block and every respond token
//                   on the assignment move together or not at all. The
//                   messages are asked AFTER commit by the caller, so a
//                   rolled-back answer sends nothing.
//
// The token is the permission (ADR 0004): no session, no role. Opening the
// page burns nothing; an ANSWER burns every respond token on the assignment
// -- usedAt stamped, never deleted (plan decision 3, BKLG-027) -- so the
// other link can still say "Already answered".
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  burnByAssignment,
  CapabilityTokenType,
  findCapabilityToken,
} from "../capability-tokens/index.js";
import { formatDateLabel, formatDateTimeLabel, formatSlotLabel } from "../time/index.js";
import { customerPhotosOf, type PhotoView } from "../photos/cloudinary.js";
import { answersOf } from "../jobs/detail.js";
import { readNotes } from "../jobs/notes.js";
import { asSiteContact } from "../jobs/site-contact.js";
import { effectiveAddress, suburbOf } from "../jobs/shared.js";

type Db = Prisma.TransactionClient;

/** Plan decision 11: the decline note, at most this many characters. */
export const MAX_DECLINE_NOTE = 500;

// ---------------------------------------------------------------------------
// What the page is told
// ---------------------------------------------------------------------------

export interface RespondOpen {
  state: "open";
  jobReference: string;
  /** "Bob" -- the page greets him ("New job for you, Bob"). */
  contractorFirstName: string;
  trade: string;
  /** "Thu 08/10, 8:00am AWST" -- the job's zone, labelled. */
  slotLabel: string;
  addressLine: string;
  /** "Lena Park" -- the name only, never a phone (V3), or the customer's name when the job has no site contact. */
  contactLine: string;
  contactIsSiteContact: boolean;
  /** "Sarah" -- the screen after Accept says who has been told. */
  customerFirstName: string;
  description: string | null;
  answers: string[];
  /** Feature 3003: the customer's enquiry photos, oldest first. */
  photos: PhotoView[];
  /** The office's Instruction notes only (plan decision 12), newest first. */
  instructions: { authorFirstName: string; dateLabel: string; note: string }[];
}

/** One dead-link state (plan decision 4); each carries the office number the page's fix button may ring. */
export type RespondDead =
  | {
      state: "answered";
      answer: "accepted" | "declined";
      answeredAtLabel: string;
      jobReference: string;
      officePhone: string;
    }
  | { state: "expired"; jobReference: string; officePhone: string }
  | { state: "unknown"; officePhone: string };

export type RespondRead = RespondOpen | RespondDead;

/** What a dead link answers with: 404 for a link that does not exist, 410 Gone for one that has died. */
export function statusOfDead(dead: RespondDead): number {
  return dead.state === "unknown" ? 404 : 410;
}

// ---------------------------------------------------------------------------
// Reading the link
// ---------------------------------------------------------------------------

export const assignmentInclude = {
  contractor: { select: { id: true, name: true, code: true } },
  job: {
    include: {
      serviceType: { select: { trade: true, serviceLevelMultipliers: true } },
      customer: { select: { id: true, name: true, billingAddress: true } },
    },
  },
} satisfies Prisma.AssignmentInclude;

export type LoadedAssignment = Prisma.AssignmentGetPayload<{ include: typeof assignmentInclude }>;

type Inspected =
  | { kind: "open"; tokenId: string; assignment: LoadedAssignment }
  | { kind: "dead"; dead: RespondDead };

async function officePhoneOf(db: Db): Promise<string> {
  const settings = await db.platformSettings.findFirst({ select: { operatorPhone: true } });
  return settings?.operatorPhone ?? "";
}

/**
 * Decision 4: dead-link reasons read from the token. usedAt set -> answered
 * (naming what he answered and when, read from the assignment); expiresAt
 * passed -> expired; no row, or the wrong type -> doesn't work.
 */
export async function inspectToken(db: Db, rawToken: string, now: Date): Promise<Inspected> {
  const unknown = async (): Promise<Inspected> => ({
    kind: "dead",
    dead: { state: "unknown", officePhone: await officePhoneOf(db) },
  });

  const token = await findCapabilityToken(db, rawToken);
  if (token === null || token.type !== CapabilityTokenType.respond || token.assignmentId === null) {
    return unknown();
  }
  const assignment = await db.assignment.findUnique({
    where: { id: token.assignmentId },
    include: assignmentInclude,
  });
  if (assignment === null) return unknown();

  const officePhone = await officePhoneOf(db);
  const job = assignment.job;

  if (token.usedAt !== null) {
    if (assignment.status === "declined" && assignment.declinedAt !== null) {
      return {
        kind: "dead",
        dead: {
          state: "answered",
          answer: "declined",
          answeredAtLabel: formatDateTimeLabel(job.timezone, assignment.declinedAt, now),
          jobReference: job.reference,
          officePhone,
        },
      };
    }
    if (assignment.acceptedAt !== null) {
      return {
        kind: "dead",
        dead: {
          state: "answered",
          answer: "accepted",
          answeredAtLabel: formatDateTimeLabel(job.timezone, assignment.acceptedAt, now),
          jobReference: job.reference,
          officePhone,
        },
      };
    }
    return unknown();
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { kind: "dead", dead: { state: "expired", jobReference: job.reference, officePhone } };
  }
  // A live token on an assignment that is no longer waiting for an answer
  // (4006's reassign and cancel delete the token; this is the belt to that
  // braces) is never answerable.
  if (assignment.status !== "assigned") return unknown();

  return { kind: "open", tokenId: token.id, assignment };
}

/** What the contractor is shown of the job itself -- the respond page and the job screen (Feature 5001) read it from here. */
export interface JobFacts {
  trade: string;
  addressLine: string;
  /** "Lena Park" -- the name only, never a phone (V3), or the customer's name when the job has no site contact. */
  contactLine: string;
  contactIsSiteContact: boolean;
  customerFirstName: string;
  description: string | null;
  answers: string[];
  /** Feature 3003: the customer's enquiry photos, oldest first. */
  photos: PhotoView[];
  /** The office's Instruction notes only (plan decision 12), newest first. */
  instructions: { authorFirstName: string; dateLabel: string; note: string }[];
}

export async function jobFactsOf(db: Db, job: LoadedAssignment["job"]): Promise<JobFacts> {
  const zone = job.timezone;
  const address = effectiveAddress(job);
  const siteContact = asSiteContact(job.siteContact);

  const instructionNotes = readNotes(job.operatorNotes).filter((note) => note.type === "instruction");
  const authorIds = [...new Set(instructionNotes.map((note) => note.operatorId))];
  const authors = await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
  const firstNameOf = (id: string): string => {
    const name = authors.find((author) => author.id === id)?.name ?? "The office";
    return name.split(" ")[0] ?? name;
  };

  return {
    trade: job.serviceType.trade,
    addressLine: address === null ? suburbOf(job.serviceLocation) : `${address.street}, ${address.suburb}`,
    contactLine: siteContact?.name ?? job.customer.name,
    contactIsSiteContact: siteContact !== null,
    customerFirstName: job.customer.name.split(" ")[0] ?? job.customer.name,
    description: job.description,
    answers: answersOf(job.selectedOptions),
    photos: await customerPhotosOf(db, job.id),
    instructions: [...instructionNotes]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .map((note) => ({
        authorFirstName: firstNameOf(note.operatorId),
        dateLabel: formatDateLabel(zone, new Date(note.at)),
        note: note.note,
      })),
  };
}

async function openView(db: Db, assignment: LoadedAssignment, now: Date): Promise<RespondOpen> {
  const job = assignment.job;
  const slot = assignment.proposedSlot;
  return {
    state: "open",
    jobReference: job.reference,
    contractorFirstName: assignment.contractor.name.split(" ")[0] ?? assignment.contractor.name,
    slotLabel: slot === null ? "" : formatSlotLabel(job.timezone, slot, now),
    ...(await jobFactsOf(db, job)),
  };
}

export async function readRespond(client: PrismaClient, rawToken: string, now: Date = new Date()): Promise<RespondRead> {
  const inspected = await inspectToken(client, rawToken, now);
  if (inspected.kind === "dead") return inspected.dead;
  return openView(client, inspected.assignment, now);
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** Everything the after-commit messages need, read inside the answer's own transaction. */
export interface AnswerFacts {
  assignmentId: string;
  jobId: string;
  jobReference: string;
  jobTimezone: string;
  trade: string;
  contractorName: string;
  contractorCode: string;
  proposedSlot: Date;
  slotLabel: string;
  /** Decline only: the trimmed note, null when none. */
  note: string | null;
}

export type AnswerResult =
  | { ok: true; facts: AnswerFacts }
  | { ok: false; status: number; body: RespondDead | { error: string; field: string } };

class Refused extends Error {
  constructor(readonly refusal: Extract<AnswerResult, { ok: false }>) {
    super("refused");
  }
}

function refusedDead(dead: RespondDead): Refused {
  return new Refused({ ok: false, status: statusOfDead(dead), body: dead });
}

/**
 * The shared spine of both answers: find the assignment behind the link,
 * lock the job then the assignment (the job first, as dispatch does), look
 * at the link again UNDER the lock -- so two taps at once, or two links
 * answered at once, meet the same truth -- and hand back the open assignment.
 */
async function lockAndInspect(tx: Db, rawToken: string, now: Date): Promise<LoadedAssignment> {
  const first = await inspectToken(tx, rawToken, now);
  if (first.kind === "dead") throw refusedDead(first.dead);

  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${first.assignment.jobId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${first.assignment.id} FOR UPDATE`;

  const locked = await inspectToken(tx, rawToken, now);
  if (locked.kind === "dead") throw refusedDead(locked.dead);
  return locked.assignment;
}

function factsOf(assignment: LoadedAssignment, note: string | null, now: Date): AnswerFacts {
  const slot = assignment.proposedSlot ?? now;
  return {
    assignmentId: assignment.id,
    jobId: assignment.jobId,
    jobReference: assignment.job.reference,
    jobTimezone: assignment.job.timezone,
    trade: assignment.job.serviceType.trade,
    contractorName: assignment.contractor.name,
    contractorCode: assignment.contractor.code,
    proposedSlot: slot,
    slotLabel: formatSlotLabel(assignment.job.timezone, slot, now),
    note,
  };
}

export async function acceptAssignment(client: PrismaClient, rawToken: string, now: Date = new Date()): Promise<AnswerResult> {
  try {
    const facts = await client.$transaction(async (tx) => {
      const assignment = await lockAndInspect(tx, rawToken, now);
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { status: "accepted", acceptedAt: now, confirmedSlot: assignment.proposedSlot },
      });
      await tx.job.update({ where: { id: assignment.jobId }, data: { status: "scheduled" } });
      // The block stays, on the same assignment: its state is read from the
      // assignment's status (hold -> booked), never a field of its own.
      await burnByAssignment(tx, assignment.id, [CapabilityTokenType.respond], now);
      return factsOf(assignment, null, now);
    });
    return { ok: true, facts };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/** Plan decision 11: plain text, trimmed, at most 500 characters; empty is no note. */
export function parseDeclineNote(body: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["note"] : undefined;
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, error: "note must be text" };
  const note = raw.trim();
  if (note.length > MAX_DECLINE_NOTE) {
    return { ok: false, error: `A note is at most ${String(MAX_DECLINE_NOTE)} characters.` };
  }
  return { ok: true, note: note === "" ? null : note };
}

export async function declineAssignment(
  client: PrismaClient,
  rawToken: string,
  note: string | null,
  now: Date = new Date(),
): Promise<AnswerResult> {
  try {
    const facts = await client.$transaction(async (tx) => {
      const assignment = await lockAndInspect(tx, rawToken, now);
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { status: "declined", declinedAt: now, declineNote: note },
      });
      // The same job, back to new (Job Lifecycle & Statuses); its block frees the slot.
      await tx.job.update({ where: { id: assignment.jobId }, data: { status: "new" } });
      await tx.calendarEvent.deleteMany({ where: { assignmentId: assignment.id } });
      await burnByAssignment(tx, assignment.id, [CapabilityTokenType.respond], now);
      return factsOf(assignment, note, now);
    });
    return { ok: true, facts };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}
