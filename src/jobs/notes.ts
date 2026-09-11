// Operator notes -- Feature 4001, ops job queue and job detail.
//
// Operations Admin Workflow / The job queue and the job page: "Operator
// notes are a log." Plan decision 8: they stay in Job.operatorNotes (JSON,
// no migration); each new note gets an id; `at` and `operatorId` come from
// the server clock and the session, never the request; the 10-minute window
// is measured here from `at`; only the author may edit; `editedAt` is
// stamped only when the text actually changes; no note is ever deleted.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";

/** The four a person may pick. `correction` is written only by Correct & reissue. */
export const HAND_NOTE_TYPES = ["general", "instruction", "complaint", "dispute"] as const;
export type HandNoteType = (typeof HAND_NOTE_TYPES)[number];

export const NOTE_EDIT_WINDOW_MS = 10 * 60_000;
const MAX_NOTE_LENGTH = 2000;

export interface StoredNote {
  /** Absent only on a note written before 4001 gave notes an id. */
  id?: string;
  at: string;
  operatorId: string;
  type: string;
  note: string;
  assignmentId?: string;
  editedAt?: string;
}

export function readNotes(value: unknown): StoredNote[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredNote =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)["at"] === "string" &&
      typeof (entry as Record<string, unknown>)["note"] === "string",
  );
}

/** Seconds left in the author's 10-minute window, for this viewer; 0 = no Edit. */
export function editableForSeconds(note: StoredNote, viewerId: string, now: Date): number {
  if (note.id === undefined || note.operatorId !== viewerId) return 0;
  const left = new Date(note.at).getTime() + NOTE_EDIT_WINDOW_MS - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export type NoteFailure = { ok: false; status: number; error: string; field?: string };

function parseText(value: unknown): { ok: true; text: string } | NoteFailure {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return { ok: false, status: 400, error: "Required.", field: "note" };
  if (text.length > MAX_NOTE_LENGTH) {
    return { ok: false, status: 400, error: `A note is at most ${String(MAX_NOTE_LENGTH)} characters.`, field: "note" };
  }
  return { ok: true, text };
}

export function parseNewNote(body: unknown): { ok: true; type: HandNoteType; text: string } | NoteFailure {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const type = b["type"];
  if (typeof type !== "string" || !HAND_NOTE_TYPES.includes(type as HandNoteType)) {
    return { ok: false, status: 400, error: `type must be one of ${HAND_NOTE_TYPES.join(", ")}`, field: "type" };
  }
  const text = parseText(b["note"]);
  if (!text.ok) return text;
  return { ok: true, type: type as HandNoteType, text: text.text };
}

export function parseEditedNote(body: unknown): { ok: true; text: string } | NoteFailure {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return parseText(b["note"]);
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Read-modify-write of one JSON column: the row is locked so two saves never lose a note. */
async function lockedNotes(tx: Tx, jobId: string): Promise<StoredNote[]> {
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, select: { operatorNotes: true } });
  return readNotes(job.operatorNotes);
}

function toJson(notes: StoredNote[]): Prisma.InputJsonValue {
  return notes.map((note) => {
    const plain: Record<string, string> = { at: note.at, operatorId: note.operatorId, type: note.type, note: note.note };
    if (note.id !== undefined) plain["id"] = note.id;
    if (note.assignmentId !== undefined) plain["assignmentId"] = note.assignmentId;
    if (note.editedAt !== undefined) plain["editedAt"] = note.editedAt;
    return plain;
  });
}

export async function addNote(
  client: PrismaClient,
  jobId: string,
  operatorId: string,
  type: HandNoteType,
  text: string,
  now: Date = new Date(),
): Promise<void> {
  await client.$transaction(async (tx) => {
    const notes = await lockedNotes(tx, jobId);
    notes.push({ id: randomUUID(), at: now.toISOString(), operatorId, type, note: text });
    await tx.job.update({ where: { id: jobId }, data: { operatorNotes: toJson(notes) } });
  });
}

export async function editNote(
  client: PrismaClient,
  jobId: string,
  noteId: string,
  viewerId: string,
  text: string,
  now: Date = new Date(),
): Promise<{ ok: true } | NoteFailure> {
  return client.$transaction(async (tx) => {
    const notes = await lockedNotes(tx, jobId);
    const note = notes.find((entry) => entry.id === noteId);
    if (!note) return { ok: false, status: 404, error: "not found" } as const;
    if (note.operatorId !== viewerId) {
      return { ok: false, status: 403, error: "Only the person who wrote a note can change it." } as const;
    }
    if (editableForSeconds(note, viewerId, now) === 0) {
      return { ok: false, status: 409, error: "A note locks 10 minutes after it is written." } as const;
    }
    if (note.note === text) return { ok: true } as const;
    note.note = text;
    note.editedAt = now.toISOString();
    await tx.job.update({ where: { id: jobId }, data: { operatorNotes: toJson(notes) } });
    return { ok: true } as const;
  });
}
