import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CurrencySchema } from '@budget/schema';
import type { Currency } from '@budget/schema';
import type { Profile, ProfileInput } from '@budget/db';
import { useLedgerState } from '../db/provider';

/**
 * Who is using the app, held once for every screen that needs it.
 *
 * Read at startup rather than per screen: the answer decides whether the app
 * shows its own screens at all, and asking the database that question from six
 * places would be six chances to disagree.
 *
 * There is no account here and no server. "Signed in" means a name, an optional
 * address for exports, and the currency the keypad opens in.
 */

interface ProfileState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly profile: Profile | undefined;
  readonly error?: Error;
  // A property rather than a method signature: screens destructure this off the
  // context, and a method type carries a `this` that then has nowhere to go.
  readonly save: (input: ProfileInput) => Promise<void>;
}

const FALLBACK_CURRENCY = CurrencySchema.parse('USD');

const ProfileContext = createContext<ProfileState>({
  status: 'loading',
  profile: undefined,
  save: () => Promise.reject(new Error('the profile is not loaded yet')),
});

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  const ledgerState = useLedgerState();
  const [profile, setProfile] = useState<Profile | undefined>(undefined);
  const [status, setStatus] = useState<ProfileState['status']>('loading');
  const [error, setError] = useState<Error | undefined>(undefined);

  const ledger = ledgerState.status === 'ready' ? ledgerState.ledger : undefined;

  useEffect(() => {
    if (ledger === undefined) return;

    let cancelled = false;

    void ledger.profile
      .read()
      .then((found) => {
        if (cancelled) return;
        setProfile(found);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setStatus('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [ledger]);

  const save = useCallback(
    async (input: ProfileInput): Promise<void> => {
      if (ledger === undefined) throw new Error('the ledger is not open yet');
      setProfile(await ledger.profile.save(input));
    },
    [ledger],
  );

  const value = useMemo<ProfileState>(
    () => ({ status, profile, save, ...(error === undefined ? {} : { error }) }),
    [status, profile, save, error],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfileState(): ProfileState {
  return useContext(ProfileContext);
}

/**
 * The profile, for screens that only render once there is one.
 *
 * Screens behind the setup gate can rely on this; the gate is what guarantees
 * it, and a screen that rendered without one would be showing someone else's
 * defaults.
 */
export function useProfile(): Profile {
  const state = useContext(ProfileContext);
  if (state.profile === undefined) {
    throw new Error('useProfile called before the profile was set up');
  }
  return state.profile;
}

/**
 * The currency to record in, wherever an amount is entered.
 *
 * Falls back rather than throwing: an amount entry screen that crashes because
 * a preference is missing is worse than one that opens in dollars.
 */
export function useDefaultCurrency(): Currency {
  return useContext(ProfileContext).profile?.defaultCurrency ?? FALLBACK_CURRENCY;
}
