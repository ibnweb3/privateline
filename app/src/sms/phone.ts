// Phone-number handling, ported from BinaText's src/shared/phone.ts.

export class BadPhoneNumberError extends Error {}

/**
 * Normalize to strict E.164 (`+` then 8-15 digits, no leading zero). A Nigerian number typed
 * locally ("0803 123 4567") becomes +234803... when `defaultCountryCode` is "234".
 */
export function normalizeE164(raw: string, defaultCountryCode = "234"): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d]/g, "");
  if (!trimmed.startsWith("+")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
  }
  const e164 = `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new BadPhoneNumberError(`"${raw}" is not a valid phone number`);
  return e164;
}

/** For logs and screens: "+234****4567". */
export function maskPhone(e164: string): string {
  return e164.length <= 8 ? "****" : `${e164.slice(0, 4)}****${e164.slice(-4)}`;
}
