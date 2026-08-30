import { migrate } from '@budget/db';
import { createWebDriver } from './db/driver';
import { createDatabaseWorker } from './db/worker-url';

/**
 * Startup, which is the whole "sign in" story: none.
 *
 * The page opens the local database, migrates it, and reports where it lives.
 * Screens arrive in 6.4; this exists so the scaffold is something that runs
 * rather than something that compiles.
 */
async function start(): Promise<void> {
  const app = document.querySelector('#app');
  if (app === null) return;

  const driver = await createWebDriver({ worker: createDatabaseWorker() });
  await migrate(driver);

  const counted = await driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');

  app.textContent =
    driver.storage === 'opfs'
      ? `Ledger open: ${String(counted?.n ?? 0)} transactions, stored on this device.`
      : `Ledger open in memory: ${String(counted?.n ?? 0)} transactions. This browser would ` +
        'not give the app durable storage, so nothing here survives a reload.';
}

void start();
