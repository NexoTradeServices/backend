// GET/PUT /api/settings -- Feature 1006, admin settings screen.
//
// One row, one form, one Save (plan decision 2): GET reads the whole
// PlatformSettings row, PUT writes the whole row in one call. Both routes
// are owner-only (plan decision 3) -- ops has no access to the pricing pen,
// not even read.
//
// The GST switch carries the one rule with teeth (Invoicing / GST): flipping
// ON while businessAbn is empty is refused server-side, and a flip in either
// direction stamps the audit pair (gstStatusChangedAt/ByUserId) in the same
// write.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role, PayoutCycle, PayoutDay } from "../generated/prisma/enums.js";
import { findProvider } from "../notifications/providers/registry.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SettingsInput {
  gstRegistered: boolean;
  businessAbn: string | null;
  gstRatePercent: number;
  paymentTermsDays: number;
  serviceReachKm: number;
  calloutFee: number;
  returnVisitMinimumMinutes: number;
  maxContractorPartAmount: number;
  operatorPhone: string;
  operatorEmail: string;
  timezone: string;
  payoutCycle: PayoutCycle;
  payoutDay: PayoutDay | null;
  emailProvider: string;
  smsProvider: string;
}

type ParseResult =
  | { ok: true; data: SettingsInput }
  | { ok: false; error: string; field?: string };

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Reads and bounds-checks the whole-row PUT body. No partial updates -- one form, one Save. */
function parseSettingsInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b["gstRegistered"] !== "boolean") {
    return { ok: false, error: "gstRegistered must be a boolean", field: "gstRegistered" };
  }

  const businessAbn = b["businessAbn"];
  if (businessAbn !== null && !isNonEmptyString(businessAbn)) {
    return { ok: false, error: "businessAbn must be a non-empty string or null", field: "businessAbn" };
  }

  if (!isFiniteNumber(b["gstRatePercent"]) || b["gstRatePercent"] < 0 || b["gstRatePercent"] > 100) {
    return { ok: false, error: "gstRatePercent must be a number between 0 and 100", field: "gstRatePercent" };
  }

  if (!Number.isInteger(b["paymentTermsDays"]) || (b["paymentTermsDays"] as number) < 0) {
    return { ok: false, error: "paymentTermsDays must be a non-negative integer", field: "paymentTermsDays" };
  }

  if (!isFiniteNumber(b["serviceReachKm"]) || b["serviceReachKm"] <= 0) {
    return { ok: false, error: "serviceReachKm must be a positive number", field: "serviceReachKm" };
  }

  if (!Number.isInteger(b["calloutFee"]) || (b["calloutFee"] as number) < 0) {
    return { ok: false, error: "calloutFee must be a non-negative integer (cents)", field: "calloutFee" };
  }

  if (!Number.isInteger(b["returnVisitMinimumMinutes"]) || (b["returnVisitMinimumMinutes"] as number) < 0) {
    return {
      ok: false,
      error: "returnVisitMinimumMinutes must be a non-negative integer",
      field: "returnVisitMinimumMinutes",
    };
  }

  if (!Number.isInteger(b["maxContractorPartAmount"]) || (b["maxContractorPartAmount"] as number) < 0) {
    return {
      ok: false,
      error: "maxContractorPartAmount must be a non-negative integer (cents)",
      field: "maxContractorPartAmount",
    };
  }

  const operatorPhone = b["operatorPhone"];
  if (!isNonEmptyString(operatorPhone)) {
    return { ok: false, error: "operatorPhone must be a non-empty string", field: "operatorPhone" };
  }

  const operatorEmail = b["operatorEmail"];
  if (!isNonEmptyString(operatorEmail) || !EMAIL_PATTERN.test(operatorEmail)) {
    return { ok: false, error: "operatorEmail must be a valid email address", field: "operatorEmail" };
  }

  const timezone = b["timezone"];
  if (!isNonEmptyString(timezone) || !isValidTimezone(timezone)) {
    return { ok: false, error: "timezone must be a valid IANA timezone name", field: "timezone" };
  }

  const payoutCycle = b["payoutCycle"];
  if (typeof payoutCycle !== "string" || !Object.values(PayoutCycle).includes(payoutCycle as PayoutCycle)) {
    return { ok: false, error: "payoutCycle must be one of weekly, fortnightly", field: "payoutCycle" };
  }

  const payoutDay = b["payoutDay"];
  if (payoutDay !== null && !Object.values(PayoutDay).includes(payoutDay as PayoutDay)) {
    return { ok: false, error: "payoutDay must be a weekday abbreviation or null", field: "payoutDay" };
  }

  const emailProvider = b["emailProvider"];
  if (!isNonEmptyString(emailProvider) || findProvider(emailProvider, "email") === undefined) {
    return { ok: false, error: "emailProvider names no registered email provider", field: "emailProvider" };
  }

  const smsProvider = b["smsProvider"];
  if (!isNonEmptyString(smsProvider) || findProvider(smsProvider, "sms") === undefined) {
    return { ok: false, error: "smsProvider names no registered sms provider", field: "smsProvider" };
  }

  return {
    ok: true,
    data: {
      gstRegistered: b["gstRegistered"],
      businessAbn,
      gstRatePercent: b["gstRatePercent"],
      paymentTermsDays: b["paymentTermsDays"] as number,
      serviceReachKm: b["serviceReachKm"],
      calloutFee: b["calloutFee"] as number,
      returnVisitMinimumMinutes: b["returnVisitMinimumMinutes"] as number,
      maxContractorPartAmount: b["maxContractorPartAmount"] as number,
      operatorPhone,
      operatorEmail,
      timezone,
      payoutCycle: payoutCycle as PayoutCycle,
      payoutDay: (payoutDay ?? null) as PayoutDay | null,
      emailProvider,
      smsProvider,
    },
  };
}

export function settingsRoutes(client: PrismaClient): Router {
  const router = createRouter();

  router.get("/", requireRole(Role.owner), (_req: Request, res: Response) => {
    void (async () => {
      const settings = await client.platformSettings.findFirstOrThrow({
        include: { gstStatusChangedBy: { select: { id: true, name: true } } },
      });
      res.json({ ...settings, gstRatePercent: settings.gstRatePercent.toString() });
    })().catch((error: unknown) => {
      console.error("GET /api/settings failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.put("/", requireRole(Role.owner), (req: Request, res: Response) => {
    void (async () => {
      const parsed = parseSettingsInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const input = parsed.data;

      // The ABN gate (Invoicing / GST): registered means every invoice must
      // carry the ABN, so it must exist before the switch can flip ON.
      if (input.gstRegistered && (input.businessAbn === null || input.businessAbn.trim() === "")) {
        res
          .status(400)
          .json({ error: "businessAbn is required before gstRegistered can be switched on", field: "businessAbn" });
        return;
      }

      const current = await client.platformSettings.findFirstOrThrow();
      const gstFlipped = current.gstRegistered !== input.gstRegistered;
      const owner = req.authUser;
      if (owner === undefined) {
        // requireRole already refused; unreachable, kept for the type narrow.
        res.status(401).json({ error: "not authenticated" });
        return;
      }

      const updated = await client.platformSettings.update({
        where: { id: current.id },
        data: {
          gstRegistered: input.gstRegistered,
          businessAbn: input.businessAbn,
          gstRatePercent: input.gstRatePercent,
          paymentTermsDays: input.paymentTermsDays,
          serviceReachKm: input.serviceReachKm,
          calloutFee: input.calloutFee,
          returnVisitMinimumMinutes: input.returnVisitMinimumMinutes,
          maxContractorPartAmount: input.maxContractorPartAmount,
          operatorPhone: input.operatorPhone,
          operatorEmail: input.operatorEmail,
          timezone: input.timezone,
          payoutCycle: input.payoutCycle,
          payoutDay: input.payoutDay,
          emailProvider: input.emailProvider,
          smsProvider: input.smsProvider,
          ...(gstFlipped
            ? { gstStatusChangedAt: new Date(), gstStatusChangedByUserId: owner.id }
            : {}),
        },
        include: { gstStatusChangedBy: { select: { id: true, name: true } } },
      });

      res.json({ ...updated, gstRatePercent: updated.gstRatePercent.toString() });
    })().catch((error: unknown) => {
      console.error("PUT /api/settings failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
