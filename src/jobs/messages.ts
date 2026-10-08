// The job page's Messages card -- Feature 4008.
//
// Operations Admin Workflow / The job queue and the job page: "The job page
// lists every message sent about the job". Every Notification row carrying
// the job's id, newest first (plan decision 7) -- to whom, email or text,
// when, what, and where it stands. Read-only, ops-only, no paging.
import type { PrismaClient } from "../db/client.js";
import type { NotificationStatus } from "../generated/prisma/enums.js";
import { formatShortDateTime } from "../time/index.js";

export interface MessageView {
  id: string;
  /** Decision 8: who it went to, read per recipient type. */
  to: string;
  channel: "Email" | "Text";
  /** Decision 9: sentAt, or createdAt while it has not gone yet, on the business clock. */
  whenLabel: string;
  /** Decision 10: a plain name per Notification.type. */
  what: string;
  status: NotificationStatus;
  /** Decision 11. */
  statusLabel: string;
  /** Notification.error, only on a failed row. */
  error: string | null;
}

/** Decision 10: each feature that adds a message type adds its name here. */
const TYPE_NAMES: Record<string, string> = {
  enquiry_confirmation: "Enquiry received",
  new_job_request: "New job request",
  job_dispatched: "Job dispatched",
  slot_confirmed: "Slot confirmed",
  contractor_declined: "Contractor declined",
  invoice: "Invoice",
  payment_receipt: "Payment receipt",
  payment_received: "Payment received",
  payment_closed_invoice: "Payment on a closed invoice",
};

const STATUS_LABELS: Record<NotificationStatus, string> = {
  queued: "Waiting to send",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
};

export function messageName(type: string): string {
  return TYPE_NAMES[type] ?? type.replace(/_/g, " ");
}

function contextName(context: unknown): string {
  if (context !== null && typeof context === "object" && !Array.isArray(context)) {
    const name = (context as Record<string, unknown>)["recipientName"];
    if (typeof name === "string" && name !== "") return name;
  }
  return "Site contact";
}

export async function jobMessages(client: PrismaClient, jobId: string, zone: string): Promise<MessageView[]> {
  const rows = await client.notification.findMany({ where: { jobId } });
  if (rows.length === 0) return [];

  const idsOf = (type: string): string[] => [
    ...new Set(rows.filter((row) => row.recipientType === type).map((row) => row.recipientId)),
  ];
  const [customers, contractors, users] = await Promise.all([
    client.customer.findMany({ where: { id: { in: idsOf("customer") } }, select: { id: true, name: true } }),
    client.contractor.findMany({ where: { id: { in: idsOf("contractor") } }, select: { id: true, name: true } }),
    client.user.findMany({ where: { id: { in: idsOf("user") } }, select: { id: true, name: true } }),
  ]);
  const nameIn = (list: { id: string; name: string }[], id: string, fallback: string): string =>
    list.find((entry) => entry.id === id)?.name ?? fallback;

  const timed = rows.map((row) => ({ row, at: row.sentAt ?? row.createdAt }));
  timed.sort((a, b) => b.at.getTime() - a.at.getTime() || b.row.id.localeCompare(a.row.id));

  return timed.map(({ row, at }) => {
    let to: string;
    switch (row.recipientType) {
      case "customer":
        to = nameIn(customers, row.recipientId, "Customer");
        break;
      case "contractor":
        to = nameIn(contractors, row.recipientId, "Contractor");
        break;
      case "ops":
        to = "Office inbox";
        break;
      case "user":
        to = nameIn(users, row.recipientId, "User");
        break;
      case "site_contact":
        to = contextName(row.context);
        break;
    }
    return {
      id: row.id,
      to,
      channel: row.channel === "sms" ? "Text" : "Email",
      whenLabel: formatShortDateTime(zone, at),
      what: messageName(row.type),
      status: row.status,
      statusLabel: STATUS_LABELS[row.status],
      error: row.status === "failed" ? row.error : null,
    };
  });
}
