/**
 * Masking of card numbers, bank account numbers, and routing numbers.
 *
 * Under ADR 0011 nothing leaves the device by default, so this is not the
 * privacy boundary it was in the server design. It still matters for the one
 * path that does leave: Cloud Assist sends extracted *text* on a per-capture
 * opt-in, and this is what decides that the text carries no account numbers.
 *
 * It is also what keeps a full PAN out of the local database when a statement
 * is parsed — a ledger that quietly accumulates card numbers is a liability
 * even when it never syncs.
 *
 * Errs toward masking. A masked total is visibly wrong and the user fixes it; a
 * leaked account number is invisible and permanent.
 */

export interface Redaction {
  readonly text: string;
  /** What was masked, for showing the user what will be sent. */
  readonly masked: readonly MaskedSpan[];
}

export interface MaskedSpan {
  readonly kind: 'card' | 'routing' | 'account' | 'iban';
  /** The replacement that was written, never the original value. */
  readonly replacement: string;
}

/** 13–19 digits, optionally split by spaces or dashes, as printed on cards. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Labelled account numbers: the label is the signal, since formats vary wildly. */
const LABELLED_ACCOUNT =
  /\b(acct|account|a\/c)\s*(?:number|no\.?|#)?\s*[:#]?\s*([\dxX*•-]{4,})/gi;

/** US routing numbers are exactly nine digits and have a checksum. */
const ROUTING_CANDIDATE = /\b(\d{9})\b/g;
const ROUTING_LABEL = /\b(routing|aba|rtn)\b/i;

/** IBAN: two letters, two check digits, then up to 30 alphanumerics. */
const IBAN_CANDIDATE = /\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/g;

export function redact(input: string): Redaction {
  const masked: MaskedSpan[] = [];
  let text = input;

  text = text.replace(IBAN_CANDIDATE, (match) => {
    if (!isPlausibleIban(match)) return match;
    const replacement = `${match.slice(0, 4)}${'*'.repeat(Math.max(match.length - 4, 4))}`;
    masked.push({ kind: 'iban', replacement });
    return replacement;
  });

  text = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    // Luhn keeps invoice numbers and long dates from being masked as cards,
    // while every real card number passes it.
    if (!passesLuhn(digits)) return match;

    // Last four is what receipts print and what users recognise; it is not
    // enough to reconstruct a card.
    const replacement = `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
    masked.push({ kind: 'card', replacement });
    return replacement;
  });

  text = redactRouting(text, masked);

  text = text.replace(LABELLED_ACCOUNT, (match, label: string, value: string) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4) return match;

    const replacement = `${label} ****${digits.slice(-4)}`;
    masked.push({ kind: 'account', replacement });
    return replacement;
  });

  return { text, masked };
}

/**
 * Nine-digit runs are masked only on a line that names a routing number.
 * Unlabelled nine-digit numbers are far more often dates, order ids, or phone
 * numbers, and masking every one of them would eat real data.
 */
function redactRouting(text: string, masked: MaskedSpan[]): string {
  return text
    .split('\n')
    .map((line) => {
      if (!ROUTING_LABEL.test(line)) return line;

      return line.replace(ROUTING_CANDIDATE, (match) => {
        if (!passesAbaChecksum(match)) return match;
        const replacement = `*****${match.slice(-4)}`;
        masked.push({ kind: 'routing', replacement });
        return replacement;
      });
    })
    .join('\n');
}

/** The Luhn check digit, as used by every major card network. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/** ABA routing checksum: a weighted sum over the nine digits. */
export function passesAbaChecksum(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;

  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = weights.reduce((total, weight, i) => total + weight * Number(digits[i]), 0);

  return sum % 10 === 0;
}

function isPlausibleIban(value: string): boolean {
  // Length varies by country; this only screens out obvious non-IBANs, since
  // the cost of masking a false positive is far lower than missing a real one.
  return value.length >= 15 && value.length <= 34;
}

/** True when the text still contains something that looks unmasked. */
export function hasUnmaskedSecrets(text: string): boolean {
  return redact(text).masked.length > 0;
}
