// The messages a settlement sets off -- Feature 6003, settlement run.
//
// Notifications / Contractor messages (draft invoice to approve, payout sent). Asked AFTER the
// transaction that caused them commits, so a rolled-back sweep or payment sends nothing. Every
// idempotency key is derivable without reading the table: a double tap or a second pass asks
// for the same row. A message about labelled test data carries its label, so automated-test
// traffic never reaches a real provider.
import type { PrismaClient } from "../db/client.js";
import { CapabilityTokenType } from "../capability-tokens/index.js";
import { sendNotification } from "../notifications/index.js";
import { isProduction, runWithLabel } from "../test-data/label.js";
import { addDays, dayLabel, payDayFor, periodLabel, ymdOf } from "./calendar.js";

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

/** Run `ask` under the label the records carry (never in production, where nothing is labelled). */
async function underLabel(label: string | null, ask: () => Promise<void>): Promise<void> {
  if (label === null || isProduction()) {
    await ask();
    return;
  }
  await runWithLabel(label, ask);
}

/** The draft email: the invoice, the period, "approve by / paid on", and the Review and approve button. */
export async function askDraftEmail(client: PrismaClient, draft: { id: string; testData: string | null }, now: Date): Promise<void> {
  const settlement = await client.contractorSettlement.findUniqueOrThrow({
    where: { id: draft.id },
    include: { contractor: { select: { id: true, name: true } } },
  });
  const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true, payoutCycle: true, payoutDay: true, operatorPhone: true } });
  const payDay = payDayFor(settings, now);
  await underLabel(draft.testData, async () => {
    await sendNotification(
      {
        type: "settlement_draft",
        channel: "email",
        recipientType: "contractor",
        recipientId: settlement.contractor.id,
        idempotencyKey: `settlement_draft:settlement:${settlement.id}:email`,
        relatedType: "settlement",
        relatedId: settlement.id,
        context: {
          firstName: firstNameOf(settlement.contractor.name),
          reference: settlement.reference,
          period: periodLabel(ymdOf(settlement.periodStart), ymdOf(settlement.periodEnd)),
          approveBy: dayLabel(addDays(payDay, -1)),
          payDay: dayLabel(payDay),
          officePhone: settings.operatorPhone,
        },
        capabilityLink: { type: CapabilityTokenType.approve, settlementId: settlement.id },
      },
      client,
    );
  });
}

/** The payout-sent email: paid into the account ending ..., and where to see the breakdown. */
export async function askPayoutSentEmail(client: PrismaClient, settlementId: string): Promise<void> {
  const settlement = await client.contractorSettlement.findUniqueOrThrow({
    where: { id: settlementId },
    include: { contractor: { select: { id: true, name: true, payoutAccountNo: true } } },
  });
  const settings = await client.platformSettings.findFirstOrThrow({ select: { operatorPhone: true } });
  const origin = process.env["WEB_ORIGIN"];
  if (!origin) throw new Error("WEB_ORIGIN is not set");
  const account = settlement.contractor.payoutAccountNo ?? "";
  await underLabel(settlement.testData, async () => {
    await sendNotification(
      {
        type: "payout_sent",
        channel: "email",
        recipientType: "contractor",
        recipientId: settlement.contractor.id,
        idempotencyKey: `payout_sent:settlement:${settlement.id}:email`,
        relatedType: "settlement",
        relatedId: settlement.id,
        context: {
          firstName: firstNameOf(settlement.contractor.name),
          reference: settlement.reference,
          period: periodLabel(ymdOf(settlement.periodStart), ymdOf(settlement.periodEnd)),
          accountLast4: account.replace(/\s/g, "").slice(-4),
          officePhone: settings.operatorPhone,
          settlementUrl: `${origin}/contractor/payouts/${settlement.reference}`,
        },
      },
      client,
    );
  });
}
