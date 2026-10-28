// One job-creation service -- Feature 3005, phone-taken job intake.
//
// The road from a filled-in enquiry to a `new` Job Mike can act on, shared by the public form
// (source web, POST /api/enquiries) and Mike's Phone intake (source phone, POST /api/jobs/phone):
// location resolve, trade lookup, service zone, Customer find-or-create by email (guest by default,
// never overwriting a name or phone already on file), the Job row with the rate snapshot frozen at
// the unmultiplied card, optional photos and marketing consent, and the Enquiry received email.
// The caller supplies `source`; everything that is the form's own (reCAPTCHA, the ops
// new-job-request email) stays with the form's route.
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { PreferredWindow } from "../generated/prisma/enums.js";
import { nextReference } from "../db/reference.js";
import { zoneForState, isWeekend } from "../time/index.js";
import { sendNotification } from "../notifications/index.js";
import { formatDollars } from "../enquiries/money.js";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PREFERRED_WINDOWS: readonly PreferredWindow[] = ["morning", "afternoon", "evening"];


export interface Location {
  suburb: string;
  state: string;
  country: string;
  postcode: string;
  lat: number;
  lng: number;
  /** Absent when the suburb came from our own list (Feature 3006, Places down). */
  placeId?: string;
}

/** Feature 3006: the suburb picked from the platform's own list instead of Places. */
export interface SuburbPick {
  suburbId: string;
}


export function isNonEmptyString(value: unknown): value is string {
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

function parseLocation(value: unknown): Location | SuburbPick | null {
  if (value === null || typeof value !== "object") return null;
  const l = value as Record<string, unknown>;
  // Feature 3006: either the Places pick below, or just the id of one of our own suburbs.
  if (isNonEmptyString(l["suburbId"])) return { suburbId: l["suburbId"].trim() };
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


/** The stored location for a pick: the Places pick as it came, or the Suburb row's own values (no placeId). */
export async function resolveLocation(client: PrismaClient, pick: Location | SuburbPick): Promise<Location | null> {
  if (!("suburbId" in pick)) return pick;
  const row = await client.suburb.findUnique({ where: { id: pick.suburbId } });
  if (row === null) return null;
  return {
    suburb: row.name,
    state: row.state,
    country: "AU",
    postcode: row.postcode,
    lat: row.centroidLat,
    lng: row.centroidLng,
  };
}



/** The job fields the form and the phone page share. Photos, marketing ticks and reCAPTCHA belong to the form. */
export interface JobFields {
  name: string;
  email: string;
  phone: string;
  /** Feature 1017: optional; empty becomes null. */
  businessName: string | null;
  location: Location | SuburbPick;
  trade: string;
  selectedOptions: string[];
  preferredDate: string;
  preferredWindow: PreferredWindow;
  description: string;
}

export interface NewJobInput extends JobFields {
  marketingEmail: boolean;
  marketingSms: boolean;
  photos: { storageKey: string; fileName: string }[];
}

export type FieldsResult = { ok: true; data: JobFields } | { ok: false; error: string; field?: string };

/** Every field required except the business name; the first one wrong is named. */
export function parseJobFields(b: Record<string, unknown>): FieldsResult {
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

  const rawBusinessName = b["businessName"];
  if (rawBusinessName !== undefined && rawBusinessName !== null && typeof rawBusinessName !== "string") {
    return { ok: false, error: "businessName must be a string when present", field: "businessName" };
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
  if (typeof preferredWindow !== "string" || !PREFERRED_WINDOWS.includes(preferredWindow as PreferredWindow)) {
    return { ok: false, error: "preferredWindow must be morning, afternoon or evening", field: "preferredWindow" };
  }

  if (!isNonEmptyString(b["description"])) {
    return { ok: false, error: "description is required", field: "description" };
  }

  return {
    ok: true,
    data: {
      name: b["name"].trim(),
      email: email.trim().toLowerCase(),
      phone: b["phone"].trim(),
      businessName: typeof rawBusinessName === "string" && rawBusinessName.trim() !== "" ? rawBusinessName.trim() : null,
      location,
      trade: b["trade"].trim(),
      selectedOptions: selectedOptions.map((entry) => entry.trim()),
      preferredDate: preferredDate.toISOString(),
      preferredWindow: preferredWindow as PreferredWindow,
      description: b["description"].trim(),
    },
  };
}

export interface CreatedJob {
  job: { id: string; reference: string; customerId: string };
  trade: string;
  suburb: string;
}

export type CreateResult = ({ ok: true } & CreatedJob) | { ok: false; error: string; field: string };

export async function createJob(
  client: PrismaClient,
  source: "web" | "phone",
  input: JobFields & Partial<Pick<NewJobInput, "marketingEmail" | "marketingSms" | "photos">>,
): Promise<CreateResult> {
  const location = await resolveLocation(client, input.location);
  if (location === null) return { ok: false, error: "location must be a picked suburb", field: "location" };

  const serviceType = await client.serviceType.findUnique({ where: { trade: input.trade } });
  if (serviceType === null) return { ok: false, error: `no such trade "${input.trade}"`, field: "trade" };

  let zone: string;
  try {
    zone = zoneForState(location.state);
  } catch {
    return { ok: false, error: `no service zone for state "${location.state}"`, field: "location" };
  }

  const preferredDateValue = new Date(input.preferredDate);
  // BKLG-020: the job stores the unmultiplied rate card (Invoicing / Two-tier pricing -- "rate
  // snapshots"). Which price list applies is settled now; whether it is a weekend job is only settled
  // at dispatch (Feature 4002), so the multiplier is never baked in here -- only computed, below, for
  // the confirmation email's own wording.
  const multipliers = serviceType.serviceLevelMultipliers as { normal: number; weekend: number };
  const multiplier = isWeekend(zone, preferredDateValue) ? multipliers.weekend : multipliers.normal;
  const displayCalloutRate = Math.round(serviceType.customerCalloutRate * multiplier);
  const displayStandardRate = Math.round(serviceType.customerStandardRate * multiplier);
  const photos = input.photos ?? [];

  const job = await client.$transaction(async (tx) => {
    // Find-or-create by email, guest by default -- never overwriting an existing row's name or phone.
    const existingCustomer = await tx.customer.findUnique({ where: { email: input.email } });
    const customer =
      existingCustomer ??
      (await tx.customer.create({
        data: {
          code: await nextReference("CUS", tx),
          name: input.name,
          email: input.email,
          phone: input.phone,
          businessName: input.businessName,
        },
      }));

    const createdJob = await tx.job.create({
      data: {
        reference: await nextReference("JOB", tx),
        customerId: customer.id,
        serviceTypeId: serviceType.id,
        customerCalloutRate: serviceType.customerCalloutRate,
        customerStandardRate: serviceType.customerStandardRate,
        postcode: location.postcode,
        serviceLocation: {
          suburb: location.suburb,
          state: location.state,
          country: location.country,
          lat: location.lat,
          lng: location.lng,
          ...(location.placeId === undefined ? {} : { placeId: location.placeId }),
        },
        timezone: zone,
        description: input.description,
        selectedOptions: input.selectedOptions,
        source,
        preferredWindow: input.preferredWindow,
        preferredDate: preferredDateValue,
      },
    });

    if (photos.length > 0) {
      await tx.attachment.createMany({
        data: photos.map((photo) => ({
          jobId: createdJob.id,
          assignmentId: null,
          uploadedByRole: "customer" as const,
          storageKey: photo.storageKey,
          fileName: photo.fileName,
        })),
      });
    }

    if (input.marketingEmail === true || input.marketingSms === true) {
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          marketingConsent: {
            email: input.marketingEmail === true,
            sms: input.marketingSms === true,
            optedInAt: new Date().toISOString(),
            source: "enquiry_form",
          } satisfies Prisma.InputJsonValue,
        },
      });
    }

    return createdJob;
  });

  // BKLG-020, AC39: the job's frozen base card is never what a message quotes -- the price for THIS
  // job's date (a message stating a price computes it the way the invoice will).
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
        calloutRate: formatDollars(displayCalloutRate),
        standardRate: formatDollars(displayStandardRate),
      },
    },
    client,
  );

  return { ok: true, job: { id: job.id, reference: job.reference, customerId: job.customerId }, trade: serviceType.trade, suburb: location.suburb };
}
