import { TransactionRepository, migrate, systemClock } from '@budget/db';
import type { RepositoryContext } from '@budget/db';
import { CurrencySchema, parseAmount } from '@budget/schema';
import type { DeviceId, Timestamp } from '@budget/schema';
import { dayLabel, formatAmount } from './deps';
import { DATABASE_NAME, createWebDriver } from './db/driver';
import type { WebDriver } from './db/driver';
import { createDatabaseWorker } from './db/worker-url';
import { importArchive, secretFor } from './backup/import';
import { allRows, displayAmount, groupByDay, monthTotals, recentRows } from './ledger/rows';
import type { LedgerRow } from './ledger/rows';
import { csvExport, printReport, reportHtml, save } from './export/download';

/**
 * The web app: a ledger you can read, add to, and get back out.
 *
 * Plain DOM rather than a framework. The screens are a list, a summary, a form
 * and two file operations; a framework would be more code to audit than the app
 * it renders, and Phase 6 has to promise a bundle with no third-party scripts
 * in it.
 *
 * Every string that came from a user or a receipt is set with `textContent`.
 * Nothing here builds markup out of data.
 */

type View = 'ledger' | 'summary' | 'add' | 'backup' | 'export';

interface App {
  readonly ctx: RepositoryContext;
  readonly driver: WebDriver;
  readonly transactions: TransactionRepository;
}

let app: App | undefined;
let view: View = 'ledger';
let notice = '';

export interface Session {
  /** Releases the worker, and with it the exclusive OPFS handles it holds. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Which database file to open. Tests give each case its own. */
  readonly name?: string;
}

export async function start(root: HTMLElement, options: StartOptions = {}): Promise<Session> {
  const driver = await createWebDriver({
    worker: createDatabaseWorker(),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  await migrate(driver);

  const ctx: RepositoryContext = { driver, deviceId: deviceId(), clock: systemClock };
  app = { ctx, driver, transactions: new TransactionRepository(ctx) };

  // Removed on close. A listener that outlives its session renders against a
  // database that is gone — harmless in an app with one session, and an
  // unhandled rejection in anything that starts a second.
  const onHashChange = (): void => {
    if (app === undefined) return;
    view = routeOf(location.hash);
    notice = '';
    void render(root);
  };
  window.addEventListener('hashchange', onHashChange);

  view = routeOf(location.hash);
  await render(root);

  return {
    async close() {
      window.removeEventListener('hashchange', onHashChange);
      app = undefined;
      await driver.wipe();
      await driver.close();
    },
  };
}

function routeOf(hash: string): View {
  const name = hash.replace('#', '');
  return name === 'summary' || name === 'add' || name === 'backup' || name === 'export'
    ? name
    : 'ledger';
}

async function render(root: HTMLElement): Promise<void> {
  const current = required();
  root.replaceChildren();
  root.append(nav(), noticeLine());

  switch (view) {
    case 'ledger':
      root.append(await ledgerView(current));
      break;
    case 'summary':
      root.append(await summaryView(current));
      break;
    case 'add':
      root.append(addView(root));
      break;
    case 'backup':
      root.append(backupView(root, current));
      break;
    case 'export':
      root.append(exportView(current));
      break;
  }
}

function nav(): HTMLElement {
  const bar = element('nav');

  for (const [name, label] of [
    ['ledger', 'Ledger'],
    ['summary', 'Summary'],
    ['add', 'Add'],
    ['backup', 'Backup'],
    ['export', 'Export'],
  ] as const) {
    const link = element('a', label);
    link.setAttribute('href', `#${name}`);
    if (view === name) link.setAttribute('aria-current', 'page');
    bar.append(link);
  }

  return bar;
}

function noticeLine(): HTMLElement {
  const line = element('p', notice);
  line.id = 'notice';
  return line;
}

async function ledgerView(current: App): Promise<HTMLElement> {
  const rows = await recentRows(current.ctx);
  const section = element('section');
  section.id = 'ledger';

  section.append(
    element(
      'p',
      current.driver.storage === 'opfs'
        ? `${String(rows.length)} recent entries, stored on this device.`
        : `${String(rows.length)} recent entries, in memory only — this browser would not ` +
          'give the app durable storage, so nothing here survives a reload.',
    ),
  );

  if (rows.length === 0) {
    section.append(element('p', 'Nothing captured yet. Add a spend, or open a backup.'));
    return section;
  }

  for (const day of groupByDay(rows)) {
    section.append(element('h2', dayLabel(day.dayKey, Date.now())));
    const list = element('ul');

    for (const row of day.rows) {
      list.append(rowItem(row));
    }
    section.append(list);
  }

  return section;
}

function rowItem(row: LedgerRow): HTMLElement {
  const item = element('li');
  item.dataset['id'] = row.id;

  item.append(element('span', row.merchant ?? row.note ?? 'Unnamed'));
  item.append(element('span', displayAmount(row)));
  if (!row.confirmed) {
    const pending = element('span', 'pending');
    pending.className = 'pending';
    item.append(pending);
  }

  return item;
}

async function summaryView(current: App): Promise<HTMLElement> {
  const rows = await recentRows(current.ctx, 5000);
  const section = element('section');
  section.id = 'summary';

  const totals = monthTotals(rows);
  if (totals.length === 0) {
    section.append(element('p', 'Nothing confirmed yet, so there is nothing to total.'));
    return section;
  }

  section.append(
    element('p', 'Confirmed entries only. Unconfirmed ones are shown in the ledger but never counted.'),
  );

  const list = element('ul');
  for (const total of totals) {
    list.append(
      element('li', `${total.label}: ${formatAmount(total.totalMinor, total.currency)} ${total.currency}`),
    );
  }
  section.append(list);

  return section;
}

function addView(root: HTMLElement): HTMLElement {
  const section = element('section');
  section.id = 'add';

  const amount = input('amount', 'Amount, e.g. 4.50');
  const currency = input('currency', 'Currency');
  currency.value = 'USD';
  const note = input('note', 'What was it?');

  const submit = element('button', 'Add');
  submit.type = 'button';
  submit.id = 'submit';

  submit.addEventListener('click', () => {
    void addTransaction(root, amount.value, currency.value, note.value);
  });

  section.append(amount, currency, note, submit);
  return section;
}

async function addTransaction(
  root: HTMLElement,
  amount: string,
  currencyText: string,
  note: string,
): Promise<void> {
  const current = required();

  try {
    const currency = CurrencySchema.parse(currencyText.trim().toUpperCase());
    const minor = parseAmount(amount.trim(), currency);

    await current.transactions.create({
      captureId: null,
      accountId: null,
      merchantId: null,
      categoryId: null,
      amountMinor: minor,
      currency,
      occurredAt: Date.now() as Timestamp,
      postedAt: null,
      note: note.trim() === '' ? null : note.trim(),
      source: 'manual',
      // Typed by hand, so it is confirmed the moment it exists: there is no
      // extraction to second-guess.
      confirmedAt: Date.now() as Timestamp,
      fxOriginalMinor: null,
      fxOriginalCurrency: null,
      fxRate: null,
      reconciled: false,
    });

    notice = `Added ${formatAmount(minor, currency)} ${currency}.`;
    view = 'ledger';
    location.hash = '#ledger';
  } catch (cause) {
    notice = cause instanceof Error ? cause.message : String(cause);
  }

  await render(root);
}

function backupView(root: HTMLElement, current: App): HTMLElement {
  const section = element('section');
  section.id = 'backup';

  section.append(
    element(
      'p',
      'Open a backup written by the phone app. Your current entries are kept — restoring ' +
        'merges the backup in and never removes anything newer.',
    ),
  );

  const file = element('input');
  file.type = 'file';
  file.id = 'file';
  file.accept = '.btbk';

  const secret = input('secret', 'Backup password or recovery key');
  secret.type = 'password';

  const open = element('button', 'Open backup');
  open.type = 'button';
  open.id = 'open';

  open.addEventListener('click', () => {
    void openBackup(root, current, file.files?.[0], secret.value);
  });

  for (const name of ['dragover', 'dragenter']) {
    section.addEventListener(name, (event) => {
      event.preventDefault();
    });
  }
  section.addEventListener('drop', (event: DragEvent) => {
    event.preventDefault();
    const dropped = event.dataTransfer?.files;
    if (dropped !== undefined && dropped.length > 0) file.files = dropped;
  });

  section.append(file, secret, open);
  return section;
}

async function openBackup(
  root: HTMLElement,
  current: App,
  file: File | undefined,
  typed: string,
): Promise<void> {
  if (file === undefined) {
    notice = 'Choose a backup file first.';
    await render(root);
    return;
  }
  if (typed.trim() === '') {
    notice = 'Enter your backup password, or your recovery key.';
    await render(root);
    return;
  }

  notice = 'Opening…';
  await render(root);

  try {
    // Loaded on demand: libsodium is a third of the bundle and is needed only
    // by someone opening a backup, which is not most visits.
    const { createLibsodiumBackend } = await import('@budget/crypto/libsodium');
    const sodium = await createLibsodiumBackend();
    const archive = new Uint8Array(await file.arrayBuffer());

    const result = await importArchive(
      { ...current.ctx, driver: current.driver },
      archive,
      secretFor(sodium, archive, typed),
      sodium,
      DATABASE_NAME,
    );

    const total = (field: 'inserted' | 'updated' | 'kept'): number =>
      Object.values(result.merged).reduce((sum, stats) => sum + stats[field], 0);

    notice =
      `Opened a backup from ${new Date(result.createdAt).toLocaleString()}: ` +
      `${String(total('inserted'))} added, ${String(total('updated'))} updated, ` +
      `${String(total('kept'))} already current.`;
    view = 'ledger';
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    notice = /unwrap|decrypt|authentic/i.test(message)
      ? 'That password or recovery key did not open this backup.'
      : message;
  }

  await render(root);
}

function exportView(current: App): HTMLElement {
  const section = element('section');
  section.id = 'export';

  const warning = element(
    'p',
    'Exports are not protected. A CSV or a printed report is plain text: anyone who opens ' +
      'the file can read every entry. It is for spreadsheets and taxes, not for backup — ' +
      'nothing can be restored from it.',
  );
  warning.className = 'warning';
  section.append(warning);

  const csv = element('button', 'Download CSV');
  csv.type = 'button';
  csv.id = 'csv';
  csv.addEventListener('click', () => {
    void (async () => {
      save(csvExport(await allRows(current.ctx)));
      notice = 'CSV downloaded. It is not encrypted.';

      const line = document.querySelector('#notice');
      if (line !== null) line.textContent = notice;
    })();
  });

  const pdf = element('button', 'Print report');
  pdf.type = 'button';
  pdf.id = 'pdf';
  pdf.addEventListener('click', () => {
    void (async () => {
      printReport(reportHtml(await allRows(current.ctx), 'All time'));
    })();
  });

  section.append(csv, pdf);
  return section;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  // textContent, never innerHTML: a merchant name off a receipt is untrusted
  // input and has no business being parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(id: string, placeholder: string): HTMLInputElement {
  const field = element('input');
  field.id = id;
  field.placeholder = placeholder;
  return field;
}

function required(): App {
  if (app === undefined) throw new Error('the app is not started');
  return app;
}

const DEVICE_KEY = 'budget.deviceId';

/**
 * This browser's identity for merge purposes.
 *
 * It has to survive a reload: a device id that changed each visit would make
 * every merge tie-break look like a different device, and the tie-break exists
 * precisely to be deterministic.
 */
function deviceId(): DeviceId {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored !== null) return stored as DeviceId;

  const minted = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, minted);
  return minted as DeviceId;
}
