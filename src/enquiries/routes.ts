// GET /api/enquiries/form-data, POST /api/enquiries -- Feature 3001,
// enquiry form to job created.
//
// Public, unauthenticated -- Sarah has no account and wants none (Customer /
// Guest by default, account by invitation). The whole road from "Request a
// job" to a JOB row Mike can act on: reCAPTCHA gate, silent guest Customer
// (find-or-create by email, never overwriting a name/phone already on
// file), Job creation with the rate snapshot frozen at the normal or
// weekend multiplier, and the two notification sends (AC1-AC7, AC9, AC11).
import type { Router } from "express";
import { Router as createRouter } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { PreferredWindow } from "../generated/prisma/enums.js";
import { nextReference } from "../db/reference.js";
import { zoneForState, isWeekend } from "../time/index.js";
import { sendNotification } from "../notifications/index.js";
import { formatDollars } from "./money.js";
import { verifyRecaptcha, type RecaptchaVerdict } from "./recaptcha.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFERRED_WINDOWS: readonly PreferredWindow[] = ["morning", "afternoon", "evening"];

const WINDOW_LABELS: Record<PreferredWindow, string> = {
  morning: "Morning (7:00-12:00)",
  afternoon: "Afternoon (12:00-17:00)",
  evening: "Evening (17:00-20:00)",
};

interface Location {
  suburb: string;
  state: string;
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  placeId: string;
}

interface EnquiryInput {
  name: string;
  email: string;
  phone: string;
  location: Location;
  trade: string;
  selectedOptions: string[];
  preferredDate: string;
  preferredWindow: PreferredWindow;
  description: string;
  marketingEmail: boolean;
  marketingSms: boolean;
  recaptchaToken: string | undefined;
}

type ParseResult = { ok: true; data: EnquiryInput } | { ok: false; error: string; field?: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

/** `preferredDate` is a plain calendar date -- YYYY-MM-DD, no time, no zone. */
function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLocation(value: unknown): Location | null {
  if (value === null || typeof value !== "object") return null;
  const l = value as Record<string, unknown>;
  if (
    !isNonEmptyString(l["suburb"]) ||
    !isNonEmptyString(l["state"]) ||
    !isNonEmptyString(l["country"]) ||
    !isNonEmptyString(l["postcode"]) ||
    !isFiniteNumber(l["lat"]) ||
    !isFiniteNumber(l["lng"]) ||
    !isNonEmptyString(l["placeId"])
  ) {
    return null;
  }
  return {
    suburb: l["suburb"],
    state: l["state"],
    country: l["country"],
    postcode: l["postcode"],
    lat: l["lat"],
    lng: l["lng"],
    placeId: l["placeId"],
  };
}

/** AC8: every field required except the two marketing checkboxes. */
function parseEnquiryInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b["name"])) {
    return { ok: false, error: "name is required", field: "name" };
  }
  const email = b["email"];
  if (!isNonEmptyString(email) || !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "email must be a valid email address", field: "email" };
  }
  if (!isNonEmptyString(b["phone"])) {
    return { ok: false, error: "phone is required", field: "phone" };
  }

  const location = parseLocation(b["location"]);
  if (location === null) {
    return { ok: false, error: "location must be a picked suburb", field: "location" };
  }

  if (!isNonEmptyString(b["trade"])) {
    return { ok: false, error: "trade is required", field: "trade" };
  }

  const selectedOptions = b["selectedOptions"];
  if (!isStringArray(selectedOptions)) {
    return { ok: false, error: "selectedOptions must be an array of strings", field: "selectedOptions" };
  }

  const preferredDate = parseDateOnly(b["preferredDate"]);
  if (preferredDate === null) {
    return { ok: false, error: "preferredDate must be a YYYY-MM-DD date", field: "preferredDate" };
  }

  const preferredWindow = b["preferredWindow"];
  if (
    typeof preferredWindow !== "string" ||
    !PREFERRED_WINDOWS.includes(preferredWindow as PreferredWindow)
  ) {
    return { ok: false, error: "preferredWindow must be morning, afternoon or evening", field: "preferredWindow" };
  }

  if (!isNonEmptyString(b["description"])) {
    return { ok: false, error: "description is required", field: "description" };
  }

  const marketingEmail = b["marketingEmail"];
  const marketingSms = b["marketingSms"];
  if (typeof marketingEmail !== "boolean" || typeof marketingSms !== "boolean") {
    return { ok: false, error: "marketingEmail and marketingSms must be booleans", field: "marketingEmail" };
  }

  const recaptchaToken = b["recaptchaToken"];
  if (recaptchaToken !== undefined && typeof recaptchaToken !== "string") {
    return { ok: false, error: "recaptchaToken must be a string when present", field: "recaptchaToken" };
  }

  return {
    ok: true,
    data: {
      name: b["name"].trim(),
      email: email.trim().toLowerCase(),
      phone: b["phone"].trim(),
      location,
      trade: b["trade"].trim(),
      selectedOptions: selectedOptions.map((entry) => entry.trim()),
      preferredDate: preferredDate.toISOString(),
      preferredWindow: preferredWindow as PreferredWindow,
      description: b["description"].trim(),
      marketingEmail,
      marketingSms,
      recaptchaToken,
    },
  };
}

export interface EnquiryRoutesOptions {
  /** Swappable in tests -- see notifications/providers/registry.ts for the same seam. */
  verifyRecaptcha?: (token: string | undefined) => Promise<RecaptchaVerdict>;
}

export function enquiryRoutes(client: PrismaClient, options: EnquiryRoutesOptions = {}): Router {
  const router = createRouter();
  const checkRecaptcha = options.verifyRecaptcha ?? verifyRecaptcha;

  router.get("/form-data", (_req: Request, res: Response) => {
    void (async () => {
      const settings = await client.platformSettings.findFirst();
      if (settings === null) {
        res.status(503).json({ error: "form data unavailable" });
        return;
      }
      const serviceTypes = await client.serviceType.findMany({
        orderBy: { trade: "asc" },
        select: {
          id: true,
          trade: true,
          slug: true,
          customerCalloutRate: true,
          customerStandardRate: true,
          serviceLevelMultipliers: true,
          prefilledFields: true,
        },
      });
      res.json({ operatorPhone: settings.operatorPhone, serviceTypes });
    })().catch((error: unknown) => {
      console.error("GET /api/enquiries/form-data failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  router.post("/", (req: Request, res: Response) => {
    void (async () => {
      const parsed = parseEnquiryInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, field: parsed.field });
        return;
      }
      const input = parsed.data;

      const settings = await client.platformSettings.findFirst();
      if (settings === null) {
        res.status(503).json({ error: "enquiries are unavailable right now" });
        return;
      }

      // Plan decision 1 (walkthrough-log.md row 49): checked before any
      // Customer or Job row exists. AC7: a confirmed bot refuses outright;
      // human OR unreachable/blocked both let it through identically.
      const verdict = await checkRecaptcha(input.recaptchaToken);
      if (verdict === "bot") {
        res.status(403).json({ error: "we could not verify this request automatically", operatorPhone: settings.operatorPhone });
        return;
      }

      const serviceType = await client.serviceType.findUnique({ where: { trade: input.trade } });
      if (serviceType === null) {
        res.status(400).json({ error: `no such trade "${input.trade}"`, field: "trade" });
        return;
      }

      let zone: string;
      try {
        zone = zoneForState(input.location.state);
      } catch {
        res.status(400).json({ error: `no service zone for state "${input.location.state}"`, field: "location" });
        return;
      }

      const preferredDateValue = new Date(input.preferredDate);
      const multipliers = serviceType.serviceLevelMultipliers as { normal: number; weekend: number };
      const weekend = isWeekend(zone, preferredDateValue);
      const multiplier = weekend ? multipliers.weekend : multipliers.normal;
      const customerCalloutRate = Math.round(serviceType.customerCalloutRate * multiplier);
      const customerStandardRate = Math.round(serviceType.customerStandardRate * multiplier);

      const job = await client.$transaction(async (tx) => {
        // Find-or-create by email, guest by default -- never overwriting an
        // existing row's name or phone (AC1, AC3; Guest by default).
        const existingCustomer = await tx.customer.findUnique({ where: { email: input.email } });
        const customer =
          existingCustomer ??
          (await tx.customer.create({
            data: {
              code: await nextReference("CUS", tx),
              name: input.name,
              email: input.email,
              phone: input.phone,
            },
          }));

        const createdJob = await tx.job.create({
          data: {
            reference: await nextReference("JOB", tx),
            customerId: customer.id,
            serviceTypeId: serviceType.id,
            customerCalloutRate,
            customerStandardRate,
            postcode: input.location.postcode,
            serviceLocation: {
              suburb: input.location.suburb,
              state: input.location.state,
              country: input.location.country,
              lat: input.location.lat,
              lng: input.location.lng,
              placeId: input.location.placeId,
            },
            timezone: zone,
            description: input.description,
            selectedOptions: input.selectedOptions,
            source: "web",
            preferredWindow: input.preferredWindow,
            preferredDate: preferredDateValue,
          },
        });

        if (input.marketingEmail || input.marketingSms) {
          await tx.customer.update({
            where: { id: customer.id },
            data: {
              marketingConsent: {
                email: input.marketingEmail,
                sms: input.marketingSms,
                optedInAt: new Date().toISOString(),
                source: "enquiry_form",
              } satisfies Prisma.InputJsonValue,
            },
          });
        }

        return createdJob;
      });

      // AC5: quotes the rates just frozen on the job, never re-read live.
      await sendNotification(
        {
          type: "enquiry_confirmation",
          channel: "email",
          recipientType: "customer",
          recipientId: job.customerId,
          idempotencyKey: `enquiry_confirmation:job:${job.id}`,
          relatedType: "job",
          relatedId: job.id,
          jobId: job.id,
          context: {
            name: input.name,
            jobReference: job.reference,
            calloutRate: formatDollars(customerCalloutRate),
            standardRate: formatDollars(customerStandardRate),
          },
        },
        client,
      );

      // AC6: addressed from PlatformSettings.operatorEmail by the email
      // channel (BKLG-004) -- recipientId is unused there, the job id is
      // handed in as the nearest meaningful pointer. Feature 4001, plan
      // decision 10: the link to the job page is the environment's web
      // origin plus the path. The process refuses to boot without
      // WEB_ORIGIN (index.ts); were it ever missing here, the template's own
      // missing-variable rule fails this one row, never the enquiry.
      const webOrigin = process.env["WEB_ORIGIN"];
      await sendNotification(
        {
          type: "new_job_request",
          channel: "email",
          recipientType: "ops",
          recipientId: job.id,
          idempotencyKey: `new_job_request:job:${job.id}`,
          relatedType: "job",
          relatedId: job.id,
          jobId: job.id,
          context: {
            jobReference: job.reference,
            trade: serviceType.trade,
            suburb: input.location.suburb,
            preferredDate: input.preferredDate.slice(0, 10),
            preferredWindow: WINDOW_LABELS[input.preferredWindow],
            ...(webOrigin ? { jobUrl: `${webOrigin}/ops/jobs/${job.reference}` } : {}),
          },
        },
        client,
      );

      res.status(201).json({ reference: job.reference });
    })().catch((error: unknown) => {
      console.error("POST /api/enquiries failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });

  return router;
}
