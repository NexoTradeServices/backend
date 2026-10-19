// The invoice email and text -- Feature 6001, invoice at completion.
//
// Notifications / Customer messages. Asked ONCE the invoice has its pay link
// (pay-link.ts), and again by Resend (jobs routes). Both go to the CUSTOMER
// only -- never the site contact. The customer's address is read at SEND time
// by the notification module, so a fixed email is used on a resend.
//
// KEYS. The notification table's key is unique across channels, so each ask
// carries its channel: `invoice:invoice:<id>:email` / `:sms`, and a resend
// `invoice:invoice:<id>:resend-<ms>:email` / `:sms` (one pair per press).
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import type { Prisma } from "../generated/prisma/client.js";
import { billQuestionsPhone } from "./billing.js";
import { formatDate } from "../time/index.js";

type Db = Prisma.TransactionClient;

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export function invoiceKey(invoiceId: string, channel: "email" | "sms", resendAtMs?: number, type = "invoice"): string {
  const discriminator = resendAtMs === undefined ? "" : `:resend-${String(resendAtMs)}`;
  return `${type}:invoice:${invoiceId}${discriminator}:${channel}`;
}

/**
 * Ask for the invoice email and SMS. `resendAtMs` is set only by Resend. An invoice a Correct &
 * reissue made (it has `replacesInvoiceId`) sends the Updated invoice message instead -- and so does
 * a Resend of it, word for word the same.
 */
export async function askInvoiceMessages(db: Db, invoiceId: string, resendAtMs?: number): Promise<void> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      job: { include: { customer: true, serviceType: { select: { trade: true } } } },
      replaces: { select: { reference: true } },
    },
  });
  if (invoice.stripePaymentLinkUrl === null) {
    throw new Error(`invoice ${invoice.reference} has no pay link yet -- its messages cannot go`);
  }
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true, accountsPhone: true } });
  const zone = invoice.job.timezone;
  const gstApplied = invoice.gstApplied && (invoice.gstAmount ?? 0) > 0;

  const context: NotificationContext = {
    invoiceId: invoice.id,
    invoiceReference: invoice.reference,
    jobReference: invoice.job.reference,
    trade: invoice.job.serviceType.trade.toLowerCase(),
    firstName: firstNameOf(invoice.job.customer.name),
    gstApplied,
    dueText: formatDate(zone, invoice.dueAt),
    payUrl: invoice.stripePaymentLinkUrl,
    officePhone: billQuestionsPhone(settings),
    ...(invoice.replaces === null ? {} : { replacesReference: invoice.replaces.reference }),
  };
  const type = invoice.replaces === null ? "invoice" : "invoice_updated";

  for (const channel of ["email", "sms"] as const) {
    await sendNotification(
      {
        type,
        channel,
        recipientType: "customer",
        recipientId: invoice.customerId,
        idempotencyKey: invoiceKey(invoice.id, channel, resendAtMs, type),
        relatedType: "invoice",
        relatedId: invoice.id,
        jobId: invoice.jobId,
        context,
      },
      db,
    );
  }
}

/**
 * Feature 6004: the Callback - no charge email, for a goodwill callback's $0 invoice. Asked in the
 * transaction that issues the invoice (so a rolled-back Complete sends nothing). Email only, the
 * invoice PDF attached by the template; no pay link, no text.
 */
export async function askCallbackNoCharge(db: Db, invoiceId: string): Promise<void> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { job: { include: { customer: true, serviceType: { select: { trade: true } } } } },
  });
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true, accountsPhone: true } });
  await sendNotification(
    {
      type: "callback_no_charge",
      channel: "email",
      recipientType: "customer",
      recipientId: invoice.customerId,
      idempotencyKey: `callback_no_charge:invoice:${invoice.id}:email`,
      relatedType: "invoice",
      relatedId: invoice.id,
      jobId: invoice.jobId,
      context: {
        invoiceId: invoice.id,
        invoiceReference: invoice.reference,
        jobReference: invoice.job.reference,
        trade: invoice.job.serviceType.trade.toLowerCase(),
        firstName: firstNameOf(invoice.job.customer.name),
        officePhone: billQuestionsPhone(settings),
      },
    },
    db,
  );
}
