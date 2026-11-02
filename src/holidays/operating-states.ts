// GET /api/operating-states -- Feature 1021. Ops and owner: the open states, for the new contractor form's
// Operating state Select. Open states only; the form adds the contractor's own state on the record if it has closed.
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { openStates } from "./missing.js";

export function operatingStatesRoutes(client: PrismaClient): Router {
  const router = createRouter();
  router.get("/", requireRole(Role.ops), (_req: Request, res: Response) => {
    void (async () => {
      res.json({ states: await openStates(client) });
    })().catch((error: unknown) => {
      console.error("GET /api/operating-states failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });
  return router;
}
