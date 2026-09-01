import type { ReactNode } from 'react';
import { looksLikeEmail } from '@budget/db';
import type { Currency } from '@budget/schema';
import { CurrencyPicker } from '../ui/currency';
import { Field, TextField } from '../ui/form';

/**
 * The three things the app asks about a person, asked the same way twice.
 *
 * Setup and the profile screen collect exactly the same fields, and they had
 * drifted: two wordings for what the email is for, two ideas of how a bad
 * address is flagged. Both are the same promise about the same data, so both
 * come from here.
 */

export interface ProfileFieldsProps {
  readonly name: string;
  readonly onName: (next: string) => void;
  readonly email: string;
  readonly onEmail: (next: string) => void;
  /** Undefined only before the profile has loaded; the picker is hidden then. */
  readonly currency: Currency | undefined;
  readonly onCurrency: (next: Currency) => void;
}

/** Whether an address is worth warning about. Empty is fine — it is optional. */
export function emailLooksWrong(email: string): boolean {
  return email.trim() !== '' && !looksLikeEmail(email);
}

export function ProfileFields({
  name,
  onName,
  email,
  onEmail,
  currency,
  onCurrency,
}: ProfileFieldsProps): ReactNode {
  const wrong = emailLooksWrong(email);

  return (
    <>
      <TextField
        label="Your name"
        value={name}
        onChangeText={onName}
        placeholder="Name"
        autoCapitalize="words"
        hint="Goes on exports and reports. Nothing else."
      />

      <TextField
        label="Email (optional)"
        value={email}
        onChangeText={onEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        {...(wrong
          ? { warning: 'That does not look like an email address.' }
          : {
              hint: 'Fills in the To field when you mail yourself an export. This app sends no mail on its own.',
            })}
      />

      {currency !== undefined && (
        <Field
          label="Record spending in"
          hint="You can record a spend in any currency; this is the one the keypad opens in."
        >
          <CurrencyPicker value={currency} onChange={onCurrency} />
        </Field>
      )}
    </>
  );
}
