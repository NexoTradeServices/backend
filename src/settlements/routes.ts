// /api/settlements -- Feature 6003, settlement run. Ops and owner.
//
//   GET  /api/settlements?view=ready|awaiting|upcoming|paid[&after=<cursor>]   the Settlements screen
//   GET  /api/settlements/ready.csv                                            the payout run, approved unpaid only
//   GET  /api/settlements/:ref                                                 one invoice, line by line
//   POST /api/settlements/:ref/mark-paid
//   POST /api/settlements/:ref/rebuild
//   GET  /api/settlements/adjustments/landing?contractorId=  Feature 6007: where a new pay adjustment would land
//   GET  /api/settlements/adjustments/contractors            Feature 6007: who a pay adjustment can be for (the dialog's Dropdown)
//   POST /api/settlements/adjustments                        Feature 6007: add a pay adjustment (Mike)
//
// Each refusal is a 409 with the reason in `error`.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { dayLabel, payDayFor, ymdOf } from "./calendar.js";
import { buildInvoiceView, loadSettlementForView } from "./invoice-view.js";
import { addPayAdjustment, askRebuiltDraft, landingOf } from "./adjustments.js";
import { OPS_VIEWS, listForOps, payoutCsv, type OpsView } from "./lists.js";
import { askDraftEmail, askPayoutSentEmail } from "./messages.js";
import { amountOf, markPaid, rebuild } from "./service.js";

type WithRef = Request<{ ref: string }>;

function failWith(res: Response, route: string) {
  return (error: unknown) => {
    console.error(`${route} failed`, error);
    res.status(500).json({ error: "internal error" });
  };
}

export function settlementRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const raw = req.query["view"];
      const view: OpsView = typeof raw === "string" && (OPS_VIEWS as readonly string[]).includes(raw) ? (raw as OpsView) : "ready";
      const after = typeof req.query["after"] === "string" && req.query["after"] !== "" ? req.query["after"] : null;
      res.json(await listForOps(client, view, after, new Date()));
    })().catch(failWith(res, "GET /api/settlements"));
  });

  // Declared before "/:ref" so "ready.csv" is never read as a reference.
  router.get("/ready.csv", requireRole(Role.ops), (_req: Request, res: Response) => {
    void (async () => {
      const csv = await payoutCsv(client, new Date());
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${csv.fileName}"`);
      // The page fetches the file with its session (cross-origin), so the browser may read the file name only if told.
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.send(csv.content);
    })().catch(failWith(res, "GET /api/settlements/ready.csv"));
  });

  // Declared before "/:ref" so "adjustments" is never read as a reference.
  router.get("/adjustments/contractors", requireRole(Role.ops), (_req: Request, res: Response) => {
    void (async () => {
      const contractors = await client.contractor.findMany({ select: { id: true, code: true, name: true }, orderBy: { name: "asc" } });
      res.json({ contractors: contractors.map((contractor) => ({ ...contractor, firstName: contractor.name.split(" ")[0] ?? contractor.name })) });
    })().catch(failWith(res, "GET /api/settlements/adjustments/contractors"));
  });

  router.get("/adjustments/landing", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const id = req.query["contractorId"];
      const contractor = typeof id === "string" && id !== "" ? await client.contractor.findUnique({ where: { id }, select: { id: true } }) : null;
      if (contractor === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await landingOf(client, contractor.id, new Date()));
    })().catch(failWith(res, "GET /api/settlements/adjustments/landing"));
  });

  router.post("/adjustments", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const now = new Date();
      const result = await addPayAdjustment(
        client,
        { contractorId: body["contractorId"], amount: body["amount"], reason: body["reason"], jobReference: body["job"] },
        req.authUser.id,
        now,
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, ...(result.field === undefined ? {} : { field: result.field }) });
        return;
      }
      await askRebuiltDraft(client, result.draft, now);
      res.status(201).json({ contractorFirstName: result.contractorFirstName, landing: result.landing });
    })().catch(failWith(res, "POST /api/settlements/adjustments"));
  });

  router.get("/:ref", requireRole(Role.ops), (req: WithRef, res: Response) => {
    void (async () => {
      const settlement = await loadSettlementForView(client, { reference: req.params.ref });
      if (settlement === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const settings = await client.platformSettings.findFirstOrThrow();
      const [invoice, paidBy, supersededBy] = await Promise.all([
        buildInvoiceView(client, settlement),
        settlement.paidByUserId === null ? null : client.user.findUnique({ where: { id: settlement.paidByUserId }, select: { name: true } }),
        settlement.supersededByUserId === null ? null : client.user.findUnique({ where: { id: settlement.supersededByUserId }, select: { name: true } }),
      ]);
      res.json({
        invoice,
        contractor: { code: settlement.contractor.code, name: settlement.contractor.name },
        amount: amountOf(settlement, settlement.contractor.gstRegistered, Number(settings.gstRatePercent)),
        payDay: dayLabel(payDayFor(settings, new Date())),
        approvedAt: settlement.approvedAt?.toISOString() ?? null,
        paidAt: settlement.paidAt?.toISOString() ?? null,
        paidBy: paidBy?.name ?? null,
        supersededAt: settlement.supersededAt?.toISOString() ?? null,
        supersededBy: supersededBy?.name ?? null,
        periodEnd: ymdOf(settlement.periodEnd),
      });
    })().catch(failWith(res, "GET /api/settlements/:ref"));
  });

  router.post("/:ref/mark-paid", requireRole(Role.ops), (req: WithRef, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const result = await markPaid(client, req.params.ref, req.authUser.id, new Date());
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      // The payment is saved: a message that cannot be asked is logged, never turned into a failed payment.
      try {
        await askPayoutSentEmail(client, result.id);
      } catch (error: unknown) {
        console.error(`settlements: ${result.reference} was marked paid but its email could not be asked`, error);
      }
      res.json({ reference: result.reference, status: "paid" });
    })().catch(failWith(res, "POST /api/settlements/:ref/mark-paid"));
  });

  router.post("/:ref/rebuild", requireRole(Role.ops), (req: WithRef, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const now = new Date();
      const result = await rebuild(client, req.params.ref, req.authUser.id, now);
      if (!result.ok) {
        res.status(result.status).json(result.body);
        return;
      }
      try {
        await askDraftEmail(client, result.draft, now);
      } catch (error: unknown) {
        console.error(`settlements: ${result.draft.reference} was rebuilt but its email could not be asked`, error);
      }
      res.json({ reference: result.draft.reference, replaced: req.params.ref });
    })().catch(failWith(res, "POST /api/settlements/:ref/rebuild"));
  });

  return router;
}
