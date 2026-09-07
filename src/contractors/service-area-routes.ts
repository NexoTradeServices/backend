// GET/PUT /api/contractor/service-area -- Feature 2002, service area
// builder. The contractor's OWN screen: the contractor comes from the
// session, never the URL (plan decision 1) -- Priya can never load or save
// Bob's area through this door, whatever code she guesses.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { parseServiceAreaInput, saveServiceArea, serviceAreaDtoOf } from "./service-area.js";

async function loadOwnContractor(client: PrismaClient, userId: string) {
  return client.contractor.findUnique({
    where: { userId },
    include: { servedPostcodes: true },
  });
}

export function contractorServiceAreaRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/service-area", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const contractor = await loadOwnContractor(client, req.authUser.id);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(serviceAreaDtoOf(contractor));
    })().catch((error: unknown) => {
      console.error("GET /api/contractor/service-area failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.put("/service-area", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      if (!req.authUser) {
        res.status(401).json({ error: "not authenticated" });
        return;
      }
      const contractor = await loadOwnContractor(client, req.authUser.id);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const parsed = parseServiceAreaInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const saved = await saveServiceArea(client, contractor.id, parsed.data);
      if (!saved.ok) {
        res.status(400).json({ error: saved.error, field: saved.field });
        return;
      }
      const full = await loadOwnContractor(client, req.authUser.id);
      if (!full) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json(serviceAreaDtoOf(full));
    })().catch((error: unknown) => {
      console.error("PUT /api/contractor/service-area failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
