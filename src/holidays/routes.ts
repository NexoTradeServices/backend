// Public holidays -- Feature 1020, Calendar & Scheduling / Public holidays.
//
// GET    /api/public-holidays?state=WA     no login: dates and names from today on, for the two forms
// GET    /api/holidays?state=&year=        owner: the list for one state and year
// POST   /api/holidays                     owner: add one; returns how many booked jobs fall that day
// DELETE /api/holidays/:id                 owner: remove one
// DELETE /api/holidays?state=&year=        owner: remove all of a FINISHED year (business clock)
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { isoDay } from "../calendar/rules.js";
import { todayIn } from "../time/index.js";
import { parseDateOnly } from "../jobs/create.js";

export const STATES = ["WA", "NSW", "VIC", "QLD", "SA", "TAS", "ACT", "NT"] as const;

function stateOf(value: unknown): string | null {
  return typeof value === "string" && (STATES as readonly string[]).includes(value) ? value : null;
}

function yearOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return null;
  return Number(value);
}

function yearRange(year: number): { gte: Date; lt: Date } {
  return { gte: new Date(`${String(year)}-01-01T00:00:00.000Z`), lt: new Date(`${String(year + 1)}-01-01T00:00:00.000Z`) };
}

/** Booked jobs on `date` in `state`: job blocks whose assignment is not declined or cancelled, the day read in the job's zone. */
export async function bookedJobsOn(client: PrismaClient, state: string, date: string): Promise<number> {
  const rows = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT j.id) AS n
      FROM "CalendarEvent" ce
      JOIN "Job" j ON j.id = ce."jobId"
      JOIN "Assignment" a ON a.id = ce."assignmentId"
     WHERE ce."type" = 'job'
       AND a."status" NOT IN ('declined', 'cancelled')
       AND j."serviceLocation"->>'state' = ${state}
       AND ((ce."startTime" AT TIME ZONE 'UTC') AT TIME ZONE j."timezone")::date = ${date}::date`;
  return Number(rows[0]?.n ?? 0n);
}

export function publicHolidayRoutes(client: PrismaClient): Router {
  const router = createRouter();
  router.get("/", (req: Request, res: Response) => {
    void (async () => {
      const state = stateOf(req.query["state"]);
      if (state === null) {
        res.status(400).json({ error: "state must be a state code like WA", field: "state" });
        return;
      }
      const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true } });
      const from = new Date(`${todayIn(settings.timezone)}T00:00:00.000Z`);
      const rows = await client.publicHoliday.findMany({
        where: { state, date: { gte: from } },
        orderBy: { date: "asc" },
        select: { date: true, name: true },
      });
      res.json({ holidays: rows.map((row) => ({ date: isoDay(row.date), name: row.name })) });
    })().catch((error: unknown) => {
      console.error("GET /api/public-holidays failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });
  return router;
}

export function holidayRoutes(client: PrismaClient): Router {
  const router = createRouter();
  const fail = (res: Response, what: string) => (error: unknown) => {
    console.error(`${what} failed`, error);
    res.status(500).json({ error: "internal error" });
  };

  router.get("/", requireRole(Role.owner), (req: Request, res: Response) => {
    void (async () => {
      const state = stateOf(req.query["state"]);
      const year = yearOf(req.query["year"]);
      if (state === null || year === null) {
        res.status(400).json({ error: "state and year are required" });
        return;
      }
      const rows = await client.publicHoliday.findMany({ where: { state, date: yearRange(year) }, orderBy: { date: "asc" } });
      res.json({ holidays: rows.map((row) => ({ id: row.id, state: row.state, date: isoDay(row.date), name: row.name })) });
    })().catch(fail(res, "GET /api/holidays"));
  });

  router.post("/", requireRole(Role.owner), (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const state = stateOf(body["state"]);
      if (state === null) {
        res.status(400).json({ error: "Pick a state.", field: "state" });
        return;
      }
      const date = parseDateOnly(body["date"]);
      if (date === null) {
        res.status(400).json({ error: "Enter the date.", field: "date" });
        return;
      }
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      if (name === "") {
        res.status(400).json({ error: "Enter the holiday name.", field: "name" });
        return;
      }
      const day = isoDay(date);
      const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true } });
      if (Number(day.slice(0, 4)) < Number(todayIn(settings.timezone).slice(0, 4))) {
        res.status(409).json({ error: "Past years can't be added to.", field: "date" });
        return;
      }
      const existing = await client.publicHoliday.findUnique({ where: { state_date: { state, date } }, select: { id: true } });
      if (existing !== null) {
        res.status(409).json({ error: `${state} already has a holiday on that date.`, field: "date" });
        return;
      }
      const created = await client.publicHoliday.create({ data: { state, date, name } });
      res.status(201).json({
        holiday: { id: created.id, state, date: day, name },
        bookedJobs: await bookedJobsOn(client, state, day),
      });
    })().catch(fail(res, "POST /api/holidays"));
  });

  router.delete("/:id", requireRole(Role.owner), (req: Request<{ id: string }>, res: Response) => {
    void (async () => {
      const removed = await client.publicHoliday.deleteMany({ where: { id: req.params.id } });
      if (removed.count === 0) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.status(204).end();
    })().catch(fail(res, "DELETE /api/holidays/:id"));
  });

  router.delete("/", requireRole(Role.owner), (req: Request, res: Response) => {
    void (async () => {
      const state = stateOf(req.query["state"]);
      const year = yearOf(req.query["year"]);
      if (state === null || year === null) {
        res.status(400).json({ error: "state and year are required" });
        return;
      }
      const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true } });
      if (year >= Number(todayIn(settings.timezone).slice(0, 4))) {
        res.status(409).json({ error: "Only a finished year can be removed all at once." });
        return;
      }
      const removed = await client.publicHoliday.deleteMany({ where: { state, date: yearRange(year) } });
      res.json({ removed: removed.count });
    })().catch(fail(res, "DELETE /api/holidays"));
  });

  return router;
}
