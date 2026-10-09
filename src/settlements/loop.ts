// The Monday run's heartbeat -- Feature 6003, settlement run.
//
// Contractor Settlement / Draft -> approve -> paid ("At 6:00am every Monday the platform runs by
// itself -- no button"). There is no scheduler library: like the notification dispatcher and the
// pay-link loop, this is a timer inside the API process. Every few minutes it asks `runWeekly`
// whether the period due now has been swept; `runWeekly` is idempotent, so a tick that finds the
// week already done changes nothing, and a Monday missed while the platform was down is simply
// the first tick after it starts again. One pass at a time; the per-contractor locks inside the
// sweep guard anything beyond this process.
import { getPrisma, type PrismaClient } from "../db/client.js";
import { runWeekly } from "./sweep.js";

export const SETTLEMENT_LOOP_MS = 5 * 60 * 1000;

export interface SettlementLoop {
  stop(): void;
}

export function startSettlementLoop(client: PrismaClient = getPrisma(), everyMs: number = SETTLEMENT_LOOP_MS): SettlementLoop {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    runWeekly(client)
      .then((result) => {
        if (result.made.length > 0) {
          console.log(`settlements: made ${String(result.made.length)} draft(s) for the period ending ${result.periodEnd}`);
        }
      })
      .catch((error: unknown) => {
        console.error("settlements: the weekly run failed -- it will be tried again", error);
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
