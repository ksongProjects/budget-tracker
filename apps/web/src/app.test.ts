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
  await settle();
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

async function addSpend(amount: string, note: string): Promise<void> {
  await go('add');

  field('#amount').value = amount;
  field('#note').value = note;
  field('#submit').click();

  await settle();
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
  it('asks for a file rather than failing silently', async () => {
    await go('backup');

    field('#open').click();
    await settle();

    expect(text('#notice')).toContain('Choose a backup file');
  });
});
