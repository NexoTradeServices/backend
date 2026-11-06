// GET /api/needs-attention -- Feature 1020. Ops and owner. A list of { key, text, action }; later
// features add to it, so it holds no holiday-only shape. Built from the derived missingHolidays.
import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type { PrismaClient } from "../db/client.js";
import { requireRole } from "../auth/middleware.js";
import { Role } from "../generated/prisma/enums.js";
import { todayIn } from "../time/index.js";
import { missingHolidays, MINIMUM_HOLIDAYS } from "./missing.js";

export interface NeedsAttentionItem {
  key: string;
  text: string;
  /** The owner's link; absent for ops, whose text ends with the words to contact the administrator. */
  action: { label: string; href: string } | null;
}

export const CONTACT_ADMIN_WORDS = "Contact platform administrator.";

export async function needsAttention(client: PrismaClient, role: Role, onDay?: string): Promise<NeedsAttentionItem[]> {
  const settings = await client.platformSettings.findFirstOrThrow({ select: { timezone: true } });
  const today = onDay ?? todayIn(settings.timezone);
  const items: NeedsAttentionItem[] = [];
  // One line per state: years of the same state with the same kind of gap read as one ("NSW 2026 and 2027").
  const groups: { state: string; none: boolean; years: number[] }[] = [];
  for (const gap of await missingHolidays(client, today)) {
    const group = groups.find((g) => g.state === gap.state && g.none === gap.none);
    if (group) group.years.push(gap.year);
    else groups.push({ state: gap.state, none: gap.none, years: [gap.year] });
  }
  for (const group of groups) {
    const years = group.years.map(String).join(" and ");
    const text = group.none
      ? `No holidays entered for ${group.state} ${years}.`
      : `${group.state} ${years} ${group.years.length > 1 ? "have" : "has"} fewer than ${String(MINIMUM_HOLIDAYS)} holidays.`;
    items.push({
      key: `holidays:${group.state}:${group.years.map(String).join("-")}`,
      text: role === Role.owner ? text : `${text} ${CONTACT_ADMIN_WORDS}`,
      action:
        role === Role.owner
          ? { label: "Add holidays", href: `/ops/settings/holidays?holidayState=${group.state}&holidayYear=${String(group.years[0])}` }
          : null,
    });
  }
  return items;
}

export function needsAttentionRoutes(client: PrismaClient): Router {
  const router = createRouter();
  router.get("/", requireRole(Role.ops), (req: Request, res: Response) => {
    void (async () => {
      const role = req.authUser?.role ?? Role.ops;
      res.json({ items: await needsAttention(client, role) });
    })().catch((error: unknown) => {
      console.error("GET /api/needs-attention failed", error);
      res.status(500).json({ error: "internal error" });
    });
  });
  return router;
}
