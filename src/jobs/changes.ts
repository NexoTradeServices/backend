// Take off and cancel -- Feature 4006, reschedule / take off / cancel.
//
// Operations Admin Workflow / Ops job actions; Cancellation policy. Mike's two ways of ending a
// booked job's current plan: TAKE OFF (the design's Reassign) frees the contractor and puts the job
// back to New; CANCEL (on the customer's call only) closes the job with a reason. Each is one
// transaction; the messages are asked AFTER commit, so a refused change sends nothing (the 4002
// pattern). Reschedule lives with dispatch (dispatch.ts) because it books through the same guards.
import type { PrismaClient } from "../db/client.js";
import { CapabilityTokenType, revokeByJob } from "../capability-tokens/index.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationChannel, NotificationContext } from "../notifications/index.js";
import { formatSlotLabel } from "../time/index.js";
import { cancelBooking } from "./booking.js";
import { asSiteContact } from "./site-contact.js";
import { effectiveAddress, suburbOf } from "./shared.js";

export const MAX_CANCEL_NOTE = 500;

/** The reasons Mike may pick on Cancel job -- no-show is its own action (6005). */
export const CANCEL_REASONS = ["customer_changed_mind", "no_coverage", "duplicate", "price", "other"] as const;

export type Failure = { ok: false; status: number; error: string; field?: string };

class Refused extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error);
  }
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

const jobFactsInclude = {
  customer: { select: { id: true, name: true, billingAddress: true } },
  serviceType: { select: { trade: true } },
} as const;

/** Lock the job, then read the booking that is in play (assigned or accepted). */
async function lockJobAndBooking(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  reference: string,
) {
  const found = await tx.job.findUnique({ where: { reference }, select: { id: true } });
  if (found === null) throw new Refused({ ok: false, status: 404, error: "not found" });
  await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${found.id} FOR UPDATE`;
  const job = await tx.job.findUniqueOrThrow({ where: { id: found.id }, include: jobFactsInclude });
  const booking = await tx.assignment.findFirst({
    where: { jobId: job.id, status: { in: ["assigned", "accepted"] } },
    orderBy: { dispatchedAt: "desc" },
    include: { contractor: { select: { id: true, name: true } } },
  });
  return { job, booking };
}

// ---------------------------------------------------------------------------
// Take off
// ---------------------------------------------------------------------------

export interface TakeOffSuccess {
  ok: true;
  jobReference: string;
  contractorFirstName: string;
}

export async function takeOffJob(
  client: PrismaClient,
  reference: string,
  userId: string,
  now: Date = new Date(),
): Promise<TakeOffSuccess | Failure> {
  try {
    const facts = await client.$transaction(async (tx) => {
      const { job, booking } = await lockJobAndBooking(tx, reference);
      if ((job.status !== "assigned" && job.status !== "scheduled") || booking === null) {
        throw new Refused({ ok: false, status: 409, error: `The job is ${job.status} -- there is no booking to take off.` });
      }
      await cancelBooking(tx, booking.id, userId, now);
      await tx.job.update({ where: { id: job.id }, data: { status: "new" } });
      return { job, booking };
    });

    const { job, booking } = facts;
    const address = effectiveAddress(job);
    const slot = booking.confirmedSlot ?? booking.proposedSlot;
    const context: NotificationContext = {
      firstName: firstNameOf(booking.contractor.name),
      jobReference: job.reference,
      street: address?.street ?? "",
      suburb: address?.suburb ?? suburbOf(job.serviceLocation),
      slotLabel: slot === null ? "the booked time" : formatSlotLabel(job.timezone, slot, now),
    };
    for (const channel of ["email", "sms"] as const) {
      await sendNotification(
        {
          type: "taken_off",
          channel,
          recipientType: "contractor",
          recipientId: booking.contractor.id,
          idempotencyKey: `taken_off:assignment:${booking.id}:${channel}`,
          relatedType: "assignment",
          relatedId: booking.id,
          jobId: job.id,
          context,
        },
        client,
      );
    }
    return { ok: true, jobReference: job.reference, contractorFirstName: firstNameOf(booking.contractor.name) };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelInput {
  reason: (typeof CANCEL_REASONS)[number];
  note: string | null;
}

export function parseCancelInput(body: unknown): { ok: true; data: CancelInput } | Failure {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const reason = raw["reason"];
  if (reason === "customer_no_show") {
    return { ok: false, status: 400, error: "No-show is its own action.", field: "reason" };
  }
  if (typeof reason !== "string" || !(CANCEL_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, status: 400, error: "Required.", field: "reason" };
  }
  const noteRaw = raw["note"];
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string") {
    return { ok: false, status: 400, error: "note must be text", field: "note" };
  }
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
  if (note.length > MAX_CANCEL_NOTE) {
    return { ok: false, status: 400, error: `A note is at most ${String(MAX_CANCEL_NOTE)} characters.`, field: "note" };
  }
  if (reason === "other" && note === "") {
    return { ok: false, status: 400, error: "Required.", field: "note" };
  }
  return { ok: true, data: { reason: reason as CancelInput["reason"], note: note === "" ? null : note } };
}

export interface CancelSuccess {
  ok: true;
  jobReference: string;
}

export async function cancelJob(
  client: PrismaClient,
  reference: string,
  userId: string,
  input: CancelInput,
  now: Date = new Date(),
): Promise<CancelSuccess | Failure> {
  try {
    const facts = await client.$transaction(async (tx) => {
      const { job, booking } = await lockJobAndBooking(tx, reference);
      if (job.status !== "new" && job.status !== "assigned" && job.status !== "scheduled") {
        const error =
          job.status === "cancelled"
            ? "The job is already cancelled."
            : "Work has started - cancel is for before work starts.";
        throw new Refused({ ok: false, status: 409, error });
      }
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: "cancelled",
          cancelReason: input.reason,
          cancelNote: input.note,
          cancelledByUserId: userId,
          cancelledAt: now,
        },
      });
      if (booking !== null) await cancelBooking(tx, booking.id, userId, now);
      await revokeByJob(tx, job.id, [CapabilityTokenType.track], now);
      return { job, booking, wasScheduled: job.status === "scheduled" };
    });

    await askCancelMessages(client, facts, input, now);
    return { ok: true, jobReference: facts.job.reference };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

async function askCancelMessages(
  client: PrismaClient,
  facts: {
    job: Awaited<ReturnType<typeof lockJobAndBooking>>["job"];
    booking: Awaited<ReturnType<typeof lockJobAndBooking>>["booking"];
    wasScheduled: boolean;
  },
  input: CancelInput,
  now: Date,
): Promise<void> {
  const { job, booking, wasScheduled } = facts;
  const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
  const address = effectiveAddress(job);
  const street = address?.street ?? "";
  const suburb = address?.suburb ?? suburbOf(job.serviceLocation);
  const bookedSlot = wasScheduled && booking !== null ? (booking.confirmedSlot ?? booking.proposedSlot) : null;
  const slotLabel = bookedSlot === null ? "" : formatSlotLabel(job.timezone, bookedSlot, now);
  const where = street === "" ? (suburb === "" ? "" : ` at ${suburb}`) : ` at ${street}, ${suburb}`;
  const slotPart = bookedSlot === null ? where : `${where} on ${slotLabel}`;
  const officePhone = settings?.operatorPhone ?? "";

  const ask = async (
    type: string,
    channel: NotificationChannel,
    audience: "customer" | "site_contact" | "contractor",
    recipientId: string,
    context: NotificationContext,
  ): Promise<void> => {
    await sendNotification(
      {
        type,
        channel,
        recipientType: audience,
        recipientId,
        idempotencyKey: `${type}:job:${job.id}:${audience}:${channel}`,
        relatedType: "job",
        relatedId: job.id,
        jobId: job.id,
        context,
      },
      client,
    );
  };

  // The customer: two wordings, none for a duplicate (the other job stands).
  if (input.reason !== "duplicate") {
    const context: NotificationContext = {
      audience: "customer",
      wording: input.reason === "no_coverage" ? "sorry_no_cover" : "as_you_asked",
      firstName: firstNameOf(job.customer.name),
      jobReference: job.reference,
      trade: job.serviceType.trade,
      street,
      suburb,
      slotLabel,
      slotPart,
      officePhone,
    };
    for (const channel of ["email", "sms"] as const) {
      await ask("job_cancelled", channel, "customer", job.customer.id, context);
    }
  }

  // The site contact: only when the job was booked (she was told about the visit) and the cancel
  // is not a duplicate (the other job stands, so nobody customer-side hears -- the dialog says so);
  // the text always, the email only when she gave one -- in her own wording.
  const siteContact = asSiteContact(job.siteContact);
  if (wasScheduled && siteContact !== null && input.reason !== "duplicate") {
    const context: NotificationContext = {
      audience: "site_contact",
      firstName: firstNameOf(siteContact.name),
      recipientName: siteContact.name,
      jobReference: job.reference,
      trade: job.serviceType.trade,
      street,
      suburb,
      slotLabel,
    };
    await ask("job_cancelled", "sms", "site_contact", job.id, context);
    if (siteContact.email !== null && siteContact.email.trim() !== "") {
      await ask("job_cancelled", "email", "site_contact", job.id, context);
    }
  }

  // The contractor holding a booking, answered or not (his Accept link is dead now).
  if (booking !== null) {
    const held = booking.confirmedSlot ?? booking.proposedSlot;
    const context: NotificationContext = {
      firstName: firstNameOf(booking.contractor.name),
      jobReference: job.reference,
      street,
      suburb,
      slotLabel: held === null ? "the booked time" : formatSlotLabel(job.timezone, held, now),
    };
    for (const channel of ["email", "sms"] as const) {
      await ask("job_cancelled_contractor", channel, "contractor", booking.contractor.id, context);
    }
  }
}
