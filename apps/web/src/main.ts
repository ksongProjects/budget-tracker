import { start } from './app';

/**
 * Startup, which is the whole "sign in" story: none.
 *
 * A fresh visit lands on an empty ledger. That is the intended state, not an
 * error — the data arrives by being typed here or by opening a backup.
 */
const root = document.querySelector<HTMLElement>('#app');

if (root !== null) {
  void start(root).catch((cause: unknown) => {
    root.textContent =
      cause instanceof Error
        ? `Could not open your ledger: ${cause.message}`
        : 'Could not open your ledger.';
  });
}
