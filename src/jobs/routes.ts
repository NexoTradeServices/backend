// /api/jobs -- Feature 4001, ops job queue and job detail.
//
// Plan decision 2: mounted behind requireRole("ops"), which admits the owner
// too (1003's middleware) -- the same shape as ../contractors/routes.ts.
//
//   GET  /api/jobs                            the queue (?status, ?q, ?offset, ?limit)
//   GET  /api/jobs/:reference                 the job page
//   PUT  /api/jobs/:reference/addresses       the Addresses card's one Save
//   POST /api/jobs/:reference/notes           add an operator note
//   PUT  /api/jobs/:reference/notes/:noteId   the author fixes it, 10 minutes
//   PUT  /api/jobs/:reference/time-entries    Feature 5001: ops fixes the time entries until Complete
//   POST /api/jobs/:reference/invoice/resend  Feature 6001: the invoice email and text, again
//   POST /api/jobs/:reference/invoice/check-payment  Feature 6002: ask Stripe whether she has paid
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { listQueue, parseQueueQuery } from "./queue.js";
import { jobDetail, loadJob } from "./detail.js";
import { parseAddressesInput, saveAddresses } from "./addresses.js";
import { OPEN_VISIT_STATUSES, Refused, lockAssignment, lockedFailure, parseTimeEntries, writeEntries } from "./visit.js";
import { hasPayableLink } from "../invoices/view.js";
import { askInvoiceMessages } from "../invoices/messages.js";
import { checkPaymentWithStripe } from "../payments/check.js";
import { addNote, editNote, parseEditedNote, parseNewNote } from "./notes.js";
import {
  candidatesAndPriceFor,
  dispatchFactsOf,
  dispatchJob,
  formatDollarsPrice,
  loadDispatchJob,
  parseSlotInput,
  sendDispatchNotifications,
} from "./dispatch.js";

type WithReference = Request<{ reference: string }>;

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function jobRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const parsed = parseQueueQuery(req.query);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
      if (settings === null) {
        res.status(503).json({ error: "the queue is unavailable right now" });
        return;
      }
      res.json(await listQueue(client, parsed.data, settings.timezone));
    })().catch(failWith(res, "GET /api/jobs"));
  });

  router.get("/:reference", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await jobDetail(client, job, req.authUser?.id ?? ""));
    })().catch(failWith(res, "GET /api/jobs/:reference"));
  });

  // Feature 6001: Resend invoice. Refused unless the invoice is sent, not zero-dollar and has
  // its pay link; each press is its own pair of messages (keyed by the moment), and the
  // customer's address is read when they send, so a fixed email is used.
  router.post("/:reference/invoice/resend", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const invoice = await client.invoice.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" } });
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!hasPayableLink(invoice)) {
        res.status(409).json({ error: "This invoice cannot be sent again right now." });
        return;
      }
      await client.$transaction((tx) => askInvoiceMessages(tx, invoice.id, Date.now()));
      res.json(await jobDetail(client, job, req.authUser?.id ?? ""));
    })().catch(failWith(res, "POST /api/jobs/:reference/invoice/resend"));
  });

  // Feature 6002: Check payment with Stripe -- the backup for Stripe's message never
  // arriving. Refused unless the invoice is sent, not zero-dollar and has its link.
  // Answers { paid } and the job page as it is now; 502 when Stripe cannot be reached.
  router.post("/:reference/invoice/check-payment", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const invoice = await client.invoice.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" } });
      if (invoice === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (!hasPayableLink(invoice)) {
        res.status(409).json({ error: "This invoice cannot be checked with Stripe." });
        return;
      }
      const outcome = await checkPaymentWithStripe(client, invoice);
      if (outcome === "unreachable") {
        res.status(502).json({ error: "Couldn't reach Stripe - try again in a minute." });
        return;
      }
      res.json({ paid: outcome === "paid", job: await jobDetail(client, job, req.authUser?.id ?? "") });
    })().catch(failWith(res, "POST /api/jobs/:reference/invoice/check-payment"));
  });

  router.put("/:reference/addresses", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const parsed = parseAddressesInput(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const saved = await saveAddresses(client, job.id, parsed.data);
      if (!saved.ok) {
        res.status(saved.status).json({ error: saved.error, field: saved.field });
        return;
      }
      const fresh = await loadJob(client, job.reference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json({ job: await jobDetail(client, fresh, req.authUser?.id ?? ""), moved: saved.moved });
    })().catch(failWith(res, "PUT /api/jobs/:reference/addresses"));
  });

  // Feature 5001: the same entry rules as the contractor's screen, on the
  // shown assignment, until it is completed (after that: Correct & reissue, 6007).
  router.put("/:reference/time-entries", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const assignment = job.assignments[0];
      if (assignment === undefined) {
        res.status(409).json({ error: "This job is not open for work.", field: "status" });
        return;
      }
      const body = req.body as Record<string, unknown> | null;
      const parsed = parseTimeEntries(body?.["timeEntries"], job.timezone);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      try {
        await client.$transaction(async (tx) => {
          const locked = await lockAssignment(tx, job.id, assignment.id);
          if (!(OPEN_VISIT_STATUSES as readonly string[]).includes(locked.status)) throw new Refused(lockedFailure(locked.status));
          await writeEntries(tx, locked.id, parsed.entries);
        });
      } catch (error: unknown) {
        if (error instanceof Refused) {
          res.status(error.failure.status).json({ error: error.failure.error, field: error.failure.field });
          return;
        }
        throw error;
      }
      const fresh = await loadJob(client, job.reference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json(await jobDetail(client, fresh, req.authUser?.id ?? ""));
    })().catch(failWith(res, "PUT /api/jobs/:reference/time-entries"));
  });

  router.post("/:reference/notes", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job || !req.authUser) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const parsed = parseNewNote(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      await addNote(client, job.id, req.authUser.id, parsed.type, parsed.text);
      const fresh = await loadJob(client, job.reference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.status(201).json(await jobDetail(client, fresh, req.authUser.id));
    })().catch(failWith(res, "POST /api/jobs/:reference/notes"));
  });

  router.put(
    "/:reference/notes/:noteId",
    requireRole(Role.ops),
    (req: Request<{ reference: string; noteId: string }>, res: Response) => {
      void (async () => {
        const job = await loadJob(client, req.params.reference);
        if (!job || !req.authUser) {
          res.status(404).json({ error: "not found" });
          return;
        }
        const parsed = parseEditedNote(req.body);
        if (!parsed.ok) {
          res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
          return;
        }
        const edited = await editNote(client, job.id, req.params.noteId, req.authUser.id, parsed.text);
        if (!edited.ok) {
          res.status(edited.status).json({ error: edited.error });
          return;
        }
        const fresh = await loadJob(client, job.reference);
        if (!fresh) {
          res.status(500).json({ error: "internal error" });
          return;
        }
        res.json(await jobDetail(client, fresh, req.authUser.id));
      })().catch(failWith(res, "PUT /api/jobs/:reference/notes/:noteId"));
    },
  );

  // Feature 4002 -- the dispatch page's own facts + slot defaults.
  router.get("/:reference/dispatch", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadDispatchJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(dispatchFactsOf(job));
    })().catch(failWith(res, "GET /api/jobs/:reference/dispatch"));
  });

  // The candidate list + the level/price for the slot Mike currently has picked.
  router.get(
    "/:reference/dispatch/candidates",
    requireRole(Role.ops),
    (req: WithReference, res: Response) => {
      void (async () => {
        const job = await loadDispatchJob(client, req.params.reference);
        if (!job) {
          res.status(404).json({ error: "not found" });
          return;
        }
        const parsed = parseSlotInput(req.query);
        if (!parsed.ok) {
          res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
          return;
        }
        const result = await candidatesAndPriceFor(client, job, parsed.data);
        if ("error" in result) {
          res.status(400).json({ error: result.error });
          return;
        }
        res.json({ level: result.level, price: formatDollarsPrice(result.price), ...result.candidates });
      })().catch(failWith(res, "GET /api/jobs/:reference/dispatch/candidates"));
    },
  );

  // The dispatch itself (plan decision 8).
  router.post("/:reference/dispatch", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const body = req.body as Record<string, unknown>;
      const contractorCode = body["contractorCode"];
      if (typeof contractorCode !== "string" || contractorCode.trim() === "") {
        res.status(400).json({ error: "contractorCode is required", field: "contractorCode" });
        return;
      }
      const parsed = parseSlotInput(body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await dispatchJob(client, req.params.reference, contractorCode, parsed.data);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      await sendDispatchNotifications(client, result);

      const fresh = await loadJob(client, result.jobReference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.status(201).json({
        job: await jobDetail(client, fresh, req.authUser?.id ?? ""),
        toast: `${result.jobReference} dispatched to ${result.contractorFirstName}. Waiting for his answer.`,
      });
    })().catch(failWith(res, "POST /api/jobs/:reference/dispatch"));
  });

  // The Phase 2 stub (Dispatch Logic -- Phase 2): nothing calls it, no badge renders.
  router.get(
    "/:reference/suggested-contractors",
    requireRole(Role.ops),
    (_req: WithReference, res: Response) => {
      res.json({ suggestions: [] });
    },
  );

  return router;
}
