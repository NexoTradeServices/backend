// Billed hours -- Feature 5001, contractor job screen.
//
// Invoicing / Two-tier pricing: floors apply per attendance (= per time
// entry). The FIRST visit -- the earliest entry, whatever order they were
// typed in -- bills at least one hour (Tier 1's hour); every later entry
// bills at least `returnVisitMinimumMinutes`. Above its floor each entry
// rounds UP to the next 15 minutes. Summed, in hours, two decimals.
export const FIRST_VISIT_MINIMUM_MINUTES = 60;
const BLOCK_MINUTES = 15;

export interface TimeSpan {
  startedAt: Date;
  endedAt: Date;
}

/** One attendance's billed minutes: floored, then rounded up to the next 15. */
export function billedMinutesOf(minutes: number, floorMinutes: number): number {
  const floored = Math.max(minutes, floorMinutes);
  return Math.ceil(floored / BLOCK_MINUTES) * BLOCK_MINUTES;
}

export function billedHours(entries: readonly TimeSpan[], returnVisitMinimumMinutes: number): number {
  if (entries.length === 0) return 0;
  const ordered = [...entries].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  let total = 0;
  ordered.forEach((entry, index) => {
    const minutes = (entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000;
    total += billedMinutesOf(minutes, index === 0 ? FIRST_VISIT_MINIMUM_MINUTES : returnVisitMinimumMinutes);
  });
  return Math.round((total / 60) * 100) / 100;
}
