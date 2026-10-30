// Licence and insurance expiry alerts -- Feature 7002.
//
// Managing the contractor record / Expiry alerts; Notifications / Contractor messages (Licence / insurance
// expiring). A step of the daily sweep (daily/index.ts). Every active trade specialty of an active
// contractor is watched for its licence expiry, every active contractor for an insurance expiry. With 1 to 30
// days left (whole days, the business calendar, plain dates) the contractor and the office inbox are
// emailed, in five steps:
//
//   step = floor((30 - daysLeft) / 7)   30-24 days left: 0, 23-17: 1, 16-10: 2, 9-3: 3, 2-1: 4
//
// A run sends the step it lands in, once, and never a step it skipped (a morning missed while the platform
// was down). Whether a step was sent is READ from the notification rows -- no field of its own -- and the
// idempotency key carries the expiry date and the step, so a repeat is harmless and a NEW expiry date
// starts its own run while the old one stops. Nothing fires on the expiry day or after (the dispatch guard
// already excludes the specialty / contractor and shows ops why).
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";
import { daysBetween } from "../invoices/reminders.js";
import { dateOnlyAsUtcMidnight, formatPlainDate } from "../time/index.js";

export const ALERT_WINDOW_DAYS = 30;
const STEP_DAYS = 7;

export const LICENCE_ALERT = "licence_expiring";
export const INSURANCE_ALERT = "insurance_expiring";

type Audience = "contractor" | "ops";
const AUDIENCES: Audience[] = ["contractor", "ops"];

/** Which of the five steps `daysLeft` falls in; null outside 1..30 days (nothing to send). */
export function alertStep(daysLeft: number): number | null {
  if (daysLeft < 1 || daysLeft > ALERT_WINDOW_DAYS) return null;
  return Math.floor((ALERT_WINDOW_DAYS - daysLeft) / STEP_DAYS);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

export interface ExpiryAlertRun {
  /** Emails asked for this pass (a contractor copy and an office copy count one each). */
  sent: number;
}

export async function runExpiryAlerts(
  client: PrismaClient,
  options: { zone: string; today: string; /** A browser test's run: only records carrying this label. */ onlyLabel?: string | null },
): Promise<ExpiryAlertRun> {
  const { today } = options;
  const label = options.onlyLabel ? { testData: options.onlyLabel } : {};
  const result: ExpiryAlertRun = { sent: 0 };
  const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorEmail: true, operatorPhone: true } });
  const webOrigin = process.env["WEB_ORIGIN"];
  const dayLabel = (expiry: Date): string => formatPlainDate(expiry, dateOnlyAsUtcMidnight(today));

  async function alert(
    type: typeof LICENCE_ALERT | typeof INSURANCE_ALERT,
    keyBase: string,
    step: number,
    contractor: { id: string; name: string; code: string },
    facts: NotificationContext,
  ): Promise<void> {
    for (const audience of AUDIENCES) {
      const idempotencyKey = `${keyBase}:${String(step)}:${audience}`;
      const already = await client.notification.findUnique({ where: { idempotencyKey }, select: { id: true } });
      if (already !== null) continue;
      const context: NotificationContext = {
        ...facts,
        audience,
        firstName: firstNameOf(contractor.name),
        contractorName: contractor.name,
        code: contractor.code,
        ...(audience === "contractor"
          ? { officePhone: settings.operatorPhone, ...(settings.operatorEmail.trim() === "" ? {} : { replyToEmail: settings.operatorEmail }) }
          : webOrigin
            ? { buttonUrl: `${webOrigin}/ops/contractors/${contractor.code}` }
            : {}),
      };
      try {
        await sendNotification(
          {
            type,
            channel: "email",
            recipientType: audience,
            recipientId: contractor.id,
            idempotencyKey,
            relatedType: "contractor",
            relatedId: contractor.id,
            context,
          },
          client,
        );
        result.sent += 1;
      } catch (error: unknown) {
        // One alert failing never stops the others; the next morning's run tries it again.
        console.error(`expiry alerts: ${contractor.code} could not be asked`, error);
      }
    }
  }

  const specialties = await client.contractorSpecialty.findMany({
    where: { status: "active", contractor: { status: "active" }, ...label },
    include: { contractor: { select: { id: true, name: true, code: true } } },
    orderBy: [{ licenceExpiry: "asc" }, { id: "asc" }],
  });
  for (const specialty of specialties) {
    const daysLeft = daysBetween(today, isoDate(specialty.licenceExpiry));
    const step = alertStep(daysLeft);
    if (step === null) continue;
    await alert(
      LICENCE_ALERT,
      `${LICENCE_ALERT}:contractor:${specialty.contractorId}:${specialty.id}:${isoDate(specialty.licenceExpiry)}`,
      step,
      specialty.contractor,
      {
        trade: specialty.trade.toLowerCase(),
        Trade: specialty.trade,
        licenceNumber: specialty.licenceNumber,
        expiryLabel: dayLabel(specialty.licenceExpiry),
        daysText: `${String(daysLeft)} day${daysLeft === 1 ? "" : "s"}`,
      },
    );
  }

  const contractors = await client.contractor.findMany({
    where: { status: "active", insuranceExpiry: { not: null }, ...label },
    orderBy: [{ insuranceExpiry: "asc" }, { id: "asc" }],
  });
  for (const contractor of contractors) {
    if (contractor.insuranceExpiry === null) continue;
    const daysLeft = daysBetween(today, isoDate(contractor.insuranceExpiry));
    const step = alertStep(daysLeft);
    if (step === null) continue;
    await alert(
      INSURANCE_ALERT,
      `${INSURANCE_ALERT}:contractor:${contractor.id}:${isoDate(contractor.insuranceExpiry)}`,
      step,
      contractor,
      {
        ...(contractor.insurer?.trim() ? { insurer: contractor.insurer.trim() } : {}),
        ...(contractor.insurancePolicyNo?.trim() ? { policyNo: contractor.insurancePolicyNo.trim() } : {}),
        expiryLabel: dayLabel(contractor.insuranceExpiry),
        daysText: `${String(daysLeft)} day${daysLeft === 1 ? "" : "s"}`,
      },
    );
  }
  return result;
}
