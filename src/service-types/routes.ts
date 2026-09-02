// GET/PUT/POST /api/service-types -- Feature 1007, ServiceType catalog screen.
//
// The customer side of every margin: two-tier rates, service-level
// multipliers and the enquiry form's prefilled options. Owner-only, same
// shape as feature 1006's /api/settings (RBAC, whole-object PUT) -- ops has
// no access to the pricing pen, not even read (Data Model / ServiceType).
//
// Decision 1 (plan.md): the normal multiplier is LOCKED at 1.0. The server
// enforces this independently of the frontend's frozen field -- whatever a
// caller sends for `normal` is ignored and 1.0 is always what gets stored.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";

interface ServiceLevelMultipliers {
  normal: number;
  emergency: number;
  weekend: number;
  // An index signature, not just the three named fields, is what makes this
  // structurally assignable to Prisma's InputJsonObject for the Json column.
  [key: string]: number;
}

interface ServiceTypeInput {
  customerCalloutRate: number;
  customerStandardRate: number;
  serviceLevelMultipliers: ServiceLevelMultipliers;
  prefilledFields: string[];
}

type ParseResult =
  | { ok: true; data: ServiceTypeInput }
  | { ok: false; error: string; field?: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Reads and bounds-checks the rates/multipliers/options body shared by PUT and POST. */
function parseServiceTypeInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (!isPositiveInt(b["customerCalloutRate"])) {
    return {
      ok: false,
      error: "customerCalloutRate must be a positive integer (cents)",
      field: "customerCalloutRate",
    };
  }

  if (!isPositiveInt(b["customerStandardRate"])) {
    return {
      ok: false,
      error: "customerStandardRate must be a positive integer (cents)",
      field: "customerStandardRate",
    };
  }

  const multipliers = b["serviceLevelMultipliers"];
  if (multipliers === null || typeof multipliers !== "object") {
    return {
      ok: false,
      error: "serviceLevelMultipliers must be an object",
      field: "serviceLevelMultipliers",
    };
  }
  const m = multipliers as Record<string, unknown>;
  const emergency = m["emergency"];
  const weekend = m["weekend"];
  if (typeof emergency !== "number" || !Number.isFinite(emergency) || emergency < 1) {
    return {
      ok: false,
      error: "serviceLevelMultipliers.emergency must be a number >= 1",
      field: "serviceLevelMultipliers.emergency",
    };
  }
  if (typeof weekend !== "number" || !Number.isFinite(weekend) || weekend < 1) {
    return {
      ok: false,
      error: "serviceLevelMultipliers.weekend must be a number >= 1",
      field: "serviceLevelMultipliers.weekend",
    };
  }

  const prefilledFields = b["prefilledFields"];
  if (prefilledFields !== undefined) {
    if (
      !Array.isArray(prefilledFields) ||
      !prefilledFields.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ) {
      return {
        ok: false,
        error: "prefilledFields must be an array of non-empty strings",
        field: "prefilledFields",
      };
    }
  }

  return {
    ok: true,
    data: {
      customerCalloutRate: b["customerCalloutRate"],
      customerStandardRate: b["customerStandardRate"],
      // Decision 1: normal is never taken from the caller -- it is always 1.0.
      serviceLevelMultipliers: { normal: 1.0, emergency, weekend },
      prefilledFields: (prefilledFields as string[] | undefined) ?? [],
    },
  };
}

export function serviceTypeRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.owner), (_req: Request, res: Response) => {
    void (async () => {
      const serviceTypes = await client.serviceType.findMany({ orderBy: { trade: "asc" } });
      res.json(serviceTypes);
    })().catch((error: unknown) => {
      console.error("GET /api/service-types failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.get("/:id", requireRole(Role.owner), (req: Request<{ id: string }>, res: Response) => {
    void (async () => {
      const serviceType = await client.serviceType.findUnique({ where: { id: req.params.id } });
      if (!serviceType) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(serviceType);
    })().catch((error: unknown) => {
      console.error("GET /api/service-types/:id failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.post("/", requireRole(Role.owner), (req: Request, res: Response) => {
    void (async () => {
      const body = req.body as Record<string, unknown>;
      const trade = body["trade"];
      if (typeof trade !== "string" || trade.trim().length === 0) {
        res.status(400).json({ error: "trade must be a non-empty string", field: "trade" });
        return;
      }

      const parsed = parseServiceTypeInput(body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }

      try {
        const created = await client.serviceType.create({
          data: {
            trade: trade.trim(),
            customerCalloutRate: parsed.data.customerCalloutRate,
            customerStandardRate: parsed.data.customerStandardRate,
            serviceLevelMultipliers: parsed.data.serviceLevelMultipliers,
            prefilledFields: parsed.data.prefilledFields,
          },
        });
        res.status(201).json(created);
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          res.status(400).json({ error: "a trade with this name already exists", field: "trade" });
          return;
        }
        throw error;
      }
    })().catch((error: unknown) => {
      console.error("POST /api/service-types failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.put("/:id", requireRole(Role.owner), (req: Request<{ id: string }>, res: Response) => {
    void (async () => {
      const parsed = parseServiceTypeInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }

      const existing = await client.serviceType.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const updated = await client.serviceType.update({
        where: { id: req.params.id },
        data: {
          customerCalloutRate: parsed.data.customerCalloutRate,
          customerStandardRate: parsed.data.customerStandardRate,
          serviceLevelMultipliers: parsed.data.serviceLevelMultipliers,
          prefilledFields: parsed.data.prefilledFields,
        },
      });
      res.json(updated);
    })().catch((error: unknown) => {
      console.error("PUT /api/service-types/:id failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
