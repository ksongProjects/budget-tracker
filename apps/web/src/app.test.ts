import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { start } from './app';
import type { Session } from './app';

/**
 * The screens, driven the way a person drives them.
 *
 * These run against the real database in OPFS — no stubbed repository — because
 * the bugs worth catching here live in the seam between a form and a ledger,
 * and a mocked ledger has no seam.
 *
 * A session per case, each with its own database file: the OPFS pool hands its
 * access handles to one worker at a time, so the previous case has to let go
 * before the next one can start.
 */

let root: HTMLElement;
let session: Session;

beforeEach(async () => {
  localStorage.clear();
  location.hash = '#ledger';

  root = document.createElement('main');
  document.body.append(root);

  session = await start(root, { name: `app-${String(Date.now())}-${String(Math.random())}.db` });
});

afterEach(async () => {
  await session.close();
  root.remove();
});

async function go(view: string): Promise<void> {
  location.hash = `#${view}`;
  // The hashchange handler renders asynchronously.
  await waitFor(() => root.querySelector(`#${view}`) !== null || view === 'edit');
}

/**
 * Wait for the screen to say something, rather than for a number of
 * milliseconds.
 *
 * A fixed delay is a guess about the slowest machine that will ever run this,
 * and CI is always slower than the machine the guess was made on. This one
 * failed there and passed here, which is the whole reason it is polling now.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the screen');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function addSpend(amount: string, note: string): Promise<void> {
  await go('add');

  field('#amount').value = amount;
  field('#note').value = note;
  field('#submit').click();

  // Either it landed on the ledger, or the form is still up with a complaint.
  await waitFor(() => root.querySelector('#ledger') !== null || text('#notice') !== '');
}

function field(selector: string): HTMLInputElement {
  const element = root.querySelector<HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
}

function text(selector: string): string {
  return root.querySelector(selector)?.textContent ?? '';
}

describe('the ledger screen', () => {
  it('starts empty and says so', () => {
    expect(root.textContent).toContain('Nothing captured yet');
  });

  it('shows a spend after it is added', async () => {
    await addSpend('4.50', 'coffee');

    expect(text('#ledger')).toContain('coffee');
    expect(text('#ledger')).toContain('4.50 USD');
  });

  it('says where the ledger is stored', async () => {
    await go('ledger');
    expect(text('#ledger')).toContain('stored on this device');
  });

  it('refuses an amount it cannot parse instead of storing a guess', async () => {
    await addSpend('abou7 five', 'coffee');

    expect(text('#notice')).not.toBe('');

    await go('ledger');
    expect(root.textContent).toContain('Nothing captured yet');
  });
});

describe('editing a spend', () => {
  async function openFirstRow(): Promise<void> {
    await go('ledger');
    root.querySelector<HTMLAnchorElement>('#ledger a.open')?.click();
    await waitFor(() => root.querySelector('#edit') !== null);
  }

  it('opens from the ledger', async () => {
    await addSpend('4.50', 'coffee');
    await openFirstRow();

    expect(field('#edit-amount').value).toBe('4.50');
    expect(field('#edit-note').value).toBe('coffee');
  });

  it('saves a corrected amount', async () => {
    await addSpend('4.50', 'coffee');
    await openFirstRow();

    field('#edit-amount').value = '5.25';
    field('#save').click();
    await waitFor(() => text('#ledger').includes('5.25 USD'));

    expect(text('#ledger')).toContain('5.25 USD');
  });

  it('refuses an amount it cannot read rather than storing a guess', async () => {
    await addSpend('4.50', 'coffee');
    await openFirstRow();

    field('#edit-amount').value = 'about five';
    field('#save').click();
    await waitFor(() => text('#notice') !== '');

    expect(text('#notice')).not.toBe('');
    await go('ledger');
    expect(text('#ledger')).toContain('4.50 USD');
  });

  it('removes a deleted row from the ledger', async () => {
    await addSpend('4.50', 'coffee');
    await openFirstRow();

    field('#delete').click();
    await waitFor(() => root.textContent?.includes('Nothing captured yet') === true);

    expect(root.textContent).toContain('Nothing captured yet');
  });

  it('keeps a deleted row out of the totals', async () => {
    await addSpend('4.50', 'coffee');
    await addSpend('5.50', 'lunch');
    await openFirstRow();

    field('#delete').click();
    await waitFor(() => root.querySelector('#ledger') !== null);
    await go('summary');

    // Whichever row was first, one of them is gone and the total is the other.
    expect(text('#summary')).not.toContain('10.00 USD');
  });
});

describe('the summary screen', () => {
  it('totals what has been confirmed', async () => {
    await addSpend('4.50', 'coffee');
    await addSpend('5.50', 'lunch');

    await go('summary');

    expect(text('#summary')).toContain('10.00 USD');
  });

  it('says so plainly when there is nothing to total', async () => {
    await go('summary');
    expect(text('#summary')).toContain('nothing to total');
  });
});

describe('the export screen', () => {
  it('warns that the file is not protected before offering it', async () => {
    await go('export');

    expect(text('.warning')).toContain('not protected');
    expect(text('.warning')).toContain('not for backup');
  });
});

describe('the backup screen', () => {
  it('lists what is on Drive', async () => {
    // The suite points the connector at the stand-in, so this exercises the
    // screen against a real listing rather than a stubbed one.
    const { createDriveConnector } = await import('./cloud/drive');
    const { archiveName } = await import('@budget/backup');
    await createDriveConnector().upload(archiveName('web0', Date.now()), new Uint8Array(64));

    await go('backup');
    field('#list-drive').click();
    await waitFor(() => root.querySelectorAll('#drive-list li').length > 0);

    expect(root.querySelectorAll('#drive-list li').length).toBeGreaterThan(0);
  });

  it('will not restore from Drive without a secret', async () => {
    await go('backup');
    field('#list-drive').click();
    await waitFor(() => root.querySelectorAll('#drive-list li').length > 0);

    root.querySelector<HTMLButtonElement>('#drive-list button')?.click();
    await waitFor(() => text('#notice').includes('password'));

    expect(text('#notice')).toContain('password');
  });

  it('asks for a file rather than failing silently', async () => {
    await go('backup');

    field('#open').click();
    await waitFor(() => text('#notice').includes('Choose a backup file'));

    expect(text('#notice')).toContain('Choose a backup file');
  });
});
