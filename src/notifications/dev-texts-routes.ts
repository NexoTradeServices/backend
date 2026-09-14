// GET /api/dev/texts -- Feature 4002, plan decision 13.
//
// The interim Texts sent page: no login (owner, 12/09/26: the site is not
// public yet), in dev and production alike, reached by typing the address.
// Retired by BKLG-028 once ClickSend is set up.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { loadDevTextBlocks } from "./dev-texts.js";

export function devTextsRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/texts", (_req: Request, res: Response) => {
    void (async () => {
      res.json({ blocks: await loadDevTextBlocks(client) });
    })().catch((error: unknown) => {
      console.error("GET /api/dev/texts failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
