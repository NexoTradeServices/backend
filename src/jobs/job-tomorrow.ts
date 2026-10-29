// Job-tomorrow reminders -- Feature 7004.
//
// Customer Workflow (step 11); Notifications / Customer messages (Job tomorrow). A step of the daily
// sweep (daily/index.ts). The morning run emails and texts the customer (and the site contact, when the
// job has one) one reminder per booked visit, the day before it. Nobody presses anything.
//
//   - Which visits: the `job` calendar blocks that start TOMORROW (the job's zone) on an accepted or
//     in-progress assignment of a scheduled job, whose assignment was confirmed before the morning run's
//     time TODAY on the business clock. A block confirmed at or after that time is skipped for good: the
//     Job booked message has only just told the customer. A visit booked for today is never "tomorrow",
//     so it gets none ("On my way" covers it).
//   - Once per visit: the idempotency key carries the assignment, the calendar block, the audience and the
//     channel, so a re-run all day, or both loops, asks for nothing twice.
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationChannel, NotificationContext } from "../notifications/index.js";
import { asSiteContact } from "./site-contact.js";
import { effectiveAddress } from "./shared.js";
import { daysBetween } from "../invoices/reminders.js";
import { clockTimeIn, formatDateWithDay, formatLabelled, todayIn, zonedDateTimeToUtc } from "../time/index.js";

/** `YYYY-MM-DD` one calendar day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function jobTomorrowKey(
  assignmentId: string,
  calendarEventId: string,
  audience: "customer" | "site_contact",
  channel: NotificationChannel,
): string {
  return `job_tomorrow:assignment:${assignmentId}:${calendarEventId}:${audience}:${channel}`;
}

/**
 * Will a reminder come for a visit booked at `slot`? Yes when the visit is two or more days away, or
 * tomorrow while the business clock is still before the morning run's time. `runAt` is `HH:mm`.
 */
export function reminderWillCome(input: { businessZone: string; jobZone: string; slot: Date; now: Date; runAt: string }): boolean {
  const days = daysBetween(todayIn(input.businessZone, input.now), todayIn(input.jobZone, input.slot));
  if (days >= 2) return true;
  return days === 1 && clockTimeIn(input.businessZone, input.now) < input.runAt;
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export interface JobTomorrowRun {
  /** Visits reminded this pass (a visit counts once, whatever its recipients). */
  visits: number;
}

export async function runJobTomorrowReminders(
  client: PrismaClient,
  options: { zone: string; now: Date; today: string; runAt: string; /** A browser test's run: only jobs carrying this label. */ onlyLabel?: string | null },
): Promise<JobTomorrowRun> {
  const { zone, now, today } = options;
  const tomorrow = nextDay(today);
  // Confirmed before this instant = before the morning run's time, today, on the business clock.
  const [runHour, runMinute] = options.runAt.split(":").map(Number);
  const confirmedBefore = zonedDateTimeToUtc(zone, today, runHour ?? 9, runMinute ?? 0);
  const label = options.onlyLabel ? { testData: options.onlyLabel } : {};
  const result: JobTomorrowRun = { visits: 0 };

  const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  // A wide net in UTC; the exact day is decided on the job's own wall clock below.
  const blocks = await client.calendarEvent.findMany({
    where: {
      type: "job",
      startTime: { gte: new Date(now.getTime() - 2 * 86_400_000), lt: new Date(now.getTime() + 4 * 86_400_000) },
      assignment: { status: { in: ["accepted", "in_progress"] }, acceptedAt: { lt: confirmedBefore } },
      job: { status: "scheduled", ...label },
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    include: {
      assignment: { include: { contractor: { select: { name: true } }, specialty: { select: { trade: true } } } },
      job: { include: { customer: { select: { id: true, name: true, billingAddress: true } } } },
    },
  });

  for (const block of blocks) {
    const { assignment, job } = block;
    if (assignment === null || job === null) continue;
    if (todayIn(job.timezone, block.startTime) !== tomorrow) continue;
    const address = effectiveAddress(job);
    if (address === null) continue;

    const siteContact = asSiteContact(job.siteContact);
    const common = {
      contractorFirstName: firstNameOf(assignment.contractor.name),
      jobReference: job.reference,
      trade: assignment.specialty.trade.toLowerCase(),
      street: address.street,
      suburb: address.suburb,
      slotLabel: `${formatDateWithDay(job.timezone, block.startTime, now)}, ${formatLabelled(job.timezone, block.startTime)}`,
      dateLabel: formatDateWithDay(job.timezone, block.startTime, now),
      timeLabel: formatLabelled(job.timezone, block.startTime),
      officePhone: settings.operatorPhone,
    } satisfies NotificationContext;

    const ask = async (channel: NotificationChannel, audience: "customer" | "site_contact", context: NotificationContext): Promise<void> => {
      await sendNotification(
        {
          type: "job_tomorrow",
          channel,
          recipientType: audience,
          recipientId: audience === "customer" ? job.customer.id : job.id,
          idempotencyKey: jobTomorrowKey(assignment.id, block.id, audience, channel),
          relatedType: "assignment",
          relatedId: assignment.id,
          jobId: job.id,
          context,
        },
        client,
      );
    };

    try {
      const customerContext: NotificationContext = {
        ...common,
        audience: "customer",
        firstName: firstNameOf(job.customer.name),
        ...(siteContact === null ? {} : { siteContactTold: true }),
      };
      for (const channel of ["email", "sms"] as const) await ask(channel, "customer", customerContext);

      if (siteContact !== null) {
        const siteContext: NotificationContext = {
          ...common,
          audience: "site_contact",
          firstName: firstNameOf(siteContact.name),
          recipientName: siteContact.name,
        };
        await ask("sms", "site_contact", siteContext);
        if (siteContact.email !== null && siteContact.email.trim() !== "") {
          await ask("email", "site_contact", siteContext);
        }
      }
      result.visits += 1;
    } catch (error: unknown) {
      // One visit failing never stops the others; the next run of the day asks again.
      console.error(`job tomorrow: ${job.reference} could not be asked`, error);
    }
  }
  return result;
}
