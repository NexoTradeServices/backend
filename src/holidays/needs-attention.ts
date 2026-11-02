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
  for (const gap of await missingHolidays(client, today)) {
    const text = gap.none
      ? `No holidays entered for ${gap.state} ${String(gap.year)}.`
      : `${gap.state} ${String(gap.year)} has fewer than ${String(MINIMUM_HOLIDAYS)} holidays.`;
    items.push({
      key: `holidays:${gap.state}:${String(gap.year)}`,
      text: role === Role.owner ? text : `${text} ${CONTACT_ADMIN_WORDS}`,
      action:
        role === Role.owner
          ? { label: "Add holidays", href: `/ops/settings?holidayState=${gap.state}&holidayYear=${String(gap.year)}#public-holidays` }
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
