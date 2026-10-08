// The payment emails -- Feature 6002, Stripe payment and receivables.
//
// Notifications / Customer messages (Payment receipt) and Transactional messages
// (the two office notices). Email only. Asked from inside the paid step's
// transaction (paid.ts), keyed by the Payment, so a payment repeated by Stripe can
// never send twice: `payment_receipt:payment:<id>:email`,
// `payment_received:payment:<id>:email`, `payment_closed_invoice:payment:<id>:email`.
// The office's two go to the shared ops inbox (PlatformSettings.operatorEmail).
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import type { Prisma } from "../generated/prisma/client.js";
import { formatDollars } from "../enquiries/money.js";
import { formatLongDate } from "../agreements/pdf.js";
import { formatLabelled } from "../time/index.js";

type Db = Prisma.TransactionClient;

/** How she paid, in words: card -> "card", payto -> "PayTo", anything else as Stripe names it. */
export function methodWords(method: string | null): string {
  if (method === null || method === "") return "Stripe";
  if (method === "card") return "card";
  if (method === "payto") return "PayTo";
  return method.replace(/_/g, " ");
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

async function contextOf(db: Db, paymentId: string): Promise<{ context: NotificationContext; customerId: string; jobId: string; invoiceId: string }> {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { invoice: { include: { job: { include: { customer: true } } } } },
  });
  const invoice = payment.invoice;
  const zone = invoice.job.timezone;
  const paidAt = payment.paidAt ?? payment.createdAt;
  const webOrigin = process.env["WEB_ORIGIN"];
  return {
    customerId: invoice.customerId,
    jobId: invoice.jobId,
    invoiceId: invoice.id,
    context: {
      firstName: firstNameOf(invoice.job.customer.name),
      customerName: invoice.job.customer.name,
      invoiceReference: invoice.reference,
      jobReference: invoice.job.reference,
      amountText: formatDollars(payment.amount),
      methodText: methodWords(payment.method),
      paidDate: formatLongDate(paidAt, zone),
      paidTime: formatLabelled(zone, paidAt),
      invoiceState: invoice.status === "void" ? "void" : "already paid",
      ...(webOrigin ? { jobUrl: `${webOrigin}/ops/jobs/${invoice.job.reference}` } : {}),
    },
  };
}

/** Sarah's receipt. */
export async function askPaymentReceipt(db: Db, paymentId: string): Promise<void> {
  const { context, customerId, jobId } = await contextOf(db, paymentId);
  const settings = await db.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  await sendNotification(
    {
      type: "payment_receipt",
      channel: "email",
      recipientType: "customer",
      recipientId: customerId,
      idempotencyKey: `payment_receipt:payment:${paymentId}:email`,
      relatedType: "payment",
      relatedId: paymentId,
      jobId,
      context: { ...context, officePhone: settings.operatorPhone },
    },
    db,
  );
}

/** The office's payment notice. recipientId is unused for the ops inbox; the payment is the nearest pointer. */
export async function askPaymentReceived(db: Db, paymentId: string): Promise<void> {
  const { context, jobId } = await contextOf(db, paymentId);
  await sendNotification(
    {
      type: "payment_received",
      channel: "email",
      recipientType: "ops",
      recipientId: paymentId,
      idempotencyKey: `payment_received:payment:${paymentId}:email`,
      relatedType: "payment",
      relatedId: paymentId,
      jobId,
      context,
    },
    db,
  );
}

/** Money on an invoice that is no longer open: the office decides with the customer. */
export async function askClosedInvoiceNotice(db: Db, paymentId: string): Promise<void> {
  const { context, jobId } = await contextOf(db, paymentId);
  await sendNotification(
    {
      type: "payment_closed_invoice",
      channel: "email",
      recipientType: "ops",
      recipientId: paymentId,
      idempotencyKey: `payment_closed_invoice:payment:${paymentId}:email`,
      relatedType: "payment",
      relatedId: paymentId,
      jobId,
      context,
    },
    db,
  );
}
