// The refund emails -- Feature 6006, refunds.
//
// Notifications / Customer messages (Refund issued) and Transactional messages (Refund
// failed, Refund made in Stripe). Email only. The customer's is asked from inside the refund
// service's transaction, keyed by the Refund, so it can never send twice:
// `refund_issued:refund:<id>:email`. The two office notices go to the shared ops inbox
// (PlatformSettings.operatorEmail) and are keyed so Stripe repeating itself sends nothing more:
// `refund_failed:refund:<id>:email`, `refund_made_in_stripe:payment:<stripe refund id>:email`.
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import type { Prisma } from "../generated/prisma/client.js";
import { methodWords } from "../payments/messages.js";
import { dollars } from "./money.js";

type Db = Prisma.TransactionClient;

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

async function contextOf(db: Db, refundId: string): Promise<{ context: NotificationContext; customerId: string; jobId: string }> {
  const refund = await db.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { invoice: { include: { job: { include: { customer: true } } } }, payment: true },
  });
  const invoice = refund.invoice;
  const method = refund.payment?.method ?? null;
  const webOrigin = process.env["WEB_ORIGIN"];
  return {
    customerId: invoice.customerId,
    jobId: invoice.jobId,
    context: {
      refundId: refund.id,
      refundReference: refund.reference,
      firstName: firstNameOf(invoice.job.customer.name),
      customerName: invoice.job.customer.name,
      invoiceReference: invoice.reference,
      jobReference: invoice.job.reference,
      amountText: dollars(refund.amount),
      paidText: dollars(refund.payment?.amount ?? invoice.amount),
      methodText: methodWords(method),
      byCard: method === "card",
      reason: refund.reason,
      ...(webOrigin ? { jobUrl: `${webOrigin}/ops/jobs/${invoice.job.reference}` } : {}),
    },
  };
}

/** The customer's Refund issued email; the template attaches the credit note at send time. */
export async function askRefundIssued(db: Db, refundId: string): Promise<void> {
  const { context, customerId, jobId } = await contextOf(db, refundId);
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  await sendNotification(
    {
      type: "refund_issued",
      channel: "email",
      recipientType: "customer",
      recipientId: customerId,
      idempotencyKey: `refund_issued:refund:${refundId}:email`,
      relatedType: "refund",
      relatedId: refundId,
      jobId,
      context: { ...context, officePhone: settings.operatorPhone },
    },
    db,
  );
}

/** The office's "Refund failed" notice, once per refund. */
export async function askRefundFailed(db: Db, refundId: string): Promise<void> {
  const { context, jobId } = await contextOf(db, refundId);
  await sendNotification(
    {
      type: "refund_failed",
      channel: "email",
      recipientType: "ops",
      recipientId: refundId,
      idempotencyKey: `refund_failed:refund:${refundId}:email`,
      relatedType: "refund",
      relatedId: refundId,
      jobId,
      context,
    },
    db,
  );
}

/** The office's "Refund made in Stripe" notice, once per Stripe refund id. */
export async function askRefundMadeInStripe(db: Db, input: { paymentId: string; stripeRefundId: string; amount: number }): Promise<void> {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    include: { invoice: { include: { job: { include: { customer: true } } } } },
  });
  const webOrigin = process.env["WEB_ORIGIN"];
  await sendNotification(
    {
      type: "refund_made_in_stripe",
      channel: "email",
      recipientType: "ops",
      recipientId: payment.id,
      idempotencyKey: `refund_made_in_stripe:payment:${input.stripeRefundId}:email`,
      relatedType: "payment",
      relatedId: payment.id,
      jobId: payment.invoice.jobId,
      context: {
        customerName: payment.invoice.job.customer.name,
        invoiceReference: payment.invoice.reference,
        jobReference: payment.invoice.job.reference,
        amountText: dollars(input.amount),
        ...(webOrigin ? { jobUrl: `${webOrigin}/ops/jobs/${payment.invoice.job.reference}` } : {}),
      },
    },
    db,
  );
}
