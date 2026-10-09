// /api/contractor/settlements -- Feature 6003, settlement run. The contractor's own.
//
//   GET /api/contractor/settlements[?after=<cursor>]   next payout + his invoices (never a superseded one)
//   GET /api/contractor/settlements/:ref               one of his invoices, line by line; another's is a 404
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { dayLabel, payDayFor } from "./calendar.js";
import { buildInvoiceView, loadSettlementForView } from "./invoice-view.js";
import { listForContractor } from "./lists.js";

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function contractorSettlementRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      const contractor = req.authUser ? await client.contractor.findUnique({ where: { userId: req.authUser.id }, select: { id: true } }) : null;
      if (contractor === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const after = typeof req.query["after"] === "string" && req.query["after"] !== "" ? req.query["after"] : null;
      res.json(await listForContractor(client, contractor.id, after, new Date()));
    })().catch(failWith(res, "GET /api/contractor/settlements"));
  });

  router.get("/:ref", requireRole(Role.contractor), (req: Request<{ ref: string }>, res: Response) => {
    void (async () => {
      const contractor = req.authUser ? await client.contractor.findUnique({ where: { userId: req.authUser.id }, select: { id: true } }) : null;
      const settlement = contractor === null ? null : await loadSettlementForView(client, { reference: req.params.ref });
      // His own only, and never a superseded one: anything else reads as not found.
      if (contractor === null || settlement === null || settlement.contractor.id !== contractor.id || settlement.status === "superseded") {
        res.status(404).json({ error: "not found" });
        return;
      }
      const settings = await client.platformSettings.findFirstOrThrow();
      res.json({
        invoice: await buildInvoiceView(client, settlement),
        payDay: dayLabel(payDayFor(settings, new Date())),
        paidLabel: settlement.paidAt === null ? null : settlement.paidAt.toISOString(),
      });
    })().catch(failWith(res, "GET /api/contractor/settlements/:ref"));
  });

  return router;
}
