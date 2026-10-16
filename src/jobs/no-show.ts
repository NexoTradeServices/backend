// Mark no-show -- Feature 6004, callbacks and no-shows.
//
// Ops job actions / Mark no-show: the contractor attended and could not work -- nobody home, or
// turned away at the door. The job closes as a customer no-show, the contractor is paid the
// call-out every time, and the customer is invoiced the call-out unless Mike waives it. One
// transaction; the Missed visit messages are asked AFTER commit (waived: at once; charged: by the
// pay-link pass, once the invoice has its link). The contractor, the site contact and the office
// inbox are sent nothing.
import type { PrismaClient } from "../db/client.js";
import { CapabilityTokenType, revokeByJob } from "../capability-tokens/index.js";
import { issueCalloutInvoice } from "../invoices/issue.js";
import { kickPayLink } from "../invoices/pay-link.js";
import { askMissedVisit } from "../invoices/missed-visit.js";
import { formatDate } from "../time/index.js";
import { cancelBooking } from "./booking.js";

export type Failure = { ok: false; status: number; error: string; field?: string };

class Refused extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error);
  }
}

export function parseNoShowInput(body: unknown): { ok: true; charge: boolean } | Failure {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof raw["charge"] !== "boolean") {
    return { ok: false, status: 400, error: "charge must be true or false", field: "charge" };
  }
  return { ok: true, charge: raw["charge"] };
}

export interface NoShowSuccess {
  ok: true;
  jobReference: string;
}

export async function markNoShow(
  client: PrismaClient,
  reference: string,
  userId: string,
  charge: boolean,
  now: Date = new Date(),
): Promise<NoShowSuccess | Failure> {
  try {
    const done = await client.$transaction(async (tx) => {
      const found = await tx.job.findUnique({ where: { reference }, select: { id: true } });
      if (found === null) throw new Refused({ ok: false, status: 404, error: "not found" });
      await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${found.id} FOR UPDATE`;
      const job = await tx.job.findUniqueOrThrow({ where: { id: found.id } });
      const booking = await tx.assignment.findFirst({
        where: { jobId: job.id, status: { in: ["accepted", "in_progress"] } },
        orderBy: { dispatchedAt: "desc" },
      });
      if ((job.status !== "scheduled" && job.status !== "in_progress") || booking === null) {
        throw new Refused({
          ok: false,
          status: 409,
          error: `The job is ${job.status} -- a no-show is marked on a booked job.`,
        });
      }
      const settings = await tx.platformSettings.findFirstOrThrow({ select: { calloutFee: true, timezone: true } });
      await tx.job.update({
        where: { id: job.id },
        data: { status: "cancelled", cancelReason: "customer_no_show", cancelledByUserId: userId, cancelledAt: now },
      });
      await cancelBooking(tx, booking.id, userId, now);
      await tx.assignment.update({ where: { id: booking.id }, data: { contractorPay: settings.calloutFee } });
      await revokeByJob(tx, job.id, [CapabilityTokenType.track], now);
      // A call-out fee of $0 has nothing to invoice: it reads as waived.
      const invoice =
        charge && settings.calloutFee > 0
          ? await issueCalloutInvoice(tx, {
              assignmentId: booking.id,
              dateText: formatDate(settings.timezone, now),
              now,
            })
          : null;
      return { jobReference: job.reference, jobId: job.id, invoiceId: invoice?.id ?? null };
    });

    if (done.invoiceId === null) {
      await client.$transaction((tx) => askMissedVisit(tx, done.jobId, null));
    } else {
      // The normal case goes out within seconds; if Stripe does not answer, the loop keeps asking.
      kickPayLink(client, done.invoiceId);
    }
    return { ok: true, jobReference: done.jobReference };
  } catch (error: unknown) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}
