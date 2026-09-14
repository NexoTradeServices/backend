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
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { listQueue, parseQueueQuery } from "./queue.js";
import { jobDetail, loadJob } from "./detail.js";
import { parseAddressesInput, saveAddresses } from "./addresses.js";
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
