// /api/refunds -- Feature 6006, refunds.
//
// Behind requireRole("ops"), which admits the owner too; Bob and every other role get nothing.
//   GET /api/refunds?page=2                the Refunds list, newest first, 50 a page
//   GET /api/refunds/:reference/credit-note  the credit note PDF, composed on the spot
// Making a refund is a job action: POST /api/jobs/:reference/invoice/refund (jobs/routes.ts).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { buildCreditNotePdf } from "./credit-note.js";
import { listRefunds } from "./list.js";

function fail(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function refundRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
      if (settings === null) {
        res.status(503).json({ error: "Refunds are unavailable right now" });
        return;
      }
      const raw = req.query["page"];
      const asked = typeof raw === "string" ? Number.parseInt(raw, 10) : 1;
      res.json(await listRefunds(client, settings.timezone, Number.isInteger(asked) ? asked : 1));
    })().catch(fail(res, "GET /api/refunds"));
  });

  router.get("/:reference/credit-note", requireRole(Role.ops), (req: Request<{ reference: string }>, res: Response) => {
    void (async () => {
      const refund = await client.refund.findUnique({ where: { reference: req.params.reference }, select: { id: true } });
      if (refund === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const note = await buildCreditNotePdf(client, refund.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${note.fileName}"`);
      res.send(Buffer.from(note.content));
    })().catch(fail(res, "GET /api/refunds/:reference/credit-note"));
  });

  return router;
}
