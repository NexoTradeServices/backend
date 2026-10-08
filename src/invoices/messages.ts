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
import { formatDollars } from "../enquiries/money.js";
import { formatLongDate } from "../agreements/pdf.js";

type Db = Prisma.TransactionClient;

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export function invoiceKey(invoiceId: string, channel: "email" | "sms", resendAtMs?: number): string {
  const discriminator = resendAtMs === undefined ? "" : `:resend-${String(resendAtMs)}`;
  return `invoice:invoice:${invoiceId}${discriminator}:${channel}`;
}

/** Ask for the invoice email and SMS. `resendAtMs` is set only by Resend. */
export async function askInvoiceMessages(db: Db, invoiceId: string, resendAtMs?: number): Promise<void> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      job: { include: { customer: true, serviceType: { select: { trade: true } } } },
      assignment: { include: { contractor: { select: { name: true } } } },
    },
  });
  if (invoice.stripePaymentLinkUrl === null) {
    throw new Error(`invoice ${invoice.reference} has no pay link yet -- its messages cannot go`);
  }
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  const zone = invoice.job.timezone;
  const gstApplied = invoice.gstApplied && (invoice.gstAmount ?? 0) > 0;

  const context: NotificationContext = {
    invoiceId: invoice.id,
    invoiceReference: invoice.reference,
    jobReference: invoice.job.reference,
    trade: invoice.job.serviceType.trade.toLowerCase(),
    firstName: firstNameOf(invoice.job.customer.name),
    contractorFirstName: firstNameOf(invoice.assignment.contractor.name),
    workNotes: invoice.assignment.completionNotes ?? "",
    totalText: formatDollars(invoice.amount),
    gstApplied,
    ...(gstApplied ? { gstText: formatDollars(invoice.gstAmount ?? 0) } : {}),
    dueText: formatLongDate(invoice.dueAt, zone),
    payUrl: invoice.stripePaymentLinkUrl,
    officePhone: settings.operatorPhone,
  };

  for (const channel of ["email", "sms"] as const) {
    await sendNotification(
      {
        type: "invoice",
        channel,
        recipientType: "customer",
        recipientId: invoice.customerId,
        idempotencyKey: invoiceKey(invoice.id, channel, resendAtMs),
        relatedType: "invoice",
        relatedId: invoice.id,
        jobId: invoice.jobId,
        context,
      },
      db,
    );
  }
}
