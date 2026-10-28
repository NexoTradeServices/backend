// The customer portal's reads -- Feature 6010, customer portal.
//
// `/api/account/...` for a customer with a login: her jobs, invoices, payments and profile, and nothing of
// the office's (no notes, no contractor pay or surname or contact, no customer rating, no enquiry
// contact). Every route requires the customer role and every query is scoped to the Customer whose
// `userId` is the session user. A record of anyone else is a 404 -- never a 403, so references cannot be
// probed. (The public set-password request lives beside this in routes.ts.)
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import type { Customer } from "../generated/prisma/client.js";
import { Role } from "../generated/prisma/enums.js";
import { requireRole } from "../auth/middleware.js";
import { buildInvoicePdf } from "../invoices/pdf.js";
import { buildCreditNotePdf } from "../refunds/credit-note.js";
import { formatDate, formatPlainDate, formatSlotLabel } from "../time/index.js";
import { WINDOW_LABELS, asAddress, type Address } from "../jobs/shared.js";
import { answersOf } from "../jobs/detail.js";
import type { JobStatus, InvoiceStatus } from "../generated/prisma/enums.js";

export const PAGE_SIZE = 50;

/** Her wording for a job's status (Requested, Booked, In progress, On hold, Done, Cancelled). */
export const JOB_STATUS_WORDS: Record<JobStatus, string> = {
  new: "Requested",
  assigned: "Requested",
  scheduled: "Booked",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Done",
  cancelled: "Cancelled",
};

export const INVOICE_STATUS_WORDS: Record<InvoiceStatus, string> = { sent: "Open", paid: "Paid", void: "Void" };

const METHOD_WORDS: Record<string, string> = { card: "Card", payto: "Bank", au_becs_debit: "Bank", bank: "Bank" };

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

function page(query: Request["query"]): { offset: number; limit: number } {
  const rawOffset = typeof query["offset"] === "string" && /^\d+$/.test(query["offset"]) ? Number(query["offset"]) : 0;
  const rawLimit = typeof query["limit"] === "string" && /^\d+$/.test(query["limit"]) ? Number(query["limit"]) : PAGE_SIZE;
  return { offset: rawOffset, limit: Math.min(Math.max(rawLimit, 1), 500) };
}

function oneLine(address: Address | null): string | null {
  if (address === null) return null;
  return `${address.street}, ${address.suburb} ${address.state} ${address.postcode}`;
}

const firstName = (name: string): string => name.split(" ")[0] ?? name;

export function accountPortalRoutes(client: PrismaClient): Router {
  const router = createRouter();

  /** The Customer whose login this is, or null (a customer-role user with no record sees nothing). */
  async function customerOf(req: Request): Promise<Customer | null> {
    const userId = req.authUser?.id;
    if (userId === undefined) return null;
    return client.customer.findUnique({ where: { userId } });
  }

  async function businessZone(): Promise<string> {
    const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
    return settings?.timezone ?? "Australia/Perth";
  }

  // ---- Jobs ---------------------------------------------------------------------------------------

  router.get("/jobs", requireRole(Role.customer), (req: Request, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      if (customer === null) {
        res.json({ rows: [], total: 0, hasMore: false });
        return;
      }
      const { offset, limit } = page(req.query);
      const where = { customerId: customer.id };
      const [total, jobs] = await Promise.all([
        client.job.count({ where }),
        client.job.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { reference: "desc" }],
          skip: offset,
          take: limit,
          include: {
            serviceType: { select: { trade: true } },
            assignments: { where: { status: { in: ["accepted", "in_progress", "completed"] } }, orderBy: { id: "desc" }, take: 1 },
          },
        }),
      ]);
      const now = new Date();
      res.json({
        rows: jobs.map((job) => {
          const slot = job.assignments[0]?.confirmedSlot ?? null;
          const booked = slot !== null && job.status !== "new" && job.status !== "assigned";
          return {
            reference: job.reference,
            trade: job.serviceType.trade,
            suburb: (job.serviceLocation as { suburb?: string } | null)?.suburb ?? "",
            status: JOB_STATUS_WORDS[job.status],
            when: booked ? formatSlotLabel(job.timezone, slot, now) : `${formatPlainDate(job.preferredDate, now)}, ${WINDOW_LABELS[job.preferredWindow]}`,
          };
        }),
        total,
        hasMore: offset + jobs.length < total,
      });
    })().catch(failWith(res, "GET /api/account/jobs"));
  });

  router.get("/jobs/:reference", requireRole(Role.customer), (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      const job =
        customer === null
          ? null
          : await client.job.findFirst({
              where: { reference: req.params.reference, customerId: customer.id },
              include: {
                serviceType: { select: { trade: true } },
                assignments: {
                  where: { status: { in: ["accepted", "in_progress", "completed"] } },
                  orderBy: { id: "desc" },
                  take: 1,
                  include: { contractor: { select: { name: true } } },
                },
                invoices: { orderBy: { createdAt: "asc" }, select: { reference: true, status: true } },
                reviews: { take: 1, select: { rating: true, reviewText: true, recommendScore: true } },
              },
            });
      if (job === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const now = new Date();
      const visit = job.assignments[0] ?? null;
      const slot = visit?.confirmedSlot ?? null;
      const booked = visit !== null && slot !== null && job.status !== "new" && job.status !== "assigned";
      const review = job.reviews[0] ?? null;
      res.json({
        reference: job.reference,
        trade: job.serviceType.trade,
        suburb: (job.serviceLocation as { suburb?: string } | null)?.suburb ?? "",
        postcode: job.postcode,
        status: JOB_STATUS_WORDS[job.status],
        when: booked ? formatSlotLabel(job.timezone, slot, now) : `${formatPlainDate(job.preferredDate, now)}, ${WINDOW_LABELS[job.preferredWindow]}`,
        tradie: booked ? firstName(visit.contractor.name) : null,
        jobSite: oneLine(asAddress(job.siteAddress)),
        description: job.description,
        answers: answersOf(job.selectedOptions),
        invoices: job.invoices.map((invoice) => ({ reference: invoice.reference, status: INVOICE_STATUS_WORDS[invoice.status] })),
        done: job.status === "completed",
        review: review === null ? null : { rating: review.rating, reviewText: review.reviewText, recommendScore: review.recommendScore },
      });
    })().catch(failWith(res, "GET /api/account/jobs/:reference"));
  });

  // ---- Invoices -----------------------------------------------------------------------------------

  router.get("/invoices", requireRole(Role.customer), (req: Request, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      if (customer === null) {
        res.json({ rows: [], total: 0, hasMore: false });
        return;
      }
      const { offset, limit } = page(req.query);
      const zone = await businessZone();
      const where = { customerId: customer.id };
      const [total, invoices] = await Promise.all([
        client.invoice.count({ where }),
        client.invoice.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { reference: "desc" }],
          skip: offset,
          take: limit,
          include: { job: { select: { reference: true } } },
        }),
      ]);
      res.json({
        rows: invoices.map((invoice) => ({
          reference: invoice.reference,
          jobReference: invoice.job.reference,
          issued: formatDate(zone, invoice.sentAt ?? invoice.createdAt),
          amount: invoice.amount,
          status: INVOICE_STATUS_WORDS[invoice.status],
        })),
        total,
        hasMore: offset + invoices.length < total,
      });
    })().catch(failWith(res, "GET /api/account/invoices"));
  });

  async function ownInvoice(req: Request<{ reference: string }>) {
    const customer = await customerOf(req);
    if (customer === null) return null;
    return client.invoice.findFirst({
      where: { reference: req.params.reference, customerId: customer.id },
      include: { lines: { orderBy: { id: "asc" } }, job: { select: { reference: true, timezone: true } }, replacedBy: { select: { reference: true }, take: 1 } },
    });
  }

  router.get("/invoices/:reference", requireRole(Role.customer), (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const invoice = await ownInvoice(req);
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const billedTo = invoice.billedTo as { name: string; businessName?: string; abn?: string; address?: Address };
      res.json({
        reference: invoice.reference,
        jobReference: invoice.job.reference,
        status: INVOICE_STATUS_WORDS[invoice.status],
        billedTo: { name: billedTo.name, businessName: billedTo.businessName ?? null, abn: billedTo.abn ?? null, address: oneLine(asAddress(billedTo.address)) },
        issued: formatDate(invoice.job.timezone, invoice.sentAt ?? invoice.createdAt),
        due: formatDate(invoice.job.timezone, invoice.dueAt),
        lines: invoice.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          qty: Number(line.qty),
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
        labour: invoice.labourAmount,
        materials: invoice.materialsAmount,
        gstApplied: invoice.gstApplied,
        gst: invoice.gstAmount ?? 0,
        total: invoice.amount,
        payLink: invoice.status === "sent" ? invoice.stripePaymentLinkUrl : null,
        replacedBy: invoice.status === "void" ? (invoice.replacedBy[0]?.reference ?? null) : null,
      });
    })().catch(failWith(res, "GET /api/account/invoices/:reference"));
  });

  router.get("/invoices/:reference/pdf", requireRole(Role.customer), (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const invoice = await ownInvoice(req);
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const pdf = await buildInvoicePdf(client, invoice.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${pdf.fileName}"`);
      res.send(Buffer.from(pdf.content));
    })().catch(failWith(res, "GET /api/account/invoices/:reference/pdf"));
  });

  // ---- Payments and refunds -----------------------------------------------------------------------

  router.get("/payments", requireRole(Role.customer), (req: Request, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      if (customer === null) {
        res.json({ rows: [] });
        return;
      }
      const zone = await businessZone();
      const [payments, refunds] = await Promise.all([
        client.payment.findMany({ where: { customerId: customer.id, status: { in: ["succeeded", "refunded"] } }, include: { invoice: { select: { reference: true } } } }),
        client.refund.findMany({ where: { customerId: customer.id, status: "succeeded" }, include: { invoice: { select: { reference: true } }, payment: { select: { method: true } } } }),
      ]);
      const rows = [
        ...payments.map((payment) => {
          const at = payment.paidAt ?? payment.createdAt;
          return {
            kind: "payment" as const,
            at,
            date: formatDate(zone, at),
            what: `Payment for ${payment.invoice.reference}`,
            how: METHOD_WORDS[payment.method ?? ""] ?? (payment.method ?? "-"),
            amount: payment.amount,
            receipt: null as string | null, // the refund's CN reference when this row is a refund
          };
        }),
        ...refunds.map((refund) => ({
          kind: "refund" as const,
          at: refund.createdAt,
          date: formatDate(zone, refund.createdAt),
          what: `Refund ${refund.reference} on ${refund.invoice.reference}`,
          how: METHOD_WORDS[refund.payment?.method ?? ""] ?? (refund.payment?.method ?? "-"),
          amount: refund.amount,
          receipt: refund.reference,
        })),
      ].sort((a, b) => b.at.getTime() - a.at.getTime());
      res.json({ rows: rows.map((row) => ({ kind: row.kind, date: row.date, what: row.what, how: row.how, amount: row.amount, receipt: row.receipt })) });
    })().catch(failWith(res, "GET /api/account/payments"));
  });

  router.get("/refunds/:reference/pdf", requireRole(Role.customer), (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      const refund =
        customer === null
          ? null
          : await client.refund.findFirst({ where: { reference: req.params.reference, customerId: customer.id }, select: { id: true } });
      if (refund === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const note = await buildCreditNotePdf(client, refund.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${note.fileName}"`);
      res.send(Buffer.from(note.content));
    })().catch(failWith(res, "GET /api/account/refunds/:reference/pdf"));
  });

  // ---- Profile ------------------------------------------------------------------------------------

  router.get("/profile", requireRole(Role.customer), (req: Request, res: Response) => {
    void (async () => {
      const customer = await customerOf(req);
      if (customer === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
      res.json({
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        businessName: customer.businessName,
        billingAddress: oneLine(asAddress(customer.billingAddress)),
        officePhone: settings?.operatorPhone ?? "",
      });
    })().catch(failWith(res, "GET /api/account/profile"));
  });

  return router;
}
