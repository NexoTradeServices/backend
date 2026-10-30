// "On my way" -- Feature 5004: which visit the tap is for, and whether it has gone.
//
// The tap is offered for the booked visit (calendar block) that falls on today's date in the job's
// zone, while the job is scheduled and the assignment is still his to work (accepted, or in
// progress on a return visit). One send per block: it counts as sent when the customer's email
// row for that block exists, and that row's createdAt is the sent time.
import type { PrismaClient } from "../db/client.js";
import { todayIn } from "../time/index.js";

export type OnMyWayView = null | { sent: false } | { sent: true; sentLabel: string };

interface VisitInput {
  id: string;
  jobStatus: string;
  assignmentStatus: string;
  timezone: string;
}

export interface TodaysVisit {
  calendarEventId: string;
}

/** The block On my way is for, or null (no button). The earliest block today when there are several. */
export async function todaysVisit(client: PrismaClient, input: VisitInput, now: Date): Promise<TodaysVisit | null> {
  if (input.jobStatus !== "scheduled") return null;
  if (input.assignmentStatus !== "accepted" && input.assignmentStatus !== "in_progress") return null;
  const blocks = await client.calendarEvent.findMany({
    where: { assignmentId: input.id, type: "job" },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
    select: { id: true, startTime: true },
  });
  const today = todayIn(input.timezone, now);
  const block = blocks.find((row) => todayIn(input.timezone, row.startTime) === today);
  return block === undefined ? null : { calendarEventId: block.id };
}

export function onMyWayKey(assignmentId: string, calendarEventId: string): string {
  return `on_my_way:assignment:${assignmentId}:${calendarEventId}:customer:email`;
}

/** "7:42am" -- the time on the job's wall clock. */
export function sentLabelOf(zone: string, moment: Date): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(moment);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("hour")}:${value("minute")}${value("dayPeriod").toLowerCase().replace(/\./g, "")}`;
}

export async function onMyWayOf(client: PrismaClient, input: VisitInput, now: Date): Promise<OnMyWayView> {
  const visit = await todaysVisit(client, input, now);
  if (visit === null) return null;
  const row = await client.notification.findUnique({
    where: { idempotencyKey: onMyWayKey(input.id, visit.calendarEventId) },
    select: { createdAt: true },
  });
  return row === null ? { sent: false } : { sent: true, sentLabel: sentLabelOf(input.timezone, row.createdAt) };
}
