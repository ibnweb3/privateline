// Number formatting for SMS replies. Replies stay in the GSM-7 character set (plain ASCII, "$"),
// so each fits in standard SMS segments on any phone.

export function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A price per unit: cents below $1,000, whole dollars above $10,000. */
export function price(value: number): string {
  const digits = value >= 10_000 ? 0 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A token quantity with enough significant digits to be meaningful: 0.0048, 0.126, 12.5. */
export function quantity(value: number): string {
  if (value === 0) return "0";
  // Three significant digits below 1: 0.126, 0.00482.
  const digits = value >= 100 ? 2 : value >= 1 ? 3 : Math.min(8, 2 - Math.floor(Math.log10(value)));
  return Number(value.toFixed(digits)).toString();
}

export function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}
