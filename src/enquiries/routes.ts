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
import type { PreferredWindow } from "../generated/prisma/enums.js";
import { createJob, isNonEmptyString, parseJobFields, resolveLocation, type NewJobInput } from "../jobs/create.js";
import { coverageOf, type CoverageInput } from "../coverage/tier.js";
import { sendNotification } from "../notifications/index.js";
import { enquiriesRefusedForNoKey, verifyRecaptcha, type RecaptchaVerdict } from "./recaptcha.js";
import { isTestRun } from "../test-data/label.js";
import {
  isEnquiryPhotoKey,
  readCloudinaryConfig,
  signEnquiryPhotoUpload,
  type CloudinaryConfig,
} from "../photos/cloudinary.js";

/** Feature 3003: at most this many photos on one enquiry. */
export const MAX_ENQUIRY_PHOTOS = 5;

const WINDOW_LABELS: Record<PreferredWindow, string> = {
  morning: "Morning (7:00-12:00)",
  afternoon: "Afternoon (12:00-17:00)",
  evening: "Evening (17:00-19:00)",
};

/** Feature 3003 AC3: an optional list, at most five, each one of ours with a file name. */
function parsePhotos(value: unknown): { storageKey: string; fileName: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENQUIRY_PHOTOS) return null;
  const photos: { storageKey: string; fileName: string }[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object") return null;
    const p = entry as Record<string, unknown>;
    if (!isNonEmptyString(p["storageKey"]) || !isEnquiryPhotoKey(p["storageKey"].trim())) return null;
    if (!isNonEmptyString(p["fileName"])) return null;
    photos.push({ storageKey: p["storageKey"].trim(), fileName: p["fileName"].trim() });
  }
  return photos;
}

interface EnquiryInput extends NewJobInput {
  recaptchaToken: string | undefined;
}

type ParseResult = { ok: true; data: EnquiryInput } | { ok: false; error: string; field?: string };

/** AC8: every field required except the two marketing checkboxes and the photos. */
function parseEnquiryInput(body: unknown): ParseResult {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  const fields = parseJobFields(b);
  if (!fields.ok) return fields;

  const marketingEmail = b["marketingEmail"];
  const marketingSms = b["marketingSms"];
  if (typeof marketingEmail !== "boolean" || typeof marketingSms !== "boolean") {
    return { ok: false, error: "marketingEmail and marketingSms must be booleans", field: "marketingEmail" };
  }

  const photos = parsePhotos(b["photos"]);
  if (photos === null) {
    return { ok: false, error: "photos must be at most 5 photos uploaded through the form, each with a file name", field: "photos" };
  }

  const recaptchaToken = b["recaptchaToken"];
  if (recaptchaToken !== undefined && typeof recaptchaToken !== "string") {
    return { ok: false, error: "recaptchaToken must be a string when present", field: "recaptchaToken" };
  }

  return { ok: true, data: { ...fields.data, marketingEmail, marketingSms, photos, recaptchaToken } };
}

export interface EnquiryRoutesOptions {
  /** Swappable in tests -- see notifications/providers/registry.ts for the same seam. */
  verifyRecaptcha?: (token: string | undefined) => Promise<RecaptchaVerdict>;
  /** Feature 3003: the Cloudinary settings, or null for "not set up". Same seam, same reason. */
  cloudinaryConfig?: () => CloudinaryConfig | null;
}

export function enquiryRoutes(client: PrismaClient, options: EnquiryRoutesOptions = {}): Router {
  const router = createRouter();
  const checkRecaptcha = options.verifyRecaptcha ?? verifyRecaptcha;
  const cloudinaryConfig = options.cloudinaryConfig ?? readCloudinaryConfig;

  // Feature 3003 AC4: a signed direct upload for the enquiry-photos folder.
  // Public -- Sarah has no login. The API secret never leaves this process;
  // not set up answers 503 and the form turns that into its warning line.
  router.post("/photo-signature", (_req: Request, res: Response) => {
    const config = cloudinaryConfig();
    if (config === null) {
      res.status(503).json({ error: "photo upload is unavailable" });
      return;
    }
    res.json(signEnquiryPhotoUpload(config));
  });

  // Feature 3002: the coverage check behind the suburb step. Public (the form
  // has no login) and it answers the tier only -- the customer never sees a
  // distance or anything about contractors (AC8).
  router.get("/coverage", (req: Request, res: Response) => {
    void (async () => {
      const q = req.query as Record<string, unknown>;
      let input: CoverageInput;
      if (typeof q["suburbId"] === "string" && q["suburbId"].trim() !== "") {
        const location = await resolveLocation(client, { suburbId: q["suburbId"].trim() });
        if (location === null) {
          res.status(404).json({ error: "no such suburb" });
          return;
        }
        input = { postcode: location.postcode, lat: location.lat, lng: location.lng };
      } else {
        const postcode = q["postcode"];
        const lat = typeof q["lat"] === "string" && q["lat"].trim() !== "" ? Number(q["lat"]) : NaN;
        const lng = typeof q["lng"] === "string" && q["lng"].trim() !== "" ? Number(q["lng"]) : NaN;
        if (typeof postcode !== "string" || postcode.trim() === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          res.status(400).json({ error: "send suburbId, or postcode with lat and lng" });
          return;
        }
        input = { postcode: postcode.trim(), lat, lng };
      }
      const { tier } = await coverageOf(client, input);
      res.json({ tier });
    })().catch(() => {
      res.status(500).json({ error: "could not check coverage" });
    });
  });

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
      res.json({ operatorPhone: settings.operatorPhone, takingEnquiries: !enquiriesRefusedForNoKey(), serviceTypes });
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

      // Feature 3006: on the live site with no reCAPTCHA secret nothing is taken --
      // before the check, before any row exists.
      if (enquiriesRefusedForNoKey()) {
        res.status(503).json({ error: "enquiries are not taken online right now", operatorPhone: settings.operatorPhone });
        return;
      }

      // Plan decision 1 (walkthrough-log.md row 49): checked before any
      // Customer or Job row exists. AC7: a confirmed bot refuses outright;
      // human OR unreachable/blocked both let it through identically.
      // Feature 9002: a browser test's request (the test-run signal, which the
      // production server never honours) goes on as a human would -- the live
      // keys on dev would refuse a headless browser as a bot.
      const verdict = isTestRun() ? "human" : await checkRecaptcha(input.recaptchaToken);
      if (verdict === "bot") {
        res.status(403).json({ error: "we could not verify this request automatically", operatorPhone: settings.operatorPhone });
        return;
      }

      // Feature 3005: the road from the filled-in form to a `new` job is the shared service's.
      const created = await createJob(client, "web", input);
      if (!created.ok) {
        res.status(400).json({ error: created.error, field: created.field });
        return;
      }
      const job = created.job;

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
            trade: created.trade,
            suburb: created.suburb,
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
