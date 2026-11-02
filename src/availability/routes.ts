// Availability and Calendar routes -- Feature 2004.
//
//   /api/contractor/availability            GET ?week=  PUT {changes}   the contractor's own
//   /api/contractor/availability/copy-day   POST {from, changes?}
//   /api/contractor/availability/copy-week  POST {fromWeek, replace?, changes?}
//   /api/contractor/calendar                GET ?from=&to=
//   /api/contractor/hours-notice-seen       POST   stamps the new-hours dashboard message as seen
//   the same under /api/contractors/:code/... for Mike and the owner (the tabs on Bob's record)
//
// One screen, one shape, two doors (the service area's pattern). Both doors call the same functions in ./index.ts.
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { todayIn } from "../time/index.js";
import {
  addDays,
  applyChanges,
  calendarRange,
  clockOf,
  copyDay,
  copyWeek,
  dayStates,
  mondayOf,
  parseChanges,
  zoneOf,
  type AvailabilityContractor,
} from "./index.js";

interface Who extends AvailabilityContractor {
  availabilitySavedAt: Date | null;
}

const WHO_SELECT = { id: true, operatingState: true, defaultOpening: true, defaultClosing: true, availabilitySavedAt: true } as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function weekPayload(client: PrismaClient, who: Who, week: string) {
  const settings = await client.platformSettings.findFirstOrThrow({ select: { openingTime: true, closingTime: true } });
  const dates = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const days = await dayStates(client, who, dates);
  return {
    week,
    zone: zoneOf(who),
    operatingState: who.operatingState,
    openingTime: settings.openingTime,
    closingTime: settings.closingTime,
    availabilitySet: who.availabilitySavedAt !== null,
    days: days.map((day) => ({
      date: day.date,
      closed: day.closed,
      slots: day.slots.map((slot) => ({ time: clockOf(slot.minutes), state: slot.state })),
    })),
  };
}

function bad(res: Response, error: string, field?: string): void {
  res.status(400).json({ error, ...(field === undefined ? {} : { field }) });
}

function mount(router: Router, client: PrismaClient, path: string, roles: Role[], whoOf: (req: Request) => Promise<Who | null>): void {
  const guard = requireRole(...roles);
  const wrap = (name: string, fn: (req: Request, res: Response, who: Who) => Promise<void>) => (req: Request, res: Response) => {
    void (async () => {
      const who = await whoOf(req);
      if (who === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      await fn(req, res, who);
    })().catch((error: unknown) => {
      console.error(`${name} failed`, error);
      res.status(500).json({ error: "internal error" });
    });
  };
  const userId = (req: Request): string | null => req.authUser?.id ?? null;

  router.get(`${path}/availability`, guard, wrap("GET availability", async (req, res, who) => {
    const raw = req.query["week"];
    const week = typeof raw === "string" && DATE.test(raw) ? mondayOf(raw) : mondayOf(todayIn(zoneOf(who)));
    res.json(await weekPayload(client, who, week));
  }));

  router.put(`${path}/availability`, guard, wrap("PUT availability", async (req, res, who) => {
    const changes = parseChanges((req.body as Record<string, unknown> | undefined)?.["changes"]);
    if (changes === null) return bad(res, "changes must be a list of { date, time, available }", "changes");
    res.json(await applyChanges(client, who.id, changes, userId(req)));
  }));

  router.post(`${path}/availability/copy-day`, guard, wrap("POST copy-day", async (req, res, who) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changes = parseChanges(body["changes"]);
    if (typeof body["from"] !== "string" || !DATE.test(body["from"])) return bad(res, "from must be a date", "from");
    if (changes === null) return bad(res, "changes must be a list of { date, time, available }", "changes");
    res.json(await copyDay(client, who.id, { from: body["from"], changes, byUserId: userId(req) }));
  }));

  router.post(`${path}/availability/copy-week`, guard, wrap("POST copy-week", async (req, res, who) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changes = parseChanges(body["changes"]);
    if (typeof body["fromWeek"] !== "string" || !DATE.test(body["fromWeek"])) return bad(res, "fromWeek must be a date", "fromWeek");
    if (changes === null) return bad(res, "changes must be a list of { date, time, available }", "changes");
    res.json(
      await copyWeek(client, who.id, {
        fromWeek: mondayOf(body["fromWeek"]),
        replace: body["replace"] === true,
        changes,
        byUserId: userId(req),
      }),
    );
  }));

  router.get(`${path}/calendar`, guard, wrap("GET calendar", async (req, res, who) => {
    const today = todayIn(zoneOf(who));
    const from = typeof req.query["from"] === "string" && DATE.test(req.query["from"]) ? req.query["from"] : today;
    const to = typeof req.query["to"] === "string" && DATE.test(req.query["to"]) ? req.query["to"] : addDays(from, 6);
    const settings = await client.platformSettings.findFirstOrThrow({ select: { openingTime: true, closingTime: true } });
    res.json({
      zone: zoneOf(who),
      today,
      operatingState: who.operatingState,
      openingTime: settings.openingTime,
      closingTime: settings.closingTime,
      availabilitySet: who.availabilitySavedAt !== null,
      days: await calendarRange(client, who, from, to),
    });
  }));
}

/** The contractor's own door. */
export function contractorAvailabilityRoutes(client: PrismaClient): Router {
  const router = createRouter();
  const own = async (req: Request): Promise<Who | null> =>
    req.authUser === undefined ? null : client.contractor.findUnique({ where: { userId: req.authUser.id }, select: WHO_SELECT });
  mount(router, client, "", [Role.contractor], own);
  router.post("/hours-notice-seen", requireRole(Role.contractor), (req: Request, res: Response) => {
    void (async () => {
      const who = await own(req);
      if (who === null) {
        res.status(404).json({ error: "not found" });
        return;
      }
      await client.contractor.update({ where: { id: who.id }, data: { hoursNoticeSeenAt: new Date() } });
      res.json({ ok: true });
    })().catch((error: unknown) => {
      console.error("POST hours-notice-seen failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });
  return router;
}

/** Mike's and the owner's door: the same screens against any contractor's code. */
export function opsAvailabilityRoutes(client: PrismaClient): Router {
  const router = createRouter();
  const byCode = async (req: Request): Promise<Who | null> => {
    const code = (req.params as Record<string, string | undefined>)["code"];
    return code === undefined ? null : client.contractor.findUnique({ where: { code }, select: WHO_SELECT });
  };
  mount(router, client, "/:code", [Role.ops], byCode);
  return router;
}
