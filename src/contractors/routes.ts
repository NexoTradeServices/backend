// GET/POST/PUT /api/contractors -- Feature 2001, contractor onboarding
// (Mike's path).
//
// Two pages, one form (plan decision 1): /new and /[code] post to the same
// shape here. Required to save = name, email, phone (decision 2); every
// other field is validated only when present, except a trade row, which is
// all-or-nothing. Ready to dispatch (decision 3) is computed by
// ../contractors/ready.ts and returned alongside every contractor so the
// screen only ever renders it.
//
// Access: ops and owner alike (decision 5) -- contractor management is ops
// work, unlike the pricing pen.
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import type { Auth } from "../auth/config.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { nextReference } from "../db/reference.js";
import { readyToDispatch, type ReadyInput } from "./ready.js";
import { parseServiceAreaInput, saveServiceArea, serviceAreaDtoOf } from "./service-area.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

// Only `street` is required. A contractor whose address predates this
// feature's migration keeps just `{ street: <old text> }` (AC12) -- a
// FRESH pick (PlacesField) always sends every field, but an untouched
// legacy row must still round-trip through this SAME whole-object PUT on
// every ordinary Save that never re-touches the address. Discovered by the
// frontend e2e suite against the real dev DB (Bob's migrated row), not by
// the backend suite's throwaway one (its fixtures never carry a legacy
// address, so this gap never exercised there).
interface PlacesAddress {
  street: string;
  suburb?: string;
  state?: string;
  country?: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  // An index signature, not just the named fields, is what makes this
  // structurally assignable to Prisma's InputJsonObject for the Json column
  // (same technique as service-types/routes.ts's ServiceLevelMultipliers).
  [key: string]: string | number | undefined;
}

interface SpecialtyInput {
  trade: string;
  contractorCalloutRate: number;
  contractorStandardRate: number;
  licenceNumber: string;
  licenceExpiry: string; // yyyy-mm-dd
  active: boolean;
}

interface ContractorInput {
  name: string;
  email: string;
  phone: string;
  businessName: string | null;
  abn: string | null;
  gstRegistered: boolean;
  address: PlacesAddress | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  specialties: SpecialtyInput[];
  insurer: string | null;
  insurancePolicyNo: string | null;
  insuranceExpiry: string | null; // yyyy-mm-dd
  payoutBsb: string | null;
  payoutAccountNo: string | null;
  payoutAccountName: string | null;
  active: boolean; // Contractor.status === "active"
}

interface FieldError {
  error: string;
  field?: string;
}

type ParseResult = { ok: true; data: ContractorInput } | { ok: false } & FieldError;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The ATO's own check-digit algorithm (decision 10). */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

function isValidAbn(raw: string): boolean {
  const digits = raw.replace(/\s/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const values = digits.split("").map(Number);
  values[0] = (values[0] ?? 0) - 1;
  const sum = values.reduce((total, digit, index) => total + digit * (ABN_WEIGHTS[index] ?? 0), 0);
  return sum % 89 === 0;
}

function isValidBsb(raw: string): boolean {
  return /^\d{6}$/.test(raw.replace(/[\s-]/g, ""));
}

/**
 * "Not provided at all" and "provided empty/null" both mean no value for an
 * optional field -- only a genuinely wrong-shaped value (a number, an
 * object) is the error case, returned as `undefined`.
 */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isPlacesAddress(value: unknown): value is PlacesAddress {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v["street"] !== "string") return false;
  const optionalString = (key: string): boolean => v[key] === undefined || typeof v[key] === "string";
  const optionalNumber = (key: string): boolean => v[key] === undefined || typeof v[key] === "number";
  return (
    optionalString("suburb") &&
    optionalString("state") &&
    optionalString("country") &&
    optionalString("postcode") &&
    optionalNumber("lat") &&
    optionalNumber("lng") &&
    optionalString("placeId")
  );
}

function parseSpecialty(raw: unknown, index: number): { ok: true; data: SpecialtyInput } | (FieldError & { ok: false }) {
  const prefix = `specialties[${String(index)}]`;
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "each trade row must be an object", field: prefix };
  }
  const r = raw as Record<string, unknown>;
  const trade = r["trade"];
  const callout = r["contractorCalloutRate"];
  const standard = r["contractorStandardRate"];
  const licenceNumber = r["licenceNumber"];
  const licenceExpiry = r["licenceExpiry"];

  const present = [trade, callout, standard, licenceNumber, licenceExpiry];
  const anyFilled = present.some((v) => v !== undefined && v !== null && v !== "");
  const allFilled =
    typeof trade === "string" &&
    trade.trim() !== "" &&
    typeof callout === "number" &&
    typeof standard === "number" &&
    typeof licenceNumber === "string" &&
    licenceNumber.trim() !== "" &&
    typeof licenceExpiry === "string" &&
    licenceExpiry.trim() !== "";

  if (!allFilled) {
    if (!anyFilled) {
      // An entirely empty row never reaches here -- the caller drops it before parsing.
      return { ok: false, error: "a trade row is all or nothing", field: `${prefix}.trade` };
    }
    return {
      ok: false,
      error: "each trade needs all five: trade, both rates, licence number and expiry -- a trade row is all or nothing",
      field: prefix,
    };
  }

  if (!Number.isInteger(callout) || callout < 0) {
    return { ok: false, error: "call-out rate must be a whole number of cents", field: `${prefix}.contractorCalloutRate` };
  }
  if (!Number.isInteger(standard) || standard < 0) {
    return { ok: false, error: "standard rate must be a whole number of cents", field: `${prefix}.contractorStandardRate` };
  }
  if (!DATE_PATTERN.test(licenceExpiry)) {
    return { ok: false, error: "licence expiry must be a date", field: `${prefix}.licenceExpiry` };
  }

  return {
    ok: true,
    data: {
      trade: trade.trim(),
      contractorCalloutRate: callout,
      contractorStandardRate: standard,
      licenceNumber: licenceNumber.trim(),
      licenceExpiry,
      active: r["active"] !== false,
    },
  };
}

function parseContractorInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b["name"] === "string" ? b["name"].trim() : "";
  if (name === "") return { ok: false, error: "Required.", field: "name" };

  const phone = typeof b["phone"] === "string" ? b["phone"].trim() : "";
  if (phone === "") return { ok: false, error: "Required.", field: "phone" };

  const emailRaw = typeof b["email"] === "string" ? b["email"].trim().toLowerCase() : "";
  if (emailRaw === "") return { ok: false, error: "Required.", field: "email" };
  if (!EMAIL_PATTERN.test(emailRaw)) {
    return { ok: false, error: "That does not look like an email address.", field: "email" };
  }

  const businessName = optionalString(b["businessName"]);
  if (businessName === undefined) return { ok: false, error: "invalid business name", field: "businessName" };

  const abn = optionalString(b["abn"]);
  if (abn === undefined) return { ok: false, error: "invalid ABN", field: "abn" };
  if (abn !== null && !isValidAbn(abn)) {
    return { ok: false, error: "An ABN is 11 digits with a valid check digit.", field: "abn" };
  }

  const gstRegistered = b["gstRegistered"] === true;

  let address: PlacesAddress | null = null;
  if (b["address"] !== undefined && b["address"] !== null) {
    if (!isPlacesAddress(b["address"])) {
      return { ok: false, error: "Pick the address from the list, or clear the field.", field: "address" };
    }
    address = b["address"];
  }

  const emergencyContactName = optionalString(b["emergencyContactName"]);
  if (emergencyContactName === undefined) {
    return { ok: false, error: "invalid emergency contact name", field: "emergencyContactName" };
  }
  const emergencyContactPhone = optionalString(b["emergencyContactPhone"]);
  if (emergencyContactPhone === undefined) {
    return { ok: false, error: "invalid emergency contact phone", field: "emergencyContactPhone" };
  }

  const rawSpecialties: unknown[] = Array.isArray(b["specialties"]) ? b["specialties"] : [];
  const specialties: SpecialtyInput[] = [];
  for (let i = 0; i < rawSpecialties.length; i += 1) {
    const raw = rawSpecialties[i];
    // A row with nothing in it at all is simply skipped, not an error -- the
    // frontend always carries one blank starter row on /new.
    if (
      raw !== null &&
      typeof raw === "object" &&
      Object.values(raw as Record<string, unknown>).every((v) => v === undefined || v === null || v === "")
    ) {
      continue;
    }
    const parsed = parseSpecialty(raw, i);
    if (!parsed.ok) return parsed;
    specialties.push(parsed.data);
  }

  const insurer = optionalString(b["insurer"]);
  if (insurer === undefined) return { ok: false, error: "invalid insurer", field: "insurer" };
  const insurancePolicyNo = optionalString(b["insurancePolicyNo"]);
  if (insurancePolicyNo === undefined) return { ok: false, error: "invalid policy number", field: "insurancePolicyNo" };
  const insuranceExpiryRaw = optionalString(b["insuranceExpiry"]);
  if (insuranceExpiryRaw === undefined) return { ok: false, error: "invalid insurance expiry", field: "insuranceExpiry" };
  if (insuranceExpiryRaw !== null && !DATE_PATTERN.test(insuranceExpiryRaw)) {
    return { ok: false, error: "insurance expiry must be a date", field: "insuranceExpiry" };
  }

  const payoutBsb = optionalString(b["payoutBsb"]);
  if (payoutBsb === undefined) return { ok: false, error: "invalid BSB", field: "payoutBsb" };
  if (payoutBsb !== null && !isValidBsb(payoutBsb)) {
    return { ok: false, error: "A BSB is six digits.", field: "payoutBsb" };
  }
  const payoutAccountNo = optionalString(b["payoutAccountNo"]);
  if (payoutAccountNo === undefined) return { ok: false, error: "invalid account number", field: "payoutAccountNo" };
  const payoutAccountName = optionalString(b["payoutAccountName"]);
  if (payoutAccountName === undefined) return { ok: false, error: "invalid account name", field: "payoutAccountName" };

  return {
    ok: true,
    data: {
      name,
      email: emailRaw,
      phone,
      businessName,
      abn,
      gstRegistered,
      address,
      emergencyContactName,
      emergencyContactPhone,
      specialties,
      insurer,
      insurancePolicyNo,
      insuranceExpiry: insuranceExpiryRaw,
      payoutBsb,
      payoutAccountNo,
      payoutAccountName,
      active: b["active"] !== false,
    },
  };
}

/**
 * Decision 2: "Specialty trade is a plain select over ServiceType.trade
 * (1007's catalog -- the dispatch match runs on that name)." Not a format
 * check on the string; it must be a trade that actually exists.
 */
async function unknownTradeField(client: PrismaClient, specialties: SpecialtyInput[]): Promise<FieldError | null> {
  if (specialties.length === 0) return null;
  const known = new Set((await client.serviceType.findMany({ select: { trade: true } })).map((t) => t.trade));
  const index = specialties.findIndex((s) => !known.has(s.trade));
  if (index === -1) return null;
  return { error: `"${specialties[index]?.trade ?? ""}" is not a trade in the catalog`, field: `specialties[${String(index)}].trade` };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

type ContractorWithRelations = Awaited<ReturnType<typeof loadContractor>>;

async function loadContractor(client: PrismaClient, code: string) {
  return client.contractor.findUnique({
    where: { code },
    include: {
      specialties: { orderBy: { trade: "asc" }, include: { statusChangedBy: { select: { name: true } } } },
      statusChangedBy: { select: { name: true } },
      _count: { select: { servedPostcodes: true } },
    },
  });
}

// coreLocation mirrors PlacesAddress minus `street` (schema comment); read
// defensively since it is empty until the service area page (2002) saves it.
function coreLocationSuburbOf(contractor: NonNullable<ContractorWithRelations>): string | null {
  const loc = contractor.coreLocation;
  if (loc && typeof loc === "object" && !Array.isArray(loc) && typeof (loc as Record<string, unknown>)["suburb"] === "string") {
    return (loc as Record<string, unknown>)["suburb"] as string;
  }
  return null;
}

function readyInputOf(contractor: NonNullable<ContractorWithRelations>): ReadyInput {
  return {
    businessName: contractor.businessName,
    abn: contractor.abn,
    status: contractor.status,
    insurer: contractor.insurer,
    insurancePolicyNo: contractor.insurancePolicyNo,
    insuranceExpiry: contractor.insuranceExpiry,
    payoutBsb: contractor.payoutBsb,
    payoutAccountNo: contractor.payoutAccountNo,
    payoutAccountName: contractor.payoutAccountName,
    specialties: contractor.specialties.map((s) => ({ status: s.status, licenceExpiry: s.licenceExpiry })),
    servedPostcodeCount: contractor._count.servedPostcodes,
  };
}

async function toDto(client: PrismaClient, contractor: NonNullable<ContractorWithRelations>) {
  const { ready, missing } = readyToDispatch(readyInputOf(contractor));
  const credential = await client.account.findFirst({
    where: { userId: contractor.userId, providerId: "credential" },
    select: { createdAt: true },
  });
  const lastInvite = await client.notification.findFirst({
    where: { recipientType: "user", recipientId: contractor.userId, type: "contractor_onboarding" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return {
    code: contractor.code,
    name: contractor.name,
    email: contractor.email,
    phone: contractor.phone,
    businessName: contractor.businessName,
    abn: contractor.abn,
    gstRegistered: contractor.gstRegistered,
    address: contractor.address,
    emergencyContactName: contractor.emergencyContactName,
    emergencyContactPhone: contractor.emergencyContactPhone,
    insurer: contractor.insurer,
    insurancePolicyNo: contractor.insurancePolicyNo,
    insuranceExpiry: contractor.insuranceExpiry ? contractor.insuranceExpiry.toISOString().slice(0, 10) : null,
    payoutBsb: contractor.payoutBsb,
    payoutAccountNo: contractor.payoutAccountNo,
    payoutAccountName: contractor.payoutAccountName,
    status: contractor.status,
    statusChangedAt: contractor.statusChangedAt ? contractor.statusChangedAt.toISOString() : null,
    statusChangedByName: contractor.statusChangedBy?.name ?? null,
    createdAt: contractor.createdAt.toISOString(),
    specialties: contractor.specialties.map((s) => ({
      trade: s.trade,
      contractorCalloutRate: s.contractorCalloutRate,
      contractorStandardRate: s.contractorStandardRate,
      licenceNumber: s.licenceNumber,
      licenceExpiry: s.licenceExpiry.toISOString().slice(0, 10),
      status: s.status,
      statusChangedAt: s.statusChangedAt ? s.statusChangedAt.toISOString() : null,
      statusChangedByName: s.statusChangedBy?.name ?? null,
    })),
    servedPostcodeCount: contractor._count.servedPostcodes,
    coreLocationSuburb: coreLocationSuburbOf(contractor),
    ready,
    missing,
    hasCredential: credential !== null,
    credentialSetAt: credential ? credential.createdAt.toISOString() : null,
    lastInviteSentAt: lastInvite ? lastInvite.createdAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function contractorRoutes(client: PrismaClient, auth: Auth): Router {
  const router = createRouter();

  // Trade NAMES only -- not the pricing pen (rates/margins stay owner-only,
  // 1007). Ops needs the list to build the trade-row select (decision 2:
  // "a plain select over ServiceType.trade"); mounted before "/:code" so
  // this literal path is matched first.
  router.get("/trade-options", requireRole(Role.ops), (_req: Request, res: Response) => {
    void (async () => {
      const serviceTypes = await client.serviceType.findMany({
        select: { trade: true },
        orderBy: { trade: "asc" },
      });
      res.json({ trades: serviceTypes.map((s) => s.trade) });
    })().catch((error: unknown) => {
      console.error("GET /api/contractors/trade-options failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.get("/", requireRole(Role.ops), (_req: Request, res: Response) => {
    void (async () => {
      const contractors = await client.contractor.findMany({
        orderBy: { name: "asc" },
        include: {
          specialties: { include: { statusChangedBy: { select: { name: true } } } },
          statusChangedBy: { select: { name: true } },
          _count: { select: { servedPostcodes: true } },
        },
      });
      const dtos = await Promise.all(contractors.map((c) => toDto(client, c)));
      res.json(dtos);
    })().catch((error: unknown) => {
      console.error("GET /api/contractors failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.get("/:code", requireRole(Role.ops), (req: Request<{ code: string }>, res: Response) => {
    void (async () => {
      const contractor = await loadContractor(client, req.params.code);
      if (!contractor) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(await toDto(client, contractor));
    })().catch((error: unknown) => {
      console.error("GET /api/contractors/:code failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.post("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const parsed = parseContractorInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const data = parsed.data;

      const unknownTrade = await unknownTradeField(client, data.specialties);
      if (unknownTrade) {
        res.status(400).json(unknownTrade);
        return;
      }

      const existingUser = await client.user.findUnique({ where: { email: data.email } });
      if (existingUser) {
        res.status(400).json({ error: "This email already has a login", field: "email" });
        return;
      }

      // Decision 6: the User (role contractor, no usable password) is
      // created in the same transaction as the Contractor.
      const code = await nextReference("CON", client);
      const created = await client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: data.name, email: data.email, role: Role.contractor },
        });
        return tx.contractor.create({
          data: {
            code,
            userId: user.id,
            name: data.name,
            email: data.email,
            phone: data.phone,
            businessName: data.businessName,
            abn: data.abn,
            gstRegistered: data.gstRegistered,
            address: data.address ?? undefined,
            emergencyContactName: data.emergencyContactName,
            emergencyContactPhone: data.emergencyContactPhone,
            insurer: data.insurer,
            insurancePolicyNo: data.insurancePolicyNo,
            insuranceExpiry: data.insuranceExpiry ? new Date(data.insuranceExpiry) : null,
            payoutBsb: data.payoutBsb,
            payoutAccountNo: data.payoutAccountNo,
            payoutAccountName: data.payoutAccountName,
            status: "active",
            specialties: {
              create: data.specialties.map((s) => ({
                trade: s.trade,
                contractorCalloutRate: s.contractorCalloutRate,
                contractorStandardRate: s.contractorStandardRate,
                licenceNumber: s.licenceNumber,
                licenceExpiry: new Date(s.licenceExpiry),
                status: "active",
              })),
            },
          },
          include: { specialties: true },
        });
      });

      // The invite: rides Better Auth's own reset-token machinery (decision
      // 6). A step after the transaction, not inside it -- see routes.ts's
      // file header.
      await auth.api.requestPasswordReset({ body: { email: data.email } });

      const full = await loadContractor(client, created.code);
      if (!full) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.status(201).json(await toDto(client, full));
    })().catch((error: unknown) => {
      console.error("POST /api/contractors failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.put("/:code", requireRole(Role.ops), (req: Request<{ code: string }>, res: Response) => {
    void (async () => {
      const existing = await loadContractor(client, req.params.code);
      if (!existing) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const parsed = parseContractorInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const data = parsed.data;

      const unknownTrade = await unknownTradeField(client, data.specialties);
      if (unknownTrade) {
        res.status(400).json(unknownTrade);
        return;
      }

      if (data.email !== existing.email) {
        const collision = await client.user.findFirst({
          where: { email: data.email, id: { not: existing.userId } },
        });
        if (collision) {
          res.status(400).json({ error: "This email already has a login", field: "email" });
          return;
        }
      }

      // Decision 8: a specialty that has ever been on an assignment cannot
      // be removed, only suspended -- a server check plus a test, since no
      // assignments exist yet at 2001.
      const incomingTrades = new Set(data.specialties.map((s) => s.trade));
      const removedWithHistory: string[] = [];
      for (const specialty of existing.specialties) {
        if (incomingTrades.has(specialty.trade)) continue;
        const usedCount = await client.assignment.count({ where: { specialtyId: specialty.id } });
        if (usedCount > 0) removedWithHistory.push(specialty.trade);
      }
      if (removedWithHistory.length > 0) {
        res.status(400).json({
          error: "A trade that has been used on a job cannot be removed -- suspend it instead.",
        });
        return;
      }

      const now = new Date();
      const authUser = req.authUser;

      await client.$transaction(async (tx) => {
        if (data.email !== existing.email) {
          await tx.user.update({ where: { id: existing.userId }, data: { email: data.email, name: data.name } });
        } else if (data.name !== existing.name) {
          await tx.user.update({ where: { id: existing.userId }, data: { name: data.name } });
        }

        const statusChanged = data.active !== (existing.status === "active");

        await tx.contractor.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            email: data.email,
            phone: data.phone,
            businessName: data.businessName,
            abn: data.abn,
            gstRegistered: data.gstRegistered,
            address: data.address ?? undefined,
            emergencyContactName: data.emergencyContactName,
            emergencyContactPhone: data.emergencyContactPhone,
            insurer: data.insurer,
            insurancePolicyNo: data.insurancePolicyNo,
            insuranceExpiry: data.insuranceExpiry ? new Date(data.insuranceExpiry) : null,
            payoutBsb: data.payoutBsb,
            payoutAccountNo: data.payoutAccountNo,
            payoutAccountName: data.payoutAccountName,
            status: data.active ? "active" : "suspended",
            ...(statusChanged
              ? { statusChangedByUserId: authUser?.id ?? null, statusChangedAt: now }
              : {}),
          },
        });

        for (const specialty of data.specialties) {
          const before = existing.specialties.find((s) => s.trade === specialty.trade);
          const specialtyStatusChanged = before !== undefined && before.status === "active" !== specialty.active;
          const payload = {
            contractorCalloutRate: specialty.contractorCalloutRate,
            contractorStandardRate: specialty.contractorStandardRate,
            licenceNumber: specialty.licenceNumber,
            licenceExpiry: new Date(specialty.licenceExpiry),
            status: specialty.active ? ("active" as const) : ("suspended" as const),
            ...(specialtyStatusChanged
              ? { statusChangedByUserId: authUser?.id ?? null, statusChangedAt: now }
              : {}),
          };
          if (before) {
            await tx.contractorSpecialty.update({ where: { id: before.id }, data: payload });
          } else {
            await tx.contractorSpecialty.create({
              data: { ...payload, contractorId: existing.id, trade: specialty.trade },
            });
          }
        }

        for (const specialty of existing.specialties) {
          if (!incomingTrades.has(specialty.trade)) {
            await tx.contractorSpecialty.delete({ where: { id: specialty.id } });
          }
        }
      });

      const full = await loadContractor(client, existing.code);
      if (!full) {
        res.status(500).json({ error: "internal error" });
        return;
      }
      res.json(await toDto(client, full));
    })().catch((error: unknown) => {
      console.error("PUT /api/contractors/:code failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.post(
    "/:code/resend-welcome",
    requireRole(Role.ops),
    (req: Request<{ code: string }>, res: Response) => {
      void (async () => {
        const contractor = await client.contractor.findUnique({ where: { code: req.params.code } });
        if (!contractor) {
          res.status(404).json({ error: "not found" });
          return;
        }
        // AC10: the earlier link no longer works -- Better Auth's own
        // request-password-reset mints a new token but never invalidates an
        // older one, so every prior reset-password Verification row for
        // this user is cleared first.
        await client.verification.deleteMany({
          where: { identifier: { startsWith: "reset-password:" }, value: contractor.userId },
        });
        await auth.api.requestPasswordReset({ body: { email: contractor.email } });
        res.json({ ok: true });
      })().catch((error: unknown) => {
        console.error("POST /api/contractors/:code/resend-welcome failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  // Feature 2002, service area builder: the same shared screen as
  // /api/contractor/service-area, opened by ops (or the owner) against any
  // contractor's code rather than the caller's own session (plan decision 1).
  router.get(
    "/:code/service-area",
    requireRole(Role.ops),
    (req: Request<{ code: string }>, res: Response) => {
      void (async () => {
        const contractor = await client.contractor.findUnique({
          where: { code: req.params.code },
          include: { servedPostcodes: true },
        });
        if (!contractor) {
          res.status(404).json({ error: "not found" });
          return;
        }
        res.json(serviceAreaDtoOf(contractor));
      })().catch((error: unknown) => {
        console.error("GET /api/contractors/:code/service-area failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  router.put(
    "/:code/service-area",
    requireRole(Role.ops),
    (req: Request<{ code: string }>, res: Response) => {
      void (async () => {
        const contractor = await client.contractor.findUnique({ where: { code: req.params.code } });
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
        const full = await client.contractor.findUnique({
          where: { id: contractor.id },
          include: { servedPostcodes: true },
        });
        if (!full) {
          res.status(500).json({ error: "internal error" });
          return;
        }
        res.json(serviceAreaDtoOf(full));
      })().catch((error: unknown) => {
        console.error("PUT /api/contractors/:code/service-area failed", error);
        res.status(500).json({ error: "internal error" });
      });
    },
  );

  return router;
}
