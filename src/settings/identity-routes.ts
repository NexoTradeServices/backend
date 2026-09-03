// GET /api/identity -- Feature 1014, brand strings go to config.
//
// Public, no session (Foundations / Brand identity, decision 4): the login
// gate shows the wordmark logged out, so this cannot sit behind requireAuth
// the way settingsRoutes does. Answers only { displayName } -- nothing else
// on PlatformSettings is public.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { getCachedDisplayName, setCachedDisplayName } from "./identity-cache.js";

export function identityRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", (_req: Request, res: Response) => {
    void (async () => {
      const cached = getCachedDisplayName();
      if (cached !== null) {
        res.json({ displayName: cached });
        return;
      }

      const settings = await client.platformSettings.findFirst();
      if (settings === null) {
        // No row means the base seed has not run -- degrade like any other
        // outside-service gap (guiding principle 8), never a crash.
        res.status(503).json({ error: "identity unavailable" });
        return;
      }

      setCachedDisplayName(settings.displayName);
      res.json({ displayName: settings.displayName });
    })().catch((error: unknown) => {
      console.error("GET /api/identity failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
