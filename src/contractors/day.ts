// GET /api/contractors/:code/day?date= -- Feature 4002, dispatch to
// assignment, plan decision 1: ops only, in `backend/src/contractors/`
// because 2004's calendar screen reuses it.
//
// Dispatch Logic: "picking a contractor opens his day - his calendar for the
// slot's date ... every block labelled with its time, job reference and
// suburb". One calendar day, business-zone boundaries (PlatformSettings.timezone)
// since this is the contractor's own day, not any one job's.
import type { PrismaClient } from "../db/client.js";
import { zonedDateTimeToUtc, formatTimeRangeLabel, dateOnlyAsUtcMidnight } from "../time/index.js";
import { suburbOf } from "../jobs/shared.js";

export interface DayBlock {
  startMinutes: number;
  endMinutes: number;
  timeLabel: string;
  jobReference: string | null;
  suburb: string | null;
  kind: "booked" | "hold" | "other";
}

const ASSIGNMENT_KIND: Record<string, "booked" | "hold"> = {
  assigned: "hold",
  accepted: "booked",
  in_progress: "booked",
  completed: "booked",
};

export async function loadContractorDay(
  client: PrismaClient,
  contractorId: string,
  date: string,
  zone: string,
): Promise<DayBlock[]> {
  const dayStart = zonedDateTimeToUtc(zone, date, 0, 0);
  const nextDate = new Date(dateOnlyAsUtcMidnight(date).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayEnd = zonedDateTimeToUtc(zone, nextDate, 0, 0);

  const events = await client.calendarEvent.findMany({
    where: { contractorId, startTime: { lt: dayEnd }, endTime: { gt: dayStart } },
    orderBy: { startTime: "asc" },
    include: { job: { select: { reference: true, serviceLocation: true } }, assignment: { select: { status: true } } },
  });

  return events.map((event) => {
    const startMinutes = Math.round((event.startTime.getTime() - dayStart.getTime()) / 60_000);
    const endMinutes = Math.round((event.endTime.getTime() - dayStart.getTime()) / 60_000);
    const kind = event.assignment ? (ASSIGNMENT_KIND[event.assignment.status] ?? "other") : "other";
    return {
      startMinutes,
      endMinutes,
      timeLabel: formatTimeRangeLabel(zone, event.startTime, event.endTime),
      jobReference: event.job?.reference ?? null,
      suburb: event.job ? suburbOf(event.job.serviceLocation) : null,
      kind,
    };
  });
}
