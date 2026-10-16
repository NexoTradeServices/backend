// The Missed visit messages -- Feature 6004, callbacks and no-shows.
//
// Notifications / Customer messages. Asked by Mark no-show (waived: right after the commit) and by
// the pay-link pass (charged: once the call-out invoice has its link, in place of the ordinary
// invoice message). Customer only; one pair per job, ever.
import type { Prisma } from "../generated/prisma/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import { formatDate } from "../time/index.js";
import { billQuestionsPhone } from "./billing.js";

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

/** `missed_visit:job:<id>:<channel>` -- one pair per job, ever. */
export function missedVisitKey(jobId: string, channel: "email" | "sms"): string {
  return `missed_visit:job:${jobId}:${channel}`;
}

type Db = Prisma.TransactionClient;

/**
 * Ask the Missed visit email and text. Waived: no invoice. Charged: the invoice and its pay link
 * (the pay-link pass calls this in place of the ordinary invoice message).
 */
export async function askMissedVisit(db: Db, jobId: string, invoiceId: string | null): Promise<void> {
  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { customer: true, serviceType: { select: { trade: true } } },
  });
  const settings = await db.platformSettings.findFirstOrThrow({
    select: { operatorPhone: true, accountsPhone: true, timezone: true },
  });
  const invoice = invoiceId === null ? null : await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice !== null && invoice.stripePaymentLinkUrl === null) {
    throw new Error(`invoice ${invoice.reference} has no pay link yet -- its messages cannot go`);
  }
  const missedOn = job.cancelledAt ?? new Date();
  const base: NotificationContext = {
    jobReference: job.reference,
    trade: job.serviceType.trade.toLowerCase(),
    firstName: firstNameOf(job.customer.name),
    dateText: formatDate(settings.timezone, missedOn),
    waived: invoice === null,
  };
  const context: NotificationContext =
    invoice === null
      ? { ...base, officePhone: settings.operatorPhone }
      : {
          ...base,
          invoiceId: invoice.id,
          invoiceReference: invoice.reference,
          dueText: formatDate(job.timezone, invoice.dueAt),
          payUrl: invoice.stripePaymentLinkUrl ?? "",
          officePhone: billQuestionsPhone(settings),
        };
  for (const channel of ["email", "sms"] as const) {
    await sendNotification(
      {
        type: "missed_visit",
        channel,
        recipientType: "customer",
        recipientId: job.customerId,
        idempotencyKey: missedVisitKey(job.id, channel),
        relatedType: invoice === null ? "job" : "invoice",
        relatedId: invoice === null ? job.id : invoice.id,
        jobId: job.id,
        context,
      },
      db,
    );
  }
}

