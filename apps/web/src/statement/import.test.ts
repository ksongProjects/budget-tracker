import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../app';
import type { Session } from '../app';
import { RECOGNISED_STATEMENT, buildPdf } from './pdf-fixture';
import type { FixtureCell } from './pdf-fixture';

/**
 * Importing a statement, driven through the screen.
 *
 * The file goes in as a real `File` and the rows come out of the real database,
 * because the failures worth catching live between the two: a mapping that
 * points at the wrong column, a preview that disagrees with what gets written,
 * a second import that duplicates the first.
 */

const STATEMENT = `Date,Description,Amount
2026-03-14,BLUE BOTTLE COFFEE #1234,-4.50
2026-03-15,"SAFEWAY #0421, SEATTLE",-62.18
2026-03-16,RENT MARCH,"-1,850.00"
`;

/** Same three payments, re-downloaded: one posting date moved, as banks do. */
const REDOWNLOAD = `Date,Description,Amount
2026-03-14,BLUE BOTTLE COFFEE #9987,-4.50
2026-03-16,"SAFEWAY #0421, SEATTLE",-62.18
2026-03-16,RENT MARCH,"-1,850.00"
2026-03-20,NEW THING,-9.99
`;

let root: HTMLElement;
let session: Session;

beforeEach(async () => {
  localStorage.clear();
  location.hash = '#ledger';

  root = document.createElement('main');
  document.body.append(root);

  session = await start(root, {
    name: `statement-${String(Date.now())}-${String(Math.random())}.db`,
  });
});

afterEach(async () => {
  await session.close();
  root.remove();
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the screen');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function go(view: string): Promise<void> {
  location.hash = `#${view}`;
  await waitFor(() => root.querySelector(`#${view}`) !== null);
}

/**
 * The bits of a form control these tests touch.
 *
 * Intersecting the real element types collapses to `never` — their tag names
 * conflict — and the tests only ever want these four members.
 */
interface Control extends HTMLElement {
  value: string;
  files: FileList | null;
  disabled: boolean;
}

function field(selector: string): Control {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);

  return element as Control;
}

function text(selector: string): string {
  return root.querySelector(selector)?.textContent ?? '';
}

/**
 * Hand the file input a file.
 *
 * A DataTransfer is the only way to set `files` in a browser; assigning to it
 * directly is refused.
 */
function choose(csv: string, name = 'statement.csv'): void {
  const input = field('#statement-file');
  const data = new DataTransfer();

  data.items.add(new File([csv], name, { type: 'text/csv' }));
  input.files = data.files;
  input.dispatchEvent(new Event('change'));
}

async function importStatement(csv: string): Promise<void> {
  await go('import');
  choose(csv);

  await waitFor(() => root.querySelector('#statement-preview') !== null);
  field('#statement-preview').click();

  await waitFor(() => root.querySelector('#statement-preview-result') !== null);
  field('#statement-import').click();

  await waitFor(() => root.querySelector('#pending') !== null);
}

describe('mapping a file', () => {
  it('guesses the columns and says what it would do', async () => {
    await go('import');
    choose(STATEMENT);

    await waitFor(() => root.querySelector('#statement-preview') !== null);

    // Guessed, not asked for: the header names are ordinary ones.
    expect(field('#column-date').value).toBe('0');
    expect(field('#column-description').value).toBe('1');
    expect(field('#column-amount').value).toBe('2');

    field('#statement-preview').click();
    await waitFor(() => root.querySelector('#statement-preview-result') !== null);

    expect(text('#statement-preview-result')).toContain('3 to import');
  });

  it('will not preview until the required columns are chosen', async () => {
    await go('import');
    choose('One,Two,Three\na,b,c\n');

    await waitFor(() => root.querySelector('#statement-preview') !== null);

    expect(field('#statement-preview').disabled).toBe(true);
    expect(text('#statement-body')).toContain('before importing');
  });

  it('re-reads the file when the date order changes', async () => {
    // The same eight characters are two different days, and nothing in the file
    // says which. Changing the setting has to change the result.
    await go('import');
    choose('Date,Description,Amount\n03/04/2026,COFFEE,-4.50\n');

    await waitFor(() => root.querySelector('#statement-preview') !== null);
    field('#date-order').value = 'dmy';
    field('#date-order').dispatchEvent(new Event('change'));

    field('#statement-preview').click();
    await waitFor(() => text('#statement-sample') !== '');
    const asDmy = text('#statement-sample');

    field('#date-order').value = 'mdy';
    field('#date-order').dispatchEvent(new Event('change'));
    field('#statement-preview').click();

    // The previous sample is still on screen until the new preview replaces it,
    // so waiting for the element to exist would read the old answer.
    await waitFor(() => text('#statement-sample') !== asDmy);

    expect(text('#statement-sample')).not.toBe(asDmy);
  });

  it('reports a row it could not read, with its line number', async () => {
    await go('import');
    choose('Date,Description,Amount\n2026-03-14,COFFEE,-4.50\nnot a date,MYSTERY,-1.00\n');

    await waitFor(() => root.querySelector('#statement-preview') !== null);
    field('#statement-preview').click();
    await waitFor(() => root.querySelector('#statement-preview-result') !== null);

    expect(text('#statement-preview-result')).toContain('1 that could not be read');
    expect(text('#statement-problems')).toContain('Line 3');
  });
});

describe('a PDF from a bank we know', () => {
  function choosePdf(cells: readonly FixtureCell[]): void {
    const input = field('#statement-file');
    const data = new DataTransfer();

    data.items.add(
      new File([buildPdf(cells) as BlobPart], 'statement.pdf', { type: 'application/pdf' }),
    );
    input.files = data.files;
    input.dispatchEvent(new Event('change'));
  }

  it('says which bank it recognised, and needs no configuring', async () => {
    await go('import');
    choosePdf(RECOGNISED_STATEMENT);

    await waitFor(() => root.querySelector('#statement-recognised') !== null);
    expect(text('#statement-recognised')).toContain('First National Bank');
    // The version is part of it: a wrong import should be traceable to a rule,
    // not argued about.
    expect(text('#statement-recognised')).toContain('@1');

    field('#statement-preview').click();
    await waitFor(() => root.querySelector('#statement-preview-result') !== null);
    expect(text('#statement-preview-result')).toContain('3 to import');

    field('#statement-import').click();
    await waitFor(() => root.querySelector('#pending') !== null);

    await go('ledger');
    expect(text('#ledger')).toContain('BLUE BOTTLE COFFEE');
    expect(text('#ledger')).toContain('4.50 USD');
  });

  it('says so when a PDF carries no text layer', async () => {
    await go('import');
    // A valid PDF with nothing written in it — a scan, as far as Tier 1 goes.
    choosePdf([]);

    await waitFor(() => root.querySelector('#statement-error') !== null);
    expect(text('#statement-error')).toContain('scanned');
  });
});


describe('importing', () => {
  it('puts the rows in the ledger, unconfirmed', async () => {
    await importStatement(STATEMENT);

    expect(text('#pending')).toContain('3 entries are waiting');

    await go('ledger');
    expect(text('#ledger')).toContain('RENT MARCH');
    expect(text('#ledger')).toContain('1850.00 USD');

    // Unconfirmed rows are shown but never counted.
    await go('summary');
    expect(text('#summary')).toContain('nothing to total');
  });

  it('adds nothing when the same file is imported again', async () => {
    // The acceptance criterion, through the screen this time.
    await importStatement(STATEMENT);
    await go('import');
    choose(STATEMENT);

    await waitFor(() => root.querySelector('#statement-preview') !== null);
    field('#statement-preview').click();
    await waitFor(() => root.querySelector('#statement-preview-result') !== null);

    expect(text('#statement-preview-result')).toContain('0 to import');
    expect(text('#statement-preview-result')).toContain('3 already in your ledger');
    expect(field('#statement-import').disabled).toBe(true);
  });

  it('takes only what is new from an overlapping re-download', async () => {
    await importStatement(STATEMENT);
    await go('import');
    choose(REDOWNLOAD);

    await waitFor(() => root.querySelector('#statement-preview') !== null);
    field('#statement-preview').click();
    await waitFor(() => root.querySelector('#statement-preview-result') !== null);

    // Three are the same payments — one with a different store number, one with
    // a posting date that moved by a day — and one is genuinely new.
    expect(text('#statement-preview-result')).toContain('1 to import');
    expect(text('#statement-preview-result')).toContain('3 already in your ledger');
  });
});

describe('confirming what was imported', () => {
  it('counts them only once confirmed', async () => {
    await importStatement(STATEMENT);

    field('#confirm-selected').click();
    await waitFor(() => text('#notice').includes('Confirmed'));

    await go('summary');
    expect(text('#summary')).toContain('1916.68 USD');
  });

  it('leaves the unticked ones waiting', async () => {
    await importStatement(STATEMENT);

    const boxes = root.querySelectorAll<HTMLInputElement>('.pending-row');
    if (boxes[0] !== undefined) boxes[0].checked = false;

    field('#confirm-selected').click();
    await waitFor(() => text('#notice').includes('Confirmed'));

    await go('pending');
    expect(text('#pending')).toContain('1 entries are waiting');
  });

  it('says so when there is nothing waiting', async () => {
    await go('pending');
    expect(text('#pending')).toContain('Nothing is waiting');
  });
});
