// Replacing bank details -- Feature 2005, Managing the contractor record / Notifications.
//
// One rule for both doors (Bob's My details page and Mike's contractor form): when a bank field that already
// held a value changes, the change is stamped (who, when) and the contractor and the office are emailed, with no
// numbers in the message. A first entry stamps nothing and sends nothing. A failed send never blocks the save.
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationContext } from "../notifications/index.js";

export interface BankFields {
  payoutBsb: string | null;
  payoutAccountNo: string | null;
  payoutAccountName: string | null;
}

const KEYS = ["payoutBsb", "payoutAccountNo", "payoutAccountName"] as const;

/** True when a field that already held a value now holds something else (or nothing). */
export function bankReplaced(before: BankFields, after: BankFields): boolean {
  return KEYS.some((key) => before[key] !== null && before[key] !== after[key]);
}

/** The audit pair to write with the update when the details were replaced; nothing otherwise. */
export function bankStamp(before: BankFields, after: BankFields, byUserId: string | null, now: Date) {
  return bankReplaced(before, after) ? { payoutChangedByUserId: byUserId, payoutChangedAt: now } : {};
}

/** Emails the contractor and the office. Called after the save has committed; never throws. */
export async function sendBankChanged(
  client: PrismaClient,
  contractor: { id: string; name: string; code: string },
  changedAt: Date,
): Promise<void> {
  try {
    const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorEmail: true, operatorPhone: true } });
    const webOrigin = process.env["WEB_ORIGIN"];
    for (const audience of ["contractor", "ops"] as const) {
      const context: NotificationContext = {
        audience,
        firstName: contractor.name.split(" ")[0] ?? contractor.name,
        contractorName: contractor.name,
        code: contractor.code,
        officePhone: settings.operatorPhone,
        ...(audience === "ops" && webOrigin ? { buttonUrl: `${webOrigin}/ops/contractors/${contractor.code}` } : {}),
      };
      try {
        await sendNotification(
          {
            type: "bank_details_changed",
            channel: "email",
            recipientType: audience,
            recipientId: contractor.id,
            idempotencyKey: `bank_details_changed:${contractor.id}:${String(changedAt.getTime())}:${audience}`,
            relatedType: "contractor",
            relatedId: contractor.id,
            context,
          },
          client,
        );
      } catch (error: unknown) {
        console.error(`bank details changed: ${contractor.code} ${audience} could not be told`, error);
      }
    }
  } catch (error: unknown) {
    console.error(`bank details changed: ${contractor.code} could not be told`, error);
  }
}
