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
//   POST /api/jobs/:reference/invoice/void  Feature 6008: void an unpaid invoice, with a reason
//   POST /api/jobs/:reference/invoice/refund  Feature 6006: refund money received, an amount in cents and a reason
//   GET  /api/jobs/:reference/correct          Feature 6007: the Correct & reissue page's starting figures
//   POST /api/jobs/:reference/correct/preview  Feature 6007: the What happens card, nothing saved
//   POST /api/jobs/:reference/correct          Feature 6007: correct the visit and reissue or refund
//   POST /api/jobs/:reference/reschedule      Feature 4006: new time for the same contractor
//   POST /api/jobs/:reference/take-off        Feature 4006: free the contractor, job back to New
//   POST /api/jobs/:reference/cancel          Feature 4006: close the job with a reason (Mike only)
//   POST /api/jobs/:reference/callback        Feature 6004: raise a callback from a completed job (Mike only)
//   POST /api/jobs/:reference/no-show         Feature 6004: close a booked job as a customer no-show (Mike only)
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
import { VOID_REFUSALS, parseVoidReason, voidInvoice } from "../invoices/void.js";
import { REFUND_AMOUNT_ERROR, makeRefund } from "../refunds/service.js";
import { correctAndReissue, correctionForm, previewCorrection } from "../invoices/correct.js";
import { formatLabelled } from "../time/index.js";
import { addNote, editNote, parseEditedNote, parseNewNote } from "./notes.js";
import {
  candidatesAndPriceFor,
  dispatchFactsOf,
  dispatchJob,
  slotParts,
  type DispatchFacts,
  formatDollarsPrice,
  loadDispatchJob,
  parseSlotInput,
  sendDispatchNotifications,
  sendRescheduleNotifications,
} from "./dispatch.js";
import { cancelJob, parseCancelInput, takeOffJob } from "./changes.js";
import { parseCallbackInput, raiseCallback } from "./callbacks.js";
import { markNoShow, parseNoShowInput } from "./no-show.js";
import { createJob, parseJobFields } from "./create.js";
import { asEnquiryContact, givenDetails } from "./enquiry-contact.js";
import { editRequest, parseRequestEdit } from "./request-edit.js";

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

  // Feature 3005, phone-taken job intake: Mike keys the job while the customer is on the line. The
  // enquiry's fields less photos, marketing and reCAPTCHA; the job is stamped `phone` here and a
  // `source` in the body is ignored. The customer gets the Enquiry received email; the office gets
  // no new-job-request email (Mike is the one who just took it).
  router.post("/phone", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const body: unknown = req.body;
      if (body === null || typeof body !== "object") {
        res.status(400).json({ error: "request body must be an object" });
        return;
      }
      const parsed = parseJobFields(body as Record<string, unknown>);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const created = await createJob(client, "phone", parsed.data);
      if (!created.ok) {
        res.status(400).json({ error: created.error, field: created.field });
        return;
      }
      res.status(201).json({ reference: created.job.reference });
    })().catch(failWith(res, "POST /api/jobs/phone"));
  });

  // Feature 4004: Mike corrects the request while the job is `new` (trade, description, date, window,
  // suburb). Only the fields sent change; a dispatched job is locked (409); nothing is sent to anyone.
  router.put("/:reference/request", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const parsed = parseRequestEdit(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const outcome = await editRequest(client, req.params.reference, parsed.data);
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error, ...(outcome.field === undefined ? {} : { field: outcome.field }) });
        return;
      }
      const fresh = await loadJob(client, req.params.reference);
      if (!fresh) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await jobDetail(client, fresh, req.authUser?.id ?? ""));
    })().catch(failWith(res, "PUT /api/jobs/:reference/request"));
  });

  // Feature 3010: after confirming on the call, Mike copies what she gave onto her record for every later
  // job: the given phone, and the given business name when not empty. A changed business name keeps the
  // ABN and GST answer (the addresses save's rule: only clearing the name clears them). The name and the
  // email are never touched. Any job status. Nothing to copy -> 409. Ops-only; answers the fresh detail.
  router.post("/:reference/customer/update-from-request", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const job = await loadJob(client, req.params.reference);
      if (!job) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const given = givenDetails(asEnquiryContact(job.enquiryContact), job.customer);
      if (!given.newDetails) {
        res.status(409).json({ error: "There is nothing new to copy onto the customer." });
        return;
      }
      await client.customer.update({
        where: { id: job.customerId },
        data: {
          ...(given.phone !== null ? { phone: given.phone } : {}),
          ...(given.businessName !== null ? { businessName: given.businessName } : {}),
        },
      });
      const fresh = await loadJob(client, req.params.reference);
      if (!fresh) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await jobDetail(client, fresh, req.authUser?.id ?? ""));
    })().catch(failWith(res, "POST /api/jobs/:reference/customer/update-from-request"));
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
  // arriving. Refused unless the invoice is sent, not zero-dollar and has its link --
  // except one already paid, which answers paid.
  // Answers { paid, checkedLabel } and the job page as it is now -- checkedLabel is the
  // moment of the check on the job's clock ("2:15pm AWST"), for the card's own line;
  // 502 when Stripe cannot be reached.
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
      // Already paid (Stripe's message landed while Mike's page still showed it owed): the
      // answer to "has she paid?" is yes -- the card refreshes to Paid, never an error.
      if (invoice.status === "paid" && !invoice.isZeroDollar) {
        res.json({
          paid: true,
          checkedLabel: formatLabelled(job.timezone, new Date()),
          job: await jobDetail(client, job, req.authUser?.id ?? ""),
        });
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
      res.json({
        paid: outcome === "paid",
        checkedLabel: formatLabelled(job.timezone, new Date()),
        job: await jobDetail(client, job, req.authUser?.id ?? ""),
      });
    })().catch(failWith(res, "POST /api/jobs/:reference/invoice/check-payment"));
  });

  // Feature 6008: Void invoice. Ops (the owner too). The reason is required; a paid, already
  // void or zero-dollar invoice is refused 409. Answers the fresh job detail, like resend.
  router.post("/:reference/invoice/void", requireRole(Role.ops), (req: WithReference, res: Response) => {
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
      const parsed = parseVoidReason(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: "reason" });
        return;
      }
      const outcome = await voidInvoice(client, { invoiceId: invoice.id, userId: req.authUser?.id ?? "", reason: parsed.reason });
      if (outcome === "not_found") {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (outcome !== "voided") {
        res.status(409).json({ error: VOID_REFUSALS[outcome] });
        return;
      }
      const fresh = await loadJob(client, req.params.reference);
      res.json(await jobDetail(client, fresh ?? job, req.authUser?.id ?? ""));
    })().catch(failWith(res, "POST /api/jobs/:reference/invoice/void"));
  });

  // Feature 6007: Correct & reissue. Ops (the owner too); a contractor is refused by the role guard.
  router.get("/:reference/correct", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const form = await correctionForm(client, req.params.reference);
      if ("ok" in form) {
        res.status(form.status).json({ error: form.error });
        return;
      }
      res.json(form);
    })().catch(failWith(res, "GET /api/jobs/:reference/correct"));
  });

  router.post("/:reference/correct/preview", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const preview = await previewCorrection(client, req.params.reference, req.body);
      if (!preview.ok) {
        if ("errors" in preview) {
          res.json({ errors: preview.errors });
          return;
        }
        res.status(preview.status).json({ error: preview.error });
        return;
      }
      res.json(preview);
    })().catch(failWith(res, "POST /api/jobs/:reference/correct/preview"));
  });

  router.post("/:reference/correct", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const outcome = await correctAndReissue(client, req.params.reference, req.body, req.authUser?.id ?? "");
      if (!outcome.ok) {
        if ("errors" in outcome) {
          const first = outcome.errors[0];
          res.status(400).json({ error: first?.error ?? "Check the form.", field: first?.field, errors: outcome.errors });
          return;
        }
        res.status(outcome.status).json({ error: outcome.error, ...(outcome.field === undefined ? {} : { field: outcome.field }) });
        return;
      }
      res.json(outcome);
    })().catch(failWith(res, "POST /api/jobs/:reference/correct"));
  });

  // Feature 6006: Refund. Ops (the owner too). Amount in cents and a required reason; the
  // refund service says no (400 on a field, 409 when nothing is left, 502 when Stripe refuses
  // or cannot be reached -- and then nothing was saved). Answers the fresh job detail, plus the
  // new CN reference for the page's Toast.
  router.post("/:reference/invoice/refund", requireRole(Role.ops), (req: WithReference, res: Response) => {
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
      const body = (req.body ?? {}) as { amount?: unknown; reason?: unknown };
      if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount <= 0) {
        res.status(400).json({ error: REFUND_AMOUNT_ERROR, field: "amount" });
        return;
      }
      const outcome = await makeRefund(client, {
        invoiceId: invoice.id,
        amount: body.amount,
        reason: typeof body.reason === "string" ? body.reason : "",
        byUserId: req.authUser?.id ?? "",
      });
      if (!outcome.ok) {
        const status = {
          amount: 400,
          reason: 400,
          too_much: 400,
          one_payment: 400,
          nothing_left: 409,
          stripe: 502,
          not_set_up: 503,
          not_found: 404,
        }[outcome.kind];
        const field = outcome.kind === "reason" ? "reason" : outcome.kind === "amount" || outcome.kind === "too_much" || outcome.kind === "one_payment" ? "amount" : undefined;
        res.status(status).json({ error: outcome.message, ...(field ? { field } : {}), ...(outcome.left === undefined ? {} : { left: outcome.left }) });
        return;
      }
      const fresh = await loadJob(client, req.params.reference);
      res.json({ ...(await jobDetail(client, fresh ?? job, req.authUser?.id ?? "")), refundReference: outcome.reference });
    })().catch(failWith(res, "POST /api/jobs/:reference/invoice/refund"));
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
      const facts = dispatchFactsOf(job);
      if (req.query["mode"] !== "reschedule") {
        res.json(facts);
        return;
      }
      // Feature 4006: reschedule mode -- the contractor holding the booking is fixed, and the page
      // starts from the booked slot.
      const booking = await client.assignment.findFirst({
        where: { jobId: job.id, status: { in: ["assigned", "accepted"] } },
        orderBy: { dispatchedAt: "desc" },
        include: { contractor: { select: { code: true, name: true } }, calendarEvents: { take: 1 } },
      });
      if ((job.status !== "assigned" && job.status !== "scheduled") || booking === null) {
        res.status(409).json({ error: `The job is ${job.status} -- it cannot be rescheduled.` });
        return;
      }
      const block = booking.calendarEvents[0] ?? null;
      const currentSlot: DispatchFacts["currentSlot"] =
        block === null ? null : slotParts(job.timezone, block.startTime, block.endTime);
      res.json({
        ...facts,
        mode: "reschedule",
        contractor: {
          code: booking.contractor.code,
          name: booking.contractor.name,
          firstName: booking.contractor.name.split(" ")[0] ?? booking.contractor.name,
        },
        currentSlot,
        defaults: currentSlot ?? facts.defaults,
      });
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
        const result = await candidatesAndPriceFor(client, job, parsed.data, req.query["mode"] === "reschedule");
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

  // Feature 4006 -- reschedule: the old booking off and a fresh one to the SAME contractor, in one
  // step; he is asked once, with a new Accept link. The customer hears when he accepts.
  router.post("/:reference/reschedule", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not signed in" });
        return;
      }
      const parsed = parseSlotInput((req.body ?? {}) as Record<string, unknown>);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await dispatchJob(client, req.params.reference, null, parsed.data, new Date(), {
        userId: req.authUser.id,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      await sendRescheduleNotifications(client, result);
      const fresh = await loadJob(client, result.jobReference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json({
        job: await jobDetail(client, fresh, req.authUser.id),
        toast: `${result.jobReference} rescheduled. Waiting for ${result.contractorFirstName}'s answer.`,
      });
    })().catch(failWith(res, "POST /api/jobs/:reference/reschedule"));
  });

  router.post("/:reference/take-off", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not signed in" });
        return;
      }
      const result = await takeOffJob(client, req.params.reference, req.authUser.id);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      const fresh = await loadJob(client, result.jobReference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json({
        job: await jobDetail(client, fresh, req.authUser.id),
        toast: `${result.jobReference} reassigned. It's back in New.`,
      });
    })().catch(failWith(res, "POST /api/jobs/:reference/take-off"));
  });

  // Cancel is Mike's, on the customer's call (Cancellation policy): ops only, which admits the owner.
  router.post("/:reference/cancel", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not signed in" });
        return;
      }
      const parsed = parseCancelInput(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await cancelJob(client, req.params.reference, req.authUser.id, parsed.data);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      const fresh = await loadJob(client, result.jobReference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json({ job: await jobDetail(client, fresh, req.authUser.id), toast: `${result.jobReference} cancelled.` });
    })().catch(failWith(res, "POST /api/jobs/:reference/cancel"));
  });

  // Feature 6004: a callback is a new job linked to this completed one; Mike lands on it.
  router.post("/:reference/callback", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      const parsed = parseCallbackInput(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await raiseCallback(client, req.params.reference, parsed.description);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      res.status(201).json({ jobReference: result.jobReference, toast: `Raised callback ${result.jobReference}.` });
    })().catch(failWith(res, "POST /api/jobs/:reference/callback"));
  });

  // Feature 6004: the contractor attended and could not work. Ops only (which admits the owner).
  router.post("/:reference/no-show", requireRole(Role.ops), (req: WithReference, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not signed in" });
        return;
      }
      const parsed = parseNoShowInput(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const result = await markNoShow(client, req.params.reference, req.authUser.id, parsed.charge);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, field: result.field });
        return;
      }
      const fresh = await loadJob(client, result.jobReference);
      if (!fresh) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json({
        job: await jobDetail(client, fresh, req.authUser.id),
        toast: `Marked ${result.jobReference} as a no-show.`,
      });
    })().catch(failWith(res, "POST /api/jobs/:reference/no-show"));
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
