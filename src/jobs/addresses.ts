// The Addresses card's one Save -- Feature 4001, ops job queue and job
// detail.
//
// Operations Admin Workflow / The job queue and the job page: two addresses
// via Places, one Save for both. The billing address is the customer's own
// (Customer.billingAddress, every future invoice); the job site belongs to
// this job only (Job.siteAddress). Plan decision 6: "the job is at the
// billing address" is never stored - ticked, the save COPIES the billing
// address onto the job. On a job that is `new` at save time, any site pick
// moves Job.postcode and Job.serviceLocation to the pick (4001-V9, review
// finding RVW1.2 - the design's rule over decision 7's "postcode differs");
// Job.timezone is never touched. Once dispatched the site is frozen (Ops
// job actions - Edit): a save that would change it is refused whole,
// nothing written, and a billing change first writes the OLD billing
// address onto the customer's jobs past new that have no site of their own,
// so no job already out ever moves (4001-V8, review finding RVW1.1).
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { asAddress, sameAddress, suburbOf, type Address } from "./shared.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** AC18: a structured pick or nothing -- a missing postcode, lat/lng or placeId is typed text, never stored. */
export function parsePick(value: unknown): Address | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const street = v["street"];
  const suburb = v["suburb"];
  const state = v["state"];
  const country = v["country"];
  const postcode = v["postcode"];
  const lat = v["lat"];
  const lng = v["lng"];
  const placeId = v["placeId"];
  if (
    !isNonEmptyString(street) ||
    !isNonEmptyString(suburb) ||
    !isNonEmptyString(state) ||
    !isNonEmptyString(country) ||
    !isNonEmptyString(postcode) ||
    !isFiniteNumber(lat) ||
    !isFiniteNumber(lng) ||
    !isNonEmptyString(placeId)
  ) {
    return null;
  }
  return { street, suburb, state, country, postcode, lat, lng, placeId };
}

export type SiteInput = { sameAsBilling: true } | { sameAsBilling: false; address: Address | null };

export interface AddressesInput {
  /** undefined = leave the customer's billing address as it is. */
  billing: Address | undefined;
  /** undefined = leave the job site as it is. */
  site: SiteInput | undefined;
}

export type AddressFailure = { ok: false; status: number; error: string; field?: string };

const PICK_ERROR = "Pick the address from the list, or clear the field.";

export function parseAddressesInput(body: unknown): { ok: true; data: AddressesInput } | AddressFailure {
  if (body === null || typeof body !== "object") {
    return { ok: false, status: 400, error: "request body must be an object" };
  }
  const b = body as Record<string, unknown>;

  let billing: Address | undefined;
  if (b["billingAddress"] !== undefined && b["billingAddress"] !== null) {
    const pick = parsePick(b["billingAddress"]);
    if (!pick) return { ok: false, status: 400, error: PICK_ERROR, field: "billingAddress" };
    billing = pick;
  }

  let site: SiteInput | undefined;
  const rawSite = b["site"];
  if (rawSite !== undefined && rawSite !== null) {
    if (typeof rawSite !== "object") return { ok: false, status: 400, error: "site must be an object", field: "siteAddress" };
    const s = rawSite as Record<string, unknown>;
    if (s["sameAsBilling"] === true) {
      site = { sameAsBilling: true };
    } else if (s["sameAsBilling"] === false) {
      if (s["address"] === undefined || s["address"] === null) {
        site = { sameAsBilling: false, address: null };
      } else {
        const pick = parsePick(s["address"]);
        if (!pick) return { ok: false, status: 400, error: PICK_ERROR, field: "siteAddress" };
        site = { sameAsBilling: false, address: pick };
      }
    } else {
      return { ok: false, status: 400, error: "site.sameAsBilling must be true or false", field: "siteAddress" };
    }
  }

  return { ok: true, data: { billing, site } };
}

export interface SaveOutcome {
  ok: true;
  /** Set when the street moved the job (plan decision 7): "Joondalup 6027" -> "Fremantle 6160". */
  moved: { from: string; to: string } | null;
}

class Refused extends Error {
  constructor(readonly failure: AddressFailure) {
    super(failure.error);
  }
}

export async function saveAddresses(
  client: PrismaClient,
  jobId: string,
  input: AddressesInput,
): Promise<SaveOutcome | AddressFailure> {
  try {
    return await client.$transaction(async (tx) => {
      // The status is read under the row lock, at save time (plan decision 7).
      await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId} FOR UPDATE`;
      const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, include: { customer: true } });
      const billingOnFile = asAddress(job.customer.billingAddress);
      const billingAfter = input.billing ?? billingOnFile;
      const siteNow = asAddress(job.siteAddress);

      let siteAfter = siteNow;
      if (input.site !== undefined) {
        siteAfter = input.site.sameAsBilling ? billingAfter : input.site.address;
      }
      const siteChanges = !sameAddress(siteAfter, siteNow);

      if (siteChanges && job.status !== "new") {
        throw new Refused({
          ok: false,
          status: 409,
          error: "The job site is locked once the job is dispatched.",
          field: "siteAddress",
        });
      }

      // V8: a job past new with no site of its own is at the billing address
      // it was dispatched against. Before the billing changes, that address
      // is written onto each such job of the customer's -- this one included
      // -- so the change never moves a job already with a contractor.
      if (input.billing !== undefined && billingOnFile !== null && !sameAddress(input.billing, billingOnFile)) {
        await tx.job.updateMany({
          where: { customerId: job.customerId, status: { not: "new" }, siteAddress: { equals: Prisma.AnyNull } },
          data: { siteAddress: { ...billingOnFile } },
        });
      }

      if (input.billing !== undefined) {
        await tx.customer.update({ where: { id: job.customerId }, data: { billingAddress: input.billing } });
      }

      let moved: SaveOutcome["moved"] = null;
      if (siteChanges) {
        // The job is new here (a change on any other status was refused
        // above): any pick moves the job to the street -- the street is
        // where the van goes (V9).
        const streetWins = siteAfter !== null;
        await tx.job.update({
          where: { id: job.id },
          data: {
            // A copy, never a reference: a later billing change never moves
            // an old job's site (plan decision 6).
            siteAddress: siteAfter === null ? Prisma.JsonNull : { ...siteAfter },
            ...(streetWins && siteAfter !== null
              ? {
                  postcode: siteAfter.postcode,
                  serviceLocation: {
                    suburb: siteAfter.suburb,
                    state: siteAfter.state,
                    country: siteAfter.country,
                    lat: siteAfter.lat,
                    lng: siteAfter.lng,
                    placeId: siteAfter.placeId,
                  },
                }
              : {}),
          },
        });
        if (
          siteAfter !== null &&
          (siteAfter.suburb !== suburbOf(job.serviceLocation) || siteAfter.postcode !== job.postcode)
        ) {
          moved = {
            from: `${suburbOf(job.serviceLocation)} ${job.postcode}`,
            to: `${siteAfter.suburb} ${siteAfter.postcode}`,
          };
        }
      }

      return { ok: true, moved } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}
