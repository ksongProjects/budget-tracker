import { describe, expect, it } from 'vitest';
import { hasUnmaskedSecrets, passesAbaChecksum, passesLuhn, redact } from './redact.js';

/**
 * Test card numbers published by the networks for exactly this purpose. They
 * pass Luhn and belong to nobody.
 */
const VISA = '4111111111111111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';

describe('passesLuhn', () => {
  it('accepts real card numbers', () => {
    for (const card of [VISA, MASTERCARD, AMEX]) {
      expect(passesLuhn(card), card).toBe(true);
    }
  });

  it('rejects a number with a digit changed', () => {
    expect(passesLuhn('4111111111111112')).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(passesLuhn('4111-1111-1111-1111')).toBe(false);
  });
});

describe('passesAbaChecksum', () => {
  it('accepts a valid routing number', () => {
    // Chase's published routing number for New York.
    expect(passesAbaChecksum('021000021')).toBe(true);
  });

  it('rejects a number with a digit changed', () => {
    expect(passesAbaChecksum('021000022')).toBe(false);
  });

  it('rejects anything that is not nine digits', () => {
    expect(passesAbaChecksum('02100002')).toBe(false);
    expect(passesAbaChecksum('0210000211')).toBe(false);
  });
});

describe('card masking', () => {
  it('keeps only the last four digits', () => {
    const result = redact(`Card ${VISA}`);
    expect(result.text).toBe('Card ************1111');
    expect(result.text).not.toContain(VISA);
  });

  it('masks numbers written with spaces or dashes', () => {
    expect(redact('4111 1111 1111 1111').text).toContain('1111');
    expect(redact('4111 1111 1111 1111').text).not.toContain('4111 1111 1111 1111');
    expect(redact('4111-1111-1111-1111').text).not.toContain('4111-1111-1111-1111');
  });

  it('masks a 15-digit Amex', () => {
    const result = redact(`AMEX ${AMEX}`);
    expect(result.text).not.toContain(AMEX);
    expect(result.text).toContain('0005');
  });

  it('reports what it masked without repeating the original', () => {
    const result = redact(`Card ${VISA}`);
    expect(result.masked).toHaveLength(1);
    expect(result.masked[0]?.kind).toBe('card');
    expect(result.masked[0]?.replacement).not.toContain('4111111111111111');
  });

  it('leaves numbers that are not cards alone', () => {
    // Long digit runs that fail Luhn: order ids, timestamps, tracking numbers.
    for (const text of [
      'Order 1234567890123456',
      'Ref 9999999999999999',
      'Tracking 1Z999AA10123456784',
    ]) {
      expect(redact(text).masked.filter((m) => m.kind === 'card'), text).toHaveLength(0);
    }
  });

  it('leaves prices and totals alone', () => {
    const receipt = 'SUBTOTAL 9.75\nTAX 0.85\nTOTAL 10.60';
    expect(redact(receipt).text).toBe(receipt);
  });

  it('leaves an already-masked receipt line alone', () => {
    const line = 'VISA ****4242';
    expect(redact(line).text).toBe(line);
  });
});

describe('routing numbers', () => {
  it('masks a labelled routing number', () => {
    const result = redact('Routing: 021000021');
    expect(result.text).not.toContain('021000021');
    expect(result.masked[0]?.kind).toBe('routing');
  });

  it('recognises ABA and RTN labels', () => {
    expect(redact('ABA 021000021').masked).toHaveLength(1);
    expect(redact('RTN 021000021').masked).toHaveLength(1);
  });

  it('leaves an unlabelled nine-digit number alone', () => {
    // Far more often a date, an order id, or a phone number. Masking every one
    // would eat real data.
    expect(redact('Reference 021000021').masked).toHaveLength(0);
  });

  it('only masks on the line that carries the label', () => {
    const result = redact('Routing: 021000021\nOrder 021000021');
    expect(result.text.split('\n')[1]).toBe('Order 021000021');
  });
});

describe('account numbers', () => {
  it('masks a labelled account number', () => {
    const result = redact('Account Number: 123456789012');
    expect(result.text).not.toContain('123456789012');
    expect(result.text).toContain('9012');
  });

  it('recognises the common label spellings', () => {
    for (const text of ['Acct # 123456789012', 'A/C 123456789012', 'account no. 123456789012']) {
      expect(redact(text).masked.length, text).toBeGreaterThan(0);
    }
  });

  it('keeps the last four so the user can tell accounts apart', () => {
    expect(redact('Account: 123456789012').text).toContain('9012');
  });
});

describe('IBAN', () => {
  it('masks an IBAN', () => {
    const iban = 'GB82WEST12345698765432';
    const result = redact(`IBAN ${iban}`);
    expect(result.text).not.toContain(iban);
    expect(result.masked[0]?.kind).toBe('iban');
  });

  it('leaves short codes alone', () => {
    expect(redact('US12 ok').masked).toHaveLength(0);
  });
});

describe('a whole statement line block', () => {
  it('masks every identifier and keeps every amount', () => {
    const statement = [
      'FIRST NATIONAL BANK',
      'Account Number: 123456789012',
      'Routing: 021000021',
      `Card ${VISA}`,
      '',
      '03/14  BLUE BOTTLE COFFEE      10.60',
      '03/15  SAFEWAY                 42.18',
      'CLOSING BALANCE            1,204.55',
    ].join('\n');

    const result = redact(statement);

    expect(result.text).not.toContain('123456789012');
    expect(result.text).not.toContain('021000021');
    expect(result.text).not.toContain(VISA);

    // The data the user is here for survives intact.
    expect(result.text).toContain('10.60');
    expect(result.text).toContain('42.18');
    expect(result.text).toContain('1,204.55');
    expect(result.text).toContain('BLUE BOTTLE COFFEE');

    expect(result.masked.map((m) => m.kind).sort()).toEqual(['account', 'card', 'routing']);
  });
});

describe('hasUnmaskedSecrets', () => {
  it('is the check before any text leaves the device', () => {
    expect(hasUnmaskedSecrets(`Card ${VISA}`)).toBe(true);
    expect(hasUnmaskedSecrets('TOTAL 10.60')).toBe(false);
  });

  it('is false once the text has been redacted', () => {
    expect(hasUnmaskedSecrets(redact(`Card ${VISA}`).text)).toBe(false);
  });
});
