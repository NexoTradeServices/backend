// Whole-cent-integer money, formatted for a person -- Feature 3001.
//
// The two-tier price display and its confirmation/notice emails always show
// whole dollars in every design example ("$250", "$375") -- the seeded
// catalog rates are whole dollars too. Cents only show when a rate genuinely
// carries them, so a future non-round rate never silently loses precision.
export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  const isWhole = Number.isInteger(dollars);
  return `$${isWhole ? String(dollars) : dollars.toFixed(2)}`;
}
