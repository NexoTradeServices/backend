// The ABN check and its print form -- shared by the contractor record (Feature 1017's
// ancestor) and the customer's business details (Feature 6015).

/** The ATO's own check-digit algorithm (decision 10). */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export const ABN_ERROR = "An ABN is 11 digits with a valid check digit.";

export function isValidAbn(raw: string): boolean {
  const digits = raw.replace(/\s/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const values = digits.split("").map(Number);
  values[0] = (values[0] ?? 0) - 1;
  const sum = values.reduce((total, digit, index) => total + digit * (ABN_WEIGHTS[index] ?? 0), 0);
  return sum % 89 === 0;
}

/** "12 345 678 901" for eleven digits (spaces already there are ignored); anything else as it is. */
export function formatAbn(raw: string): string {
  const digits = raw.replace(/\s/g, "");
  if (!/^\d{11}$/.test(digits)) return raw.trim();
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
}
