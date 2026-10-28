// GET /api/status -- Feature 6012, the service status page.
//
// Ops and the owner only (requireRole(ops) admits the owner too). Runs the five backend checks in
// parallel, live, every time it is asked, and writes nothing anywhere. Google Places is the
// browser's own key, so the page checks that row itself.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import { Role } from "../generated/prisma/enums.js";
import { requireRole } from "../auth/middleware.js";
import { runStatusChecks } from "./checks.js";

export function statusRoutes(): Router {
  const router = createRouter();
  router.get("/", requireRole(Role.ops), (_req: Request, res: Response) => {
    runStatusChecks()
      .then((services) => res.json({ services }))
      .catch((error: unknown) => {
        console.error("GET /api/status failed", error);
        res.status(500).json({ error: "internal error" });
      });
  });
  return router;
}
