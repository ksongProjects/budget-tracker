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
  // Both halves name a screen: a notice on its own is not a finished render.
  await waitFor(
    () =>
      root.querySelector('#ledger') !== null ||
      (root.querySelector('#add') !== null && text('#notice') !== ''),
  );
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
    await waitFor(() => root.textContent.includes('Nothing captured yet'));

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

/**
 * What a screen reader and a keyboard get.
 *
 * These are cheap to write and cheap to break: a form field whose only name is
 * a placeholder reads as "edit text, blank" to someone who cannot see the
 * placeholder, and a status message that is not a live region is never spoken
 * at all. Both were true here until Phase 10.
 */
describe('accessibility', () => {
  it('gives every input a name that survives typing', async () => {
    await go('add');

    for (const field of root.querySelectorAll('input')) {
      const name = field.getAttribute('aria-label') ?? field.labels?.[0]?.textContent ?? '';
      expect(name.trim()).not.toBe('');
    }
  });

  it('announces what just happened', () => {
    const notice = root.querySelector('#notice');

    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
  });

  it('names the navigation and marks where you are', async () => {
    await go('summary');

    const bar = root.querySelector('nav');
    expect(bar?.getAttribute('aria-label')).not.toBe(null);
    expect(bar?.querySelector('[aria-current="page"]')?.textContent).toBe('Summary');
  });

  it('uses real buttons, which keyboards already know how to work', async () => {
    await go('add');

    // Not a div with a click handler: a button is focusable, reachable by tab,
    // and activated by both Enter and Space without a line of code.
    const submit = root.querySelector('#submit');
    expect(submit?.tagName).toBe('BUTTON');
  });

  it('keeps headings in order, so a screen reader can skim the ledger', async () => {
    await go('add');
    const amount = root.querySelector<HTMLInputElement>('#amount');
    const note = root.querySelector<HTMLInputElement>('#note');
    if (amount && note) {
      amount.value = '4.50';
      note.value = 'coffee';
      root.querySelector<HTMLButtonElement>('#submit')?.click();
    }

    await go('ledger');
    await waitFor(() => root.querySelectorAll('h2').length > 0);

    // Day headings are h2 under the page's own h1; nothing skips a level.
    expect(root.querySelectorAll('h3').length).toBe(0);
  });
});
