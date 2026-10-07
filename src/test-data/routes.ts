// POST /api/test-data/sweep -- Feature 9002.
//
// Lets the browser tests clear their own label from wherever they run (the dev
// machine, CI). Mounted only when NODE_ENV is not production -- absent, not
// merely refused (index.ts); the sweep itself refuses production as well.
import type { Express, Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { isProduction, isValidLabel } from "./label.js";
import { sweepTestData } from "./sweep.js";

export function testDataRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.post("/sweep", (req: Request, res: Response) => {
    void (async () => {
      const label = (req.body as { label?: unknown } | undefined)?.label;
      if (!isValidLabel(label)) {
        res.status(400).json({ error: "label must be a short lowercase word such as e2e or uat-9002" });
        return;
      }
      res.json(await sweepTestData(client, label));
    })().catch((error: unknown) => {
      console.error("POST /api/test-data/sweep failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "internal error" });
    });
  });

  return router;
}

/** Mounts the sweep route -- and only outside production: there it is absent, not refused. */
export function mountTestDataRoutes(app: Express, client: PrismaClient): void {
  if (isProduction()) return;
  app.use("/api/test-data", testDataRoutes(client));
}
