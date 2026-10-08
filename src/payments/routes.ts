// /api/receivables -- Feature 6002, Stripe payment and receivables.
//
// Behind requireRole("ops"), which admits the owner too.
//   GET /api/receivables            every invoice still owed: count, total, the first 50
//   GET /api/receivables?after=...  the next 50
//   GET /api/receivables?limit=120  the first 120 at once -- the page's refresh re-reads every row it shows
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { RECEIVABLES_PAGE, decodeCursor, listReceivables } from "./receivables.js";

const MAX_LIMIT = 500;

function limitOf(raw: unknown): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : RECEIVABLES_PAGE;
}

export function receivablesRoutes(client: PrismaClient): Router {
  const router = createRouter();
  router.get("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
      if (settings === null) {
        res.status(503).json({ error: "Receivables are unavailable right now" });
        return;
      }
      res.json(await listReceivables(client, settings.timezone, { after: decodeCursor(req.query["after"]), limit: limitOf(req.query["limit"]) }));
    })().catch((error: unknown) => {
      console.error("GET /api/receivables failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });
  return router;
}
