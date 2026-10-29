// Edit the request while the job is `new` -- Feature 4004, pre-dispatch edit.
//
// On the confirming call Mike corrects what the customer got wrong: the trade, the description, the
// preferred date and window, and the suburb (until a site address is set -- then the suburb follows
// the address). A new trade brings that trade's CURRENT rates onto the job (the answers to the old
// trade's questions stay as they are). A new suburb re-freezes the postcode and the zone; the coverage
// tier (3002) follows by itself because it is derived. Nothing is sent to anyone. Once dispatched, the
// details are locked. The location, trade and zone helpers are the shared job-creation ones.
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { PreferredWindow } from "../generated/prisma/enums.js";
import { zoneForState } from "../time/index.js";
import {
  PREFERRED_WINDOWS,
  isNonEmptyString,
  parseDateOnly,
  parseLocation,
  resolveLocation,
  type Location,
  type SuburbPick,
} from "./create.js";

export const LOCKED_MESSAGE = "This job has been dispatched - its details are locked.";
export const SITE_FOLLOWS_MESSAGE = "The suburb follows the job site address.";

export interface RequestEditInput {
  trade?: string;
  description?: string;
  preferredDate?: Date;
  preferredWindow?: PreferredWindow;
  location?: Location | SuburbPick;
}

export type ParsedEdit = { ok: true; data: RequestEditInput } | { ok: false; error: string; field: string };

/** Only the fields that are sent change; each one sent is checked as the enquiry checks it. */
export function parseRequestEdit(body: unknown): ParsedEdit {
  const b = (body ?? {}) as Record<string, unknown>;
  const data: RequestEditInput = {};
  if (b["trade"] !== undefined) {
    if (!isNonEmptyString(b["trade"])) return { ok: false, error: "trade is required", field: "trade" };
    data.trade = b["trade"].trim();
  }
  if (b["description"] !== undefined) {
    if (!isNonEmptyString(b["description"])) return { ok: false, error: "description is required", field: "description" };
    data.description = b["description"].trim();
  }
  if (b["preferredDate"] !== undefined) {
    const date = parseDateOnly(b["preferredDate"]);
    if (date === null) return { ok: false, error: "preferredDate must be a YYYY-MM-DD date", field: "preferredDate" };
    data.preferredDate = date;
  }
  if (b["preferredWindow"] !== undefined) {
    const window = b["preferredWindow"];
    if (typeof window !== "string" || !PREFERRED_WINDOWS.includes(window as PreferredWindow)) {
      return { ok: false, error: "preferredWindow must be morning, afternoon or evening", field: "preferredWindow" };
    }
    data.preferredWindow = window as PreferredWindow;
  }
  if (b["location"] !== undefined) {
    const location = parseLocation(b["location"]);
    if (location === null) return { ok: false, error: "location must be a picked suburb", field: "location" };
    data.location = location;
  }
  return { ok: true, data };
}

function todayIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export type EditOutcome = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string; field?: string };

export async function editRequest(client: PrismaClient, reference: string, input: RequestEditInput): Promise<EditOutcome> {
  const job = await client.job.findUnique({ where: { reference } });
  if (job === null) return { ok: false, status: 404, error: "not found" };
  if (job.status !== "new") return { ok: false, status: 409, error: LOCKED_MESSAGE };

  const data: Prisma.JobUncheckedUpdateInput = {};

  if (input.location !== undefined) {
    if (job.siteAddress !== null) return { ok: false, status: 409, error: SITE_FOLLOWS_MESSAGE, field: "location" };
    const location = await resolveLocation(client, input.location);
    if (location === null) return { ok: false, status: 400, error: "location must be a picked suburb", field: "location" };
    let zone: string;
    try {
      zone = zoneForState(location.state);
    } catch {
      return { ok: false, status: 400, error: `no service zone for state "${location.state}"`, field: "location" };
    }
    data.postcode = location.postcode;
    data.timezone = zone;
    data.serviceLocation = {
      suburb: location.suburb,
      state: location.state,
      country: location.country,
      lat: location.lat,
      lng: location.lng,
      ...(location.placeId === undefined ? {} : { placeId: location.placeId }),
    };
  }

  if (input.trade !== undefined) {
    const serviceType = await client.serviceType.findUnique({ where: { trade: input.trade } });
    if (serviceType === null) return { ok: false, status: 400, error: `no such trade "${input.trade}"`, field: "trade" };
    data.serviceTypeId = serviceType.id;
    data.customerCalloutRate = serviceType.customerCalloutRate;
    data.customerStandardRate = serviceType.customerStandardRate;
  }

  if (input.preferredDate !== undefined) {
    const zone = typeof data.timezone === "string" ? data.timezone : job.timezone;
    if (input.preferredDate.toISOString().slice(0, 10) < todayIn(zone)) {
      return { ok: false, status: 400, error: "preferredDate must not be before today", field: "preferredDate" };
    }
    data.preferredDate = input.preferredDate;
  }
  if (input.preferredWindow !== undefined) data.preferredWindow = input.preferredWindow;
  if (input.description !== undefined) data.description = input.description;

  if (Object.keys(data).length === 0) return { ok: true };

  // The status is part of the write, so a dispatch made while this edit was open is refused, not overwritten.
  const written = await client.job.updateMany({ where: { id: job.id, status: "new" }, data });
  if (written.count === 0) return { ok: false, status: 409, error: LOCKED_MESSAGE };
  return { ok: true };
}
