// The daily sweep -- Feature 6008, invoice reminders and void.
//
// The ONE shared morning run. There is no scheduler library: like the settlement loop, this is a
// timer inside the API process. Every few minutes it asks whether today's run is due (the business
// clock, PlatformSettings.timezone, is at or past 9:00am) and, if so, runs every step in
// DAILY_STEPS. Nothing is stored to say "today's run is done": every step is idempotent, so a
// tick that finds the work done changes nothing, and a morning missed while the platform was down
// is simply the first tick after it starts again. One pass at a time. One failing step logs and
// never stops the others.
//
// HOOKING ON. A later feature that wants the morning run (the
// photo clean-up) adds a step to DAILY_STEPS below -- never a second timer.
import type { PrismaClient } from "../db/client.js";
import { getPrisma } from "../db/client.js";
import { runInvoiceReminders } from "../invoices/reminders.js";
import { runPayLinkSwitchOff } from "../invoices/void.js";
import { runExpiryAlerts } from "../contractors/expiry-alerts.js";
import { runJobTomorrowReminders } from "../jobs/job-tomorrow.js";
import { clockTimeIn, todayIn } from "../time/index.js";

export const DAILY_LOOP_MS = 5 * 60 * 1000;
/** The business clock reads this or later: the run is due. */
export const DAILY_RUN_AT = "09:00";

export interface DailyContext {
  client: PrismaClient;
  /** The business zone (PlatformSettings.timezone). */
  zone: string;
  now: Date;
  /** The business day being run, `YYYY-MM-DD`. */
  today: string;
  /** Only a browser test's run sets this: every step does only the work carrying this label. */
  label: string | null;
}

export interface DailyStep {
  name: string;
  run(context: DailyContext): Promise<void>;
}

/** Each step of the morning run, in order. Later features append. */
export const DAILY_STEPS: DailyStep[] = [
  {
    name: "invoice reminders",
    async run({ client, zone, now, today, label }) {
      const made = await runInvoiceReminders(client, { zone, now, today, onlyLabel: label });
      if (made.first + made.second > 0) {
        console.log(`daily: invoice reminders -- ${String(made.first)} first, ${String(made.second)} second`);
      }
    },
  },
  {
    name: "pay-link switch-off",
    async run({ client, now, label }) {
      await runPayLinkSwitchOff(client, now, label);
    },
  },
  {
    name: "licence and insurance alerts",
    async run({ client, zone, today, label }) {
      const made = await runExpiryAlerts(client, { zone, today, onlyLabel: label });
      if (made.sent > 0) console.log(`daily: licence and insurance alerts -- ${String(made.sent)} emailed`);
    },
  },
  {
    name: "job-tomorrow reminders",
    async run({ client, zone, now, today, label }) {
      const made = await runJobTomorrowReminders(client, { zone, now, today, runAt: DAILY_RUN_AT, onlyLabel: label });
      if (made.visits > 0) console.log(`daily: job-tomorrow reminders -- ${String(made.visits)} visits`);
    },
  },
];

export interface DailyResult {
  ran: string[];
  failed: string[];
}

/** Is the morning run due at `now` on `zone`'s clock? */
export function dailyRunIsDue(zone: string, now: Date): boolean {
  return clockTimeIn(zone, now) >= DAILY_RUN_AT;
}

/** Every step, now, whatever the hour. `today` runs it as another business day. */
export async function runDailySteps(
  client: PrismaClient,
  options: { zone?: string; now?: Date; today?: string; label?: string | null; steps?: DailyStep[] } = {},
): Promise<DailyResult> {
  const zone = options.zone ?? (await client.platformSettings.findFirstOrThrow({ select: { timezone: true } })).timezone;
  const now = options.now ?? new Date();
  const context: DailyContext = { client, zone, now, today: options.today ?? todayIn(zone, now), label: options.label ?? null };
  const result: DailyResult = { ran: [], failed: [] };
  for (const step of options.steps ?? DAILY_STEPS) {
    try {
      await step.run(context);
      result.ran.push(step.name);
    } catch (error: unknown) {
      result.failed.push(step.name);
      console.error(`daily: the "${step.name}" step failed -- it will be tried again`, error);
    }
  }
  return result;
}

/** One tick: the steps if the morning has come on the business clock; nothing before 9:00am. */
export async function dailyTick(client: PrismaClient, now: Date = new Date()): Promise<DailyResult | null> {
  const settings = await client.platformSettings.findFirst({ select: { timezone: true } });
  if (settings === null || !dailyRunIsDue(settings.timezone, now)) return null;
  return runDailySteps(client, { zone: settings.timezone, now });
}

export interface DailyLoop {
  stop(): void;
}

export function startDailyLoop(client: PrismaClient = getPrisma(), everyMs: number = DAILY_LOOP_MS): DailyLoop {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    dailyTick(client)
      .catch((error: unknown) => {
        console.error("daily: the morning run failed -- it will be tried again", error);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
