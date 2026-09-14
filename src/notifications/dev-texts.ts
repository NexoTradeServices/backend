// The interim Texts sent page's data -- Feature 4002, dispatch to
// assignment, plan decision 13. Retired by BKLG-028 once ClickSend is set up
// -- a plain delete, since nothing new lives in the schema for it.
//
// Reads the latest 50 SMS rows carrying the dispatcher's reserved
// DEV_SMS_TEXT_CONTEXT_KEY (dispatcher.ts, recordDevSmsText -- set only when
// a text is handed to the console adapter, or failed for want of a
// configured provider), and groups them into ONE BLOCK PER STEP OF A JOB:
// the same job, the same message type, the same related record -- the
// idempotency key's front half (`<type>:<relatedType>:<relatedId>`).
import type { PrismaClient } from "../db/client.js";
import { DEV_SMS_TEXT_CONTEXT_KEY } from "./dispatcher.js";
import { formatDateTimeLabel } from "../time/index.js";

/** "job_dispatched" -> "dispatched" -- the step name a block is headed with. */
const STEP_LABELS: Record<string, string> = {
  job_dispatched: "dispatched",
};

function stepLabelOf(type: string): string {
  return STEP_LABELS[type] ?? type.replace(/_/g, " ");
}

/** The idempotency key's front half: `<type>:<relatedType>:<relatedId>`, ignoring any discriminator. */
function stepKeyOf(idempotencyKey: string): string {
  return idempotencyKey.split(":").slice(0, 3).join(":");
}

export interface DevTextRow {
  id: string;
  recipientBadge: "CONTRACTOR SMS" | "CUSTOMER SMS" | "OPS SMS";
  toName: string | null;
  toNumber: string;
  text: string;
  atLabel: string;
}

export interface DevTextBlock {
  jobReference: string;
  step: string;
  atLabel: string;
  texts: DevTextRow[];
}

const LATEST = 50;

interface RawRow {
  id: string;
  recipientType: "customer" | "contractor" | "ops" | "user";
  recipientId: string;
  type: string;
  idempotencyKey: string;
  jobId: string | null;
  jobReference: string | null;
  jobTimezone: string | null;
  at: Date;
  text: string;
}

export async function loadDevTextBlocks(client: PrismaClient, now: Date = new Date()): Promise<DevTextBlock[]> {
  const rows = await client.$queryRaw<RawRow[]>`
    SELECT n.id, n."recipientType", n."recipientId", n.type, n."idempotencyKey", n."jobId",
           j.reference AS "jobReference", j.timezone AS "jobTimezone",
           COALESCE(n."sentAt", n."createdAt") AS "at",
           n.context->>${DEV_SMS_TEXT_CONTEXT_KEY} AS text
      FROM "Notification" n
      LEFT JOIN "Job" j ON j.id = n."jobId"
     WHERE n.channel = 'sms' AND n.context ? ${DEV_SMS_TEXT_CONTEXT_KEY}
     ORDER BY COALESCE(n."sentAt", n."createdAt") DESC
     LIMIT ${LATEST}
  `;

  const withJob = rows.filter((row): row is RawRow & { jobId: string; jobReference: string; jobTimezone: string } =>
    row.jobId !== null && row.jobReference !== null && row.jobTimezone !== null,
  );

  const contractorIds = [...new Set(withJob.filter((r) => r.recipientType === "contractor").map((r) => r.recipientId))];
  const customerIds = [...new Set(withJob.filter((r) => r.recipientType === "customer").map((r) => r.recipientId))];
  const [contractors, customers, settings] = await Promise.all([
    contractorIds.length
      ? client.contractor.findMany({ where: { id: { in: contractorIds } }, select: { id: true, name: true, phone: true } })
      : Promise.resolve([]),
    customerIds.length
      ? client.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true } })
      : Promise.resolve([]),
    client.platformSettings.findFirst({ select: { operatorPhone: true } }),
  ]);
  const contractorById = new Map(contractors.map((c) => [c.id, c]));
  const customerById = new Map(customers.map((c) => [c.id, c]));

  interface Group {
    jobReference: string;
    step: string;
    latestAt: number;
    atLabel: string;
    texts: DevTextRow[];
  }
  const groups = new Map<string, Group>();

  for (const row of withJob) {
    let toName: string | null;
    let toNumber: string;
    let recipientBadge: DevTextRow["recipientBadge"];
    if (row.recipientType === "contractor") {
      const c = contractorById.get(row.recipientId);
      toName = c?.name ?? null;
      toNumber = c?.phone ?? "";
      recipientBadge = "CONTRACTOR SMS";
    } else if (row.recipientType === "customer") {
      const c = customerById.get(row.recipientId);
      toName = c?.name ?? null;
      toNumber = c?.phone ?? "";
      recipientBadge = "CUSTOMER SMS";
    } else {
      toName = null;
      toNumber = settings?.operatorPhone ?? "";
      recipientBadge = "OPS SMS";
    }

    const groupKey = `${row.jobId}:${stepKeyOf(row.idempotencyKey)}`;
    const atMs = row.at.getTime();
    const textRow: DevTextRow = {
      id: row.id,
      recipientBadge,
      toName,
      toNumber,
      text: row.text,
      atLabel: formatDateTimeLabel(row.jobTimezone, row.at, now),
    };

    const group = groups.get(groupKey);
    if (group) {
      group.texts.push(textRow);
      if (atMs > group.latestAt) {
        group.latestAt = atMs;
        group.atLabel = textRow.atLabel;
      }
    } else {
      groups.set(groupKey, {
        jobReference: row.jobReference,
        step: stepLabelOf(row.type),
        latestAt: atMs,
        atLabel: textRow.atLabel,
        texts: [textRow],
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.latestAt - a.latestAt)
    .map(({ jobReference, step, atLabel, texts }) => ({ jobReference, step, atLabel, texts }));
}
