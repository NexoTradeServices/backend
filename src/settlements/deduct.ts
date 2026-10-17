// The deduction rule -- Feature 6007, correct & reissue and pay adjustments.
//
// Contractor Settlement / Pay adjustments and corrections: "A deduction takes up to the whole of a
// week's pay for work, never more." Pay for work is the visits' labour plus every plus row; a minus
// row (a correction) takes from it, oldest first, and never below zero. What a minus row cannot take
// waits for the next run. ONE pure function, used by the sweep (what a draft takes), by the next
// payout and by its list, so the three can never disagree.

export interface PayRow {
  id: string;
  /** cents, plus or minus */
  amount: number;
  jobId: string | null;
  createdAt: Date;
}

export interface Deduction {
  /** the part of each minus row this run takes, in cents (positive); 0 when none */
  taken: Map<string, number>;
  /** minus rows with something left over, in the order they were made */
  left: { id: string; jobId: string | null; amount: number }[];
  /** the sum of everything left over, in cents (positive) */
  stillToDeduct: number;
}

/** `available` is the visits' labour plus the plus rows. */
export function applyDeductions(available: number, rows: readonly PayRow[]): Deduction {
  const minus = rows
    .filter((row) => row.amount < 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const taken = new Map<string, number>();
  const left: Deduction["left"] = [];
  let room = Math.max(0, available);
  for (const row of minus) {
    const owed = -row.amount;
    const take = Math.min(owed, room);
    room -= take;
    taken.set(row.id, take);
    if (take < owed) left.push({ id: row.id, jobId: row.jobId, amount: owed - take });
  }
  return { taken, left, stillToDeduct: left.reduce((sum, row) => sum + row.amount, 0) };
}

/** Labour plus the plus rows: the pay for work a deduction can take from. */
export function payForWorkBefore(labour: number, rows: readonly { amount: number }[]): number {
  return labour + rows.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0);
}
