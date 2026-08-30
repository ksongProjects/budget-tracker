import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AccountRepository,
  CategoryRepository,
  MerchantRepository,
  TransactionRepository,
  migrate,
  systemClock,
} from '@budget/db';
import type { RepositoryContext, SqliteDriver } from '@budget/db';
import type { DeviceId } from '@budget/schema';
import { createExpoDriver } from './driver';
import { loadDeviceId } from './device-id';

/**
 * Opens the local database, runs migrations, and hands the repositories to the
 * tree. This is the whole "startup" story: no login, no fetch, no server. A
 * fresh install lands on an empty ledger, which is the intended behaviour, not
 * an error state.
 */

export interface Ledger {
  readonly transactions: TransactionRepository;
  readonly categories: CategoryRepository;
  readonly accounts: AccountRepository;
  readonly merchants: MerchantRepository;
  readonly driver: SqliteDriver;
  readonly deviceId: DeviceId;
}

type LedgerState =
  | { readonly status: 'opening' }
  | { readonly status: 'ready'; readonly ledger: Ledger }
  | { readonly status: 'failed'; readonly error: Error };

const LedgerContext = createContext<LedgerState>({ status: 'opening' });

const OPEN_TIMEOUT_MS = 10_000;

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out ${what}.`));
        }, OPEN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function LedgerProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<LedgerState>({ status: 'opening' });

  useEffect(() => {
    let cancelled = false;

    const open = async (): Promise<void> => {
      try {
        // A hung open is indistinguishable from a slow one on screen, and
        // "spinner forever" tells the user nothing about their own data.
        const driver = await withTimeout(createExpoDriver(), 'opening the database');
        await withTimeout(migrate(driver), 'running migrations');
        const deviceId = await loadDeviceId(driver);

        if (cancelled) {
          await driver.close();
          return;
        }

        const ctx: RepositoryContext = { driver, deviceId, clock: systemClock };
        setState({
          status: 'ready',
          ledger: {
            driver,
            deviceId,
            transactions: new TransactionRepository(ctx),
            categories: new CategoryRepository(ctx),
            accounts: new AccountRepository(ctx),
            merchants: new MerchantRepository(ctx),
          },
        });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    };

    void open();
    return () => {
      cancelled = true;
    };
  }, []);

  return <LedgerContext.Provider value={state}>{children}</LedgerContext.Provider>;
}

export function useLedgerState(): LedgerState {
  return useContext(LedgerContext);
}

/**
 * The ledger, for screens that only render once it is open. Throws otherwise,
 * because a screen reading a half-open database is a bug, not a state to
 * render around.
 */
export function useLedger(): Ledger {
  const state = useContext(LedgerContext);
  if (state.status !== 'ready') {
    throw new Error('useLedger called before the database was open');
  }
  return state.ledger;
}

/**
 * Re-runs `query` whenever `deps` change or `version` is bumped. Writes bump the
 * version through `useLedgerRefresh`, which is how lists stay current without a
 * subscription layer we do not need at this size.
 */
export function useQuery<T>(
  query: (ledger: Ledger) => Promise<T>,
  deps: readonly unknown[],
  version = 0,
): { data: T | undefined; error: Error | undefined; loading: boolean } {
  const ledger = useLedger();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    query(ledger)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ledger, version, ...deps]);

  return useMemo(() => ({ data, error, loading }), [data, error, loading]);
}
