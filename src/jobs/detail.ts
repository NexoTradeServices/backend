// The job page's read -- Feature 4001, ops job queue and job detail.
//
// Operations Admin Workflow / The job queue and the job page: the request as
// the customer sent it (read-only), the contractor (the shown assignment),
// the customer's contact, the two addresses, and the notes log newest first.
import type { PrismaClient } from "../db/client.js";
import type { JobStatus } from "../generated/prisma/enums.js";
import { formatDateTimeLabel, formatPlainDate, formatSlotLabel } from "../time/index.js";
import { customerPhotosOf, type PhotoView } from "../photos/cloudinary.js";
import { editableForSeconds, readNotes } from "./notes.js";
import { jobMessages, type MessageView } from "./messages.js";
import { asSiteContact, isClosed, type SiteContactView } from "./site-contact.js";
import { billedHours } from "./billed-hours.js";
import { entryViewOf, returnVisitMinimum, savedEntries, type EntryView } from "./visit.js";
import { isServiceLevelMultipliers, priceLine } from "./dispatch-level.js";
import {
  WINDOW_LABELS,
  NO_ADDRESS_REASON,
  asAddress,
  contractorView,
  effectiveAddress,
  jobInclude,
  sameAddress,
  suburbOf,
  type Address,
  type ContractorView,
  type JobWithRelations,
} from "./shared.js";

export interface NoteView {
  /** null only on a note written before 4001 gave notes an id -- never editable. */
  id: string | null;
  type: string;
  note: string;
  atLabel: string;
  authorName: string;
  edited: boolean;
  /** Seconds left for THIS viewer to fix it; 0 = the page offers no Edit. */
  editableForSeconds: number;
}

export interface EarlierBooking {
  contractorName: string;
  contractorCode: string;
  /** "Declined" -- 4006's cancelled bookings join this list under their own word. */
  what: string;
  /** When it happened, in the job's zone. */
  whenLabel: string;
  slotLabel: string | null;
  note: string | null;
}

/** Feature 5001: the shown assignment's visit -- time entries ops may fix until Complete, then the frozen record. */
export interface VisitView {
  /** Ops may change the time entries only while the visit is accepted or in progress. */
  editable: boolean;
  completed: boolean;
  /** The job's own zone -- a new row's date and Finish default are read in it. */
  timezone: string;
  timeEntries: EntryView[];
  billedHours: number;
  /** Once completed only. */
  completionNotes: string | null;
  parts: { name: string; qty: number; unitPrice: number; lineTotal: number }[];
}

export interface JobDetail {
  reference: string;
  status: JobStatus;
  source: "web" | "phone";
  trade: string;
  suburb: string;
  postcode: string;
  wantedDate: string;
  windowLabel: string;
  receivedLabel: string;
  description: string | null;
  /** Each answered question as saved, "<question>: <answer>", in the trade's order. */
  answers: string[];
  /** Feature 3003: the customer's enquiry photos, oldest first. */
  photos: PhotoView[];
  customer: {
    code: string;
    name: string;
    phone: string | null;
    email: string;
    billingAddress: Address | null;
  };
  siteAddress: Address | null;
  /** Plan decision 6: derived, never stored. */
  siteSameAsBilling: boolean;
  /** Ops job actions - Edit: the site freezes once the job is dispatched. */
  siteLocked: boolean;
  /** Feature 4008: who lets the contractor in; null = the customer is the contact. */
  siteContact: SiteContactView | null;
  /** Plan decision 4: completed or cancelled -- the site contact is read-only. */
  closed: boolean;
  contractor: ContractorView | null;
  /** Feature 5001: null until the contractor has accepted. */
  visit: VisitView | null;
  /** Feature 4003 (plan decision 10): every assignment but the one in play, newest first. */
  earlierBookings: EarlierBooking[];
  /** AC29: the level and its price, shown once the job is dispatched (Job.serviceLevel set). */
  serviceLevel: string | null;
  priceLine: string | null;
  /** AC1/AC2: the job page's own Dispatch button. */
  canDispatch: boolean;
  dispatchBlockedReason: string | null;
  notes: NoteView[];
  /** Feature 4008: every message sent about the job, newest first. */
  messages: MessageView[];
}

export async function loadJob(client: PrismaClient, reference: string): Promise<JobWithRelations | null> {
  return client.job.findUnique({ where: { reference }, include: jobInclude });
}

export function answersOf(selectedOptions: unknown): string[] {
  if (!Array.isArray(selectedOptions)) return [];
  return selectedOptions.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Plan decision 10: every assignment on the job except the one in play,
 * newest first -- the contractor's name and code, what happened and when,
 * the slot, and his note when there is one. 4003 makes only declined ones.
 */
async function earlierBookingsOf(client: PrismaClient, job: JobWithRelations, now: Date): Promise<EarlierBooking[]> {
  const inPlay = job.assignments[0]?.id;
  const rows = await client.assignment.findMany({
    where: { jobId: job.id, status: "declined", ...(inPlay === undefined ? {} : { id: { not: inPlay } }) },
    include: { contractor: { select: { name: true, code: true } } },
  });
  return rows
    .map((row) => ({ row, at: row.declinedAt ?? row.dispatchedAt }))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.row.id.localeCompare(a.row.id))
    .map(({ row, at }) => ({
      contractorName: row.contractor.name,
      contractorCode: row.contractor.code,
      what: "Declined",
      whenLabel: formatDateTimeLabel(job.timezone, at, now),
      slotLabel: row.proposedSlot === null ? null : formatSlotLabel(job.timezone, row.proposedSlot, now),
      note: row.declineNote,
    }));
}

async function visitOf(client: PrismaClient, job: JobWithRelations): Promise<VisitView | null> {
  const assignment = job.assignments[0];
  if (assignment === undefined || assignment.status === "assigned") return null;
  const rows = await savedEntries(client, assignment.id);
  const completed = assignment.status === "completed";
  const parts = completed ? await client.assignmentPart.findMany({ where: { assignmentId: assignment.id }, orderBy: { id: "asc" } }) : [];
  return {
    editable: !completed,
    completed,
    timezone: job.timezone,
    timeEntries: rows.map((row) => entryViewOf(row, job.timezone)),
    billedHours:
      completed && assignment.billedHours !== null
        ? Number(assignment.billedHours)
        : billedHours(rows, await returnVisitMinimum(client)),
    completionNotes: completed ? (assignment.completionNotes ?? "") : null,
    parts: parts.map((part) => ({ name: part.name, qty: Number(part.qty), unitPrice: part.unitPrice, lineTotal: part.lineTotal })),
  };
}

export async function jobDetail(
  client: PrismaClient,
  job: JobWithRelations,
  viewerId: string,
  now: Date = new Date(),
): Promise<JobDetail> {
  const billingAddress = asAddress(job.customer.billingAddress);
  const siteAddress = asAddress(job.siteAddress);
  const hasAddress = effectiveAddress(job) !== null;

  const notes = readNotes(job.operatorNotes);
  const authorIds = [...new Set(notes.map((note) => note.operatorId))];
  const authors = await client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
  const nameOf = (id: string): string => authors.find((author) => author.id === id)?.name ?? "Unknown";

  const multipliers = job.serviceType.serviceLevelMultipliers;
  const price =
    job.serviceLevel !== null && isServiceLevelMultipliers(multipliers)
      ? priceLine(
          { calloutRate: job.customerCalloutRate, standardRate: job.customerStandardRate },
          multipliers,
          job.serviceLevel,
        )
      : null;

  // The business clock (Data Model / Time): PlatformSettings.timezone.
  const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
  const earlierBookings = await earlierBookingsOf(client, job, now);
  const messages = await jobMessages(client, job.id, settings?.timezone ?? job.timezone);

  return {
    reference: job.reference,
    status: job.status,
    source: job.source,
    trade: job.serviceType.trade,
    suburb: suburbOf(job.serviceLocation),
    postcode: job.postcode,
    wantedDate: formatPlainDate(job.preferredDate),
    windowLabel: WINDOW_LABELS[job.preferredWindow],
    receivedLabel: formatDateTimeLabel(job.timezone, job.createdAt, now),
    description: job.description,
    answers: answersOf(job.selectedOptions),
    photos: await customerPhotosOf(client, job.id),
    customer: {
      code: job.customer.code,
      name: job.customer.name,
      phone: job.customer.phone,
      email: job.customer.email,
      billingAddress,
    },
    siteAddress,
    siteSameAsBilling: siteAddress === null || sameAddress(siteAddress, billingAddress),
    siteLocked: job.status !== "new",
    siteContact: asSiteContact(job.siteContact),
    closed: isClosed(job.status),
    contractor: contractorView(job, now),
    visit: await visitOf(client, job),
    earlierBookings,
    serviceLevel: job.serviceLevel,
    priceLine: price,
    canDispatch: job.status === "new" && hasAddress,
    dispatchBlockedReason: job.status === "new" && !hasAddress ? NO_ADDRESS_REASON : null,
    notes: [...notes]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .map((note) => ({
        id: note.id ?? null,
        type: note.type,
        note: note.note,
        atLabel: formatDateTimeLabel(job.timezone, new Date(note.at), now),
        authorName: nameOf(note.operatorId),
        edited: note.editedAt !== undefined,
        editableForSeconds: editableForSeconds(note, viewerId, now),
      })),
    messages,
  };
}
