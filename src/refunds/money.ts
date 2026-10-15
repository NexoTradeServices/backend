// Money as the refund wording writes it -- Feature 6006.
//
// "$540", "$1,320", "$12.50": thousands separated, cents only when the amount carries them.
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
