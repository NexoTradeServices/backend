// The two invoice reminders -- Feature 6008, invoice reminders and void.
//
// Invoicing / Invoice lifecycle - due, overdue, reminders. A step of the daily sweep
// (daily/index.ts). It finds every invoice still owed that has its pay link and:
//
//   reminder 1  today (business calendar) is on or after the due date, none sent yet;
//   reminder 2  reminder 1 was created 7 or more business days ago, none sent yet.
//
// Never both on one morning (the 7-day gap), never for a paid, void or zero-dollar invoice,
// never for an invoice still waiting for its pay link, never to the site contact, email only.
// Whether a reminder was sent is READ from the notification rows -- no field of its own --
// and the idempotency key `invoice_reminder_<n>:invoice:<id>:email` makes a repeat harmless.
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import { todayIn } from "../time/index.js";

export const REMINDER_1 = "invoice_reminder_1";
export const REMINDER_2 = "invoice_reminder_2";
export const REMINDER_GAP_DAYS = 7;

export function reminderKey(type: typeof REMINDER_1 | typeof REMINDER_2, invoiceId: string): string {
  return `${type}:invoice:${invoiceId}:email`;
}

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export interface ReminderRun {
  first: number;
  second: number;
}

/**
 * One pass. `today` is the business day it runs as (`YYYY-MM-DD`; default: now on the
 * business clock) -- the test hook passes another day to cross the 7-day gap.
 */
export async function runInvoiceReminders(
  client: PrismaClient,
  options: { zone: string; today?: string; now?: Date; /** A browser test's run: only invoices carrying this label. */ onlyLabel?: string | null },
): Promise<ReminderRun> {
  const { zone } = options;
  const today = options.today ?? todayIn(zone, options.now ?? new Date());
  const result: ReminderRun = { first: 0, second: 0 };

  const invoices = await client.invoice.findMany({
    where: {
      status: "sent",
      isZeroDollar: false,
      stripePaymentLinkUrl: { not: null },
      ...(options.onlyLabel ? { testData: options.onlyLabel } : {}),
    },
    include: { job: { include: { customer: true, serviceType: { select: { trade: true } } } } },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });
  if (invoices.length === 0) return result;

  const sent = await client.notification.findMany({
    where: {
      type: { in: [REMINDER_1, REMINDER_2] },
      channel: "email",
      relatedType: "invoice",
      relatedId: { in: invoices.map((invoice) => invoice.id) },
    },
    select: { type: true, relatedId: true, createdAt: true },
  });
  const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });

  for (const invoice of invoices) {
    const mine = sent.filter((row) => row.relatedId === invoice.id);
    const first = mine.find((row) => row.type === REMINDER_1);
    const second = mine.find((row) => row.type === REMINDER_2);
    if (second !== undefined) continue;

    const dueDay = todayIn(zone, invoice.dueAt);
    let type: typeof REMINDER_1 | typeof REMINDER_2;
    if (first === undefined) {
      if (today < dueDay) continue;
      type = REMINDER_1;
    } else {
      if (daysBetween(todayIn(zone, first.createdAt), today) < REMINDER_GAP_DAYS) continue;
      type = REMINDER_2;
    }

    const daysOverdue = Math.max(daysBetween(dueDay, today), 0);
    const context: NotificationContext = {
      invoiceId: invoice.id,
      invoiceReference: invoice.reference,
      jobReference: invoice.job.reference,
      trade: invoice.job.serviceType.trade.toLowerCase(),
      firstName: firstNameOf(invoice.job.customer.name),
      payUrl: invoice.stripePaymentLinkUrl ?? "",
      officePhone: settings.operatorPhone,
      ...(type === REMINDER_2 ? { daysOverdueText: `${String(daysOverdue)} day${daysOverdue === 1 ? "" : "s"}` } : {}),
    };
    try {
      await sendNotification(
        {
          type,
          channel: "email",
          recipientType: "customer",
          recipientId: invoice.customerId,
          idempotencyKey: reminderKey(type, invoice.id),
          relatedType: "invoice",
          relatedId: invoice.id,
          jobId: invoice.jobId,
          context,
        },
        client,
      );
      if (type === REMINDER_1) result.first += 1;
      else result.second += 1;
    } catch (error: unknown) {
      // One invoice failing never stops the others; the next tick tries it again.
      console.error(`invoice reminders: ${invoice.reference} could not be asked`, error);
    }
  }
  return result;
}
