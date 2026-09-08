// GET /api/suburbs/in-range -- Feature 2002, service area builder, plan
// decision 3. Any logged-in role: the pin-and-radius fill is a plain read
// over reference data, nothing role-specific about it.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { inRangeSuburbs } from "./in-range.js";

const VALID_KM = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);

function parseCoordinate(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function suburbRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/in-range", requireAuth, (req: Request, res: Response) => {
    void (async () => {
      const lat = parseCoordinate(req.query["lat"]);
      const lng = parseCoordinate(req.query["lng"]);
      if (lat === null || lng === null) {
        res.status(400).json({ error: "lat and lng are required numbers" });
        return;
      }

      const kmRaw = typeof req.query["km"] === "string" ? Number(req.query["km"]) : NaN;
      if (!VALID_KM.has(kmRaw)) {
        res.status(400).json({ error: "km must be 5-60 in steps of 5" });
        return;
      }

      const postcodes = await inRangeSuburbs(client, { lat, lng, km: kmRaw });
      res.json(postcodes);
    })().catch((error: unknown) => {
      console.error("GET /api/suburbs/in-range failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
