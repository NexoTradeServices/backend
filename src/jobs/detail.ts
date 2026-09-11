// The job page's read -- Feature 4001, ops job queue and job detail.
//
// Operations Admin Workflow / The job queue and the job page: the request as
// the customer sent it (read-only), the contractor (the shown assignment),
// the customer's contact, the two addresses, and the notes log newest first.
import type { PrismaClient } from "../db/client.js";
import type { JobStatus } from "../generated/prisma/enums.js";
import { formatDateTimeLabel, formatPlainDate } from "../time/index.js";
import { editableForSeconds, readNotes } from "./notes.js";
import {
  WINDOW_LABELS,
  asAddress,
  contractorView,
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
  contractor: ContractorView | null;
  notes: NoteView[];
}

export async function loadJob(client: PrismaClient, reference: string): Promise<JobWithRelations | null> {
  return client.job.findUnique({ where: { reference }, include: jobInclude });
}

function answersOf(selectedOptions: unknown): string[] {
  if (!Array.isArray(selectedOptions)) return [];
  return selectedOptions.filter((entry): entry is string => typeof entry === "string");
}

export async function jobDetail(
  client: PrismaClient,
  job: JobWithRelations,
  viewerId: string,
  now: Date = new Date(),
): Promise<JobDetail> {
  const billingAddress = asAddress(job.customer.billingAddress);
  const siteAddress = asAddress(job.siteAddress);

  const notes = readNotes(job.operatorNotes);
  const authorIds = [...new Set(notes.map((note) => note.operatorId))];
  const authors = await client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
  const nameOf = (id: string): string => authors.find((author) => author.id === id)?.name ?? "Unknown";

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
    contractor: contractorView(job, now),
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
  };
}
