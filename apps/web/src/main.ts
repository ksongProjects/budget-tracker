import { migrate, systemClock } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import type { DeviceId } from '@budget/schema';
import { createLibsodiumBackend } from '@budget/crypto/libsodium';
import { DATABASE_NAME, createWebDriver } from './db/driver';
import type { WebDriver } from './db/driver';
import { createDatabaseWorker } from './db/worker-url';
import { importArchive, secretFor } from './backup/import';

/**
 * Startup, which is the whole "sign in" story: none.
 *
 * The page opens the local database, migrates it, and offers to open a Backup.
 * Screens for reading and editing the ledger arrive in 6.4; what is here is the
 * part that makes the browser useful at all — a phone's archive, opened.
 */

const app = document.querySelector('#app');

async function start(): Promise<void> {
  if (app === null) return;

  const driver = await createWebDriver({ worker: createDatabaseWorker() });
  await migrate(driver);

  render(driver, await summarise(driver));
  wireImport(driver);
}

async function summarise(driver: WebDriver): Promise<string> {
  const counted = await driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
  const n = counted?.n ?? 0;

  return driver.storage === 'opfs'
    ? `${String(n)} transactions, stored on this device.`
    : `${String(n)} transactions, in memory only — this browser would not give the app ` +
      'durable storage, so nothing here survives a reload.';
}

function render(driver: WebDriver, summary: string, status = ''): void {
  if (app === null) return;

  app.innerHTML = `
    <h1>Budget</h1>
    <p id="summary"></p>
    <section id="drop">
      <p>Open a backup from your phone.</p>
      <input type="file" id="file" accept=".btbk" />
      <input type="password" id="secret" placeholder="Backup password or recovery key" />
      <button id="open" type="button">Open backup</button>
    </section>
    <p id="status"></p>
  `;

  // textContent rather than markup: a merchant name off a receipt is not
  // trusted input, and it has no business being parsed as HTML.
  select('#summary').textContent = summary;
  select('#status').textContent = status;
  wireImport(driver);
}

function select(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing ${selector}`);
  return element;
}

let wired: WebDriver | undefined;

function wireImport(driver: WebDriver): void {
  if (wired === driver && document.querySelector('#open') === null) return;
  wired = driver;

  const drop = document.querySelector('#drop');
  const button = document.querySelector('#open');
  const file = document.querySelector<HTMLInputElement>('#file');
  if (drop === null || button === null || file === null) return;

  let chosen: File | undefined;
  file.addEventListener('change', () => {
    chosen = file.files?.[0];
  });

  for (const name of ['dragover', 'dragenter']) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
    });
  }

  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    const dropped = (event as DragEvent).dataTransfer?.files[0];
    if (dropped !== undefined) chosen = dropped;
    select('#status').textContent = chosen === undefined ? '' : `Ready: ${chosen.name}`;
  });

  button.addEventListener('click', () => {
    const secret = document.querySelector<HTMLInputElement>('#secret')?.value ?? '';
    void run(driver, chosen, secret);
  });
}

async function run(driver: WebDriver, file: File | undefined, typed: string): Promise<void> {
  const status = select('#status');

  if (file === undefined) {
    status.textContent = 'Choose a backup file first.';
    return;
  }
  if (typed.trim().length === 0) {
    status.textContent = 'Enter your backup password, or your recovery key.';
    return;
  }

  status.textContent = 'Opening…';

  try {
    const sodium = await createLibsodiumBackend();
    const archive = new Uint8Array(await file.arrayBuffer());
    const ctx: RepositoryContext & { readonly driver: WebDriver } = {
      driver,
      // Every browser is its own device for merge purposes, and the id has to
      // outlive a reload or two devices would look like one.
      deviceId: deviceId(),
      clock: systemClock,
    };

    const result = await importArchive(
      ctx,
      archive,
      secretFor(sodium, archive, typed),
      sodium,
      DATABASE_NAME,
    );

    const total = (field: 'inserted' | 'updated' | 'kept'): number =>
      Object.values(result.merged).reduce((sum, stats) => sum + stats[field], 0);

    render(
      driver,
      await summarise(driver),
      `Opened a backup from ${new Date(result.createdAt).toLocaleString()}: ` +
        `${String(total('inserted'))} rows added, ${String(total('updated'))} updated, ` +
        `${String(total('kept'))} already current.`,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    status.textContent = /unwrap|decrypt|authentic/i.test(message)
      ? 'That password or recovery key did not open this backup.'
      : message;
  }
}

const DEVICE_KEY = 'budget.deviceId';

function deviceId(): DeviceId {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored !== null) return stored as DeviceId;

  const minted = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, minted);
  return minted as DeviceId;
}

void start();
