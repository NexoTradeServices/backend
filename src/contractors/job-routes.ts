// /api/contractor/jobs -- Feature 5001, the contractor's job screen and Complete.
//
//   GET  /api/contractor/jobs/:reference                  the screen's read
//   POST /api/contractor/jobs/:reference/on-site          the optional "On site" tap
//   PUT  /api/contractor/jobs/:reference                  Save: times, notes, parts, as a whole
//   POST /api/contractor/jobs/:reference/complete         save, then freeze
//   POST /api/contractor/jobs/:reference/receipt-signature  a signed direct upload for a receipt
//   POST /api/contractor/jobs/:reference/receipts         the upload confirmed -> an Attachment
//
// The contractor always comes from the session, never the URL; a job that is
// not his own assignment answers 404, never a hint that it exists (same door
// as dashboard-routes.ts).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { formatSlotLabel } from "../time/index.js";
import { suburbOf } from "../jobs/shared.js";
import { billedHours } from "../jobs/billed-hours.js";
import { issueInvoice } from "../invoices/issue.js";
import { kickPayLink } from "../invoices/pay-link.js";
import { assignmentInclude, jobFactsOf, type JobFacts } from "../respond/service.js";
import {
  isReceiptKey,
  photoUrls,
  readCloudinaryConfig,
  signReceiptUpload,
  type CloudinaryConfig,
} from "../photos/cloudinary.js";
import {
  OPEN_VISIT_STATUSES,
  Refused,
  entryViewOf,
  lockAssignment,
  lockedFailure,
  parseCompletionNotes,
  parseParts,
  parseTimeEntries,
  returnVisitMinimum,
  writeEntries,
  writeParts,
  type EntryView,
  type Failure,
  type ParsedEntry,
  type ParsedPart,
} from "../jobs/visit.js";

type WithReference = Request<{ reference: string }>;

export interface ContractorJobRoutesOptions {
  /** Feature 3003's seam, reused: the Cloudinary settings, or null for "not set up". */
  cloudinaryConfig?: () => CloudinaryConfig | null;
}

const READABLE = ["accepted", "in_progress", "completed"] as const;

export interface PartView {
  name: string;
  description: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  receiptAttachmentId: string | null;
  receipt: { fileName: string; thumbnailUrl: string; fullUrl: string } | null;
}

export interface ContractorJobView extends JobFacts {
  reference: string;
  jobStatus: string;
  assignmentStatus: string;
  customerName: string;
  suburb: string;
  postcode: string;
  slotLabel: string | null;
  timeEntries: EntryView[];
  completionNotes: string;
  parts: PartView[];
  /**
   * Feature 6001: the pay link as a QR for the customer to scan -- `{ payLinkUrl }` once the
   * invoice has its link, `{ waiting: true }` while it does not, null when there is nothing to
   * pay (no invoice yet, or a zero-dollar one). No amount, ever.
   */
  payment: { payLinkUrl: string } | { waiting: true } | null;
  /** Live, from what is saved; the screen recomputes it as he types. */
  billedHours: number;
  returnVisitMinimumMinutes: number;
  /** Cents, from settings -- the cap per part line. */
  maxContractorPartAmount: number;
  /** Completed: every control is locked. */
  frozen: boolean;
  /** "On site" is offered only while the visit is accepted. */
  canOnSite: boolean;
  timezone: string;
}

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

function send(res: Response, failure: Failure): void {
  res.status(failure.status).json({ error: failure.error, field: failure.field });
}

/** His own assignment on the job, in a status the screen can show -- else null (a 404). */
async function loadOwn(client: PrismaClient, userId: string, reference: string) {
  return client.assignment.findFirst({
    where: {
      job: { reference },
      contractor: { userId },
      status: { in: [...READABLE] },
    },
    include: { ...assignmentInclude, timeLogs: true, parts: { include: { receiptAttachment: true } } },
  });
}

type OwnAssignment = NonNullable<Awaited<ReturnType<typeof loadOwn>>>;

async function viewOf(client: PrismaClient, assignment: OwnAssignment, now: Date): Promise<ContractorJobView> {
  const job = assignment.job;
  const zone = job.timezone;
  const settings = await client.platformSettings.findFirst({
    select: { returnVisitMinimumMinutes: true, maxContractorPartAmount: true },
  });
  const minimum = settings?.returnVisitMinimumMinutes ?? 30;
  const logs = [...assignment.timeLogs].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
  );
  const slot = job.status === "on_hold" ? null : (assignment.confirmedSlot ?? assignment.proposedSlot);
  const cloudName = process.env["CLOUDINARY_CLOUD_NAME"]?.trim();
  const facts = await jobFactsOf(client, job);
  const invoice =
    assignment.invoiceId === null
      ? null
      : await client.invoice.findUnique({
          where: { id: assignment.invoiceId },
          select: { status: true, isZeroDollar: true, stripePaymentLinkUrl: true },
        });
  const payable = invoice !== null && invoice.status === "sent" && !invoice.isZeroDollar;

  return {
    ...facts,
    reference: job.reference,
    jobStatus: job.status,
    assignmentStatus: assignment.status,
    customerName: job.customer.name,
    suburb: suburbOf(job.serviceLocation),
    postcode: job.postcode,
    slotLabel: slot === null ? null : formatSlotLabel(zone, slot, now),
    timeEntries: logs.map((row) => entryViewOf(row, zone)),
    completionNotes: assignment.completionNotes ?? "",
    parts: [...assignment.parts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((part) => ({
        name: part.name,
        description: part.description ?? "",
        qty: Number(part.qty),
        unitPrice: part.unitPrice,
        lineTotal: part.lineTotal,
        receiptAttachmentId: part.receiptAttachmentId,
        receipt:
          part.receiptAttachment === null || !cloudName
            ? null
            : {
                fileName: part.receiptAttachment.fileName,
                ...photoUrls(part.receiptAttachment.storageKey, cloudName),
              },
      })),
    payment: !payable ? null : invoice.stripePaymentLinkUrl === null ? { waiting: true } : { payLinkUrl: invoice.stripePaymentLinkUrl },
    billedHours:
      assignment.status === "completed" && assignment.billedHours !== null
        ? Number(assignment.billedHours)
        : billedHours(logs, minimum),
    returnVisitMinimumMinutes: minimum,
    maxContractorPartAmount: settings?.maxContractorPartAmount ?? 15_000,
    frozen: assignment.status === "completed",
    canOnSite: assignment.status === "accepted",
    timezone: zone,
  };
}

interface VisitInput {
  entries: ParsedEntry[];
  notes: string | null;
  parts: ParsedPart[];
}

function parseVisit(body: unknown, zone: string, maxAmount: number): { ok: true; input: VisitInput } | Failure {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const entries = parseTimeEntries(b["timeEntries"] ?? [], zone);
  if (!entries.ok) return entries;
  const notes = parseCompletionNotes(b["completionNotes"]);
  if (!notes.ok) return notes;
  const parts = parseParts(b["parts"], maxAmount);
  if (!parts.ok) return parts;
  return { ok: true, input: { entries: entries.entries, notes: notes.notes, parts: parts.parts } };
}

export function contractorJobRoutes(client: PrismaClient, options: ContractorJobRoutesOptions = {}): Router {
  const router = createRouter();
  const cloudinaryConfig = options.cloudinaryConfig ?? readCloudinaryConfig;

  /** The route's first move: session -> his own assignment, or a 404. */
  async function own(req: WithReference, res: Response): Promise<OwnAssignment | null> {
    if (!req.authUser) {
      res.status(401).json({ error: "not authenticated" });
      return null;
    }
    const assignment = await loadOwn(client, req.authUser.id, req.params.reference);
    if (assignment === null) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return assignment;
  }

  router.get("/:reference", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      res.json(await viewOf(client, assignment, new Date()));
    })().catch(failWith(res, "GET /api/contractor/jobs/:reference"));
  });

  router.post("/:reference/on-site", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      const refused = await client.$transaction(async (tx): Promise<Failure | null> => {
        const locked = await lockAssignment(tx, assignment.jobId, assignment.id);
        if (locked.status === "in_progress") return null; // a second tap changes nothing
        if (locked.status !== "accepted") return lockedFailure(locked.status);
        await tx.assignment.update({ where: { id: locked.id }, data: { status: "in_progress" } });
        await tx.job.update({ where: { id: locked.jobId }, data: { status: "in_progress" } });
        return null;
      });
      if (refused !== null) {
        send(res, refused);
        return;
      }
      const fresh = await loadOwn(client, req.authUser?.id ?? "", req.params.reference);
      if (fresh === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await viewOf(client, fresh, new Date()));
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/on-site"));
  });

  /** Save and Complete share this: parse, lock, write -- Complete adds its two needs and the freeze. */
  async function saveVisit(req: WithReference, res: Response, complete: boolean): Promise<void> {
    const assignment = await own(req, res);
    if (assignment === null) return;
    const settings = await client.platformSettings.findFirst({ select: { maxContractorPartAmount: true } });
    const parsed = parseVisit(req.body, assignment.job.timezone, settings?.maxContractorPartAmount ?? 15_000);
    if (!parsed.ok) {
      send(res, parsed);
      return;
    }
    const { entries, notes, parts } = parsed.input;
    if (complete) {
      if (entries.length === 0) {
        send(res, { ok: false, status: 400, error: "Add at least one visit.", field: "timeEntries" });
        return;
      }
      if (notes === null) {
        send(res, { ok: false, status: 400, error: "Required.", field: "completionNotes" });
        return;
      }
    }
    const minimum = await returnVisitMinimum(client);
    let issuedInvoiceId: string | null = null;
    try {
      await client.$transaction(async (tx) => {
        const locked = await lockAssignment(tx, assignment.jobId, assignment.id);
        if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(locked.status)) throw new Refused(lockedFailure(locked.status));
        await writeEntries(tx, locked.id, entries);
        await writeParts(tx, locked.id, parts);
        if (!complete) {
          await tx.assignment.update({ where: { id: locked.id }, data: { completionNotes: notes } });
          return;
        }
        // Freeze the visit AND issue its invoice in this one transaction (Feature 6001): a
        // completed visit never exists without its invoice. Nothing is sent here -- the pay
        // link is made after the commit, and the invoice email and text go once it exists.
        const completedAt = new Date();
        const hours = billedHours(entries, minimum);
        await tx.assignment.update({
          where: { id: locked.id },
          data: { completionNotes: notes, billedHours: hours, completedAt, status: "completed" },
        });
        await tx.job.update({ where: { id: locked.jobId }, data: { status: "completed" } });
        const invoice = await issueInvoice(tx, {
          assignmentId: locked.id,
          entryStarts: entries.map((entry) => entry.startedAt),
          billedHours: hours,
          now: completedAt,
        });
        issuedInvoiceId = invoice.id;
      });
    } catch (error: unknown) {
      if (error instanceof Refused) {
        send(res, error.failure);
        return;
      }
      throw error;
    }
    // The normal case goes out within seconds; if Stripe does not answer, the loop keeps asking.
    if (issuedInvoiceId !== null) kickPayLink(client, issuedInvoiceId);
    const fresh = await loadOwn(client, req.authUser?.id ?? "", req.params.reference);
    if (fresh === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(await viewOf(client, fresh, new Date()));
  }

  router.put("/:reference", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void saveVisit(req, res, false).catch(failWith(res, "PUT /api/contractor/jobs/:reference"));
  });

  router.post("/:reference/complete", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void saveVisit(req, res, true).catch(failWith(res, "POST /api/contractor/jobs/:reference/complete"));
  });

  // A receipt upload is for a contractor on his own OPEN assignment, in the
  // receipts folder -- never the enquiry folder. Not set up -> 503 and the
  // part cannot be added; the rest of the screen still saves.
  router.post("/:reference/receipt-signature", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(assignment.status)) {
        send(res, lockedFailure(assignment.status));
        return;
      }
      const config = cloudinaryConfig();
      if (config === null) {
        res.status(503).json({ error: "photo upload is unavailable" });
        return;
      }
      res.json(signReceiptUpload(config));
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/receipt-signature"));
  });

  router.post("/:reference/receipts", requireRole(Role.contractor), (req: WithReference, res: Response) => {
    void (async () => {
      const assignment = await own(req, res);
      if (assignment === null) return;
      if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(assignment.status)) {
        send(res, lockedFailure(assignment.status));
        return;
      }
      const b = req.body !== null && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const storageKey = typeof b["storageKey"] === "string" ? b["storageKey"].trim() : "";
      const fileName = typeof b["fileName"] === "string" ? b["fileName"].trim().slice(0, 200) : "";
      if (!isReceiptKey(storageKey)) {
        res.status(400).json({ error: "not a receipt upload", field: "storageKey" });
        return;
      }
      const row = await client.attachment.create({
        data: {
          jobId: assignment.jobId,
          assignmentId: assignment.id,
          uploadedByRole: "contractor",
          storageKey,
          fileName: fileName === "" ? "receipt" : fileName,
        },
      });
      const cloudName = process.env["CLOUDINARY_CLOUD_NAME"]?.trim();
      res.status(201).json({
        id: row.id,
        fileName: row.fileName,
        ...(cloudName ? photoUrls(row.storageKey, cloudName) : { thumbnailUrl: "", fullUrl: "" }),
      });
    })().catch(failWith(res, "POST /api/contractor/jobs/:reference/receipts"));
  });

  return router;
}
