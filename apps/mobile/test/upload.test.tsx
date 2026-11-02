import { describe, expect, test } from '@jest/globals';
import { fireEvent, screen } from 'expo-router/testing-library';
import { capture, launchSetUp } from './app';
import { ocrWillRead, pickFile } from './device';

const STATEMENT = [
  'Date,Description,Amount',
  '03/14/2026,SQ *BLUE BOTTLE COFFEE,-10.60',
  '03/15/2026,SHELL OIL 5741,-40.00',
  '03/16/2026,RENT MARCH,-1200.00',
].join('\n');

/** Positions as ML Kit reports them for the bundled test receipt (700x900). */
const RECEIPT: readonly (readonly [string, number, number, number])[] = [
  ['BLUE BOTTLE COFFEE', 42, 40, 364],
  ['66 Mint St', 42, 110, 154],
  ['San Francisco, CA', 42, 150, 266],
  ['03/14/2026', 42, 190, 175],
  ['09:12 AM', 252, 190, 126],
  ['1 Oat Latte', 42, 270, 168],
  ['1 Croissant', 42, 310, 168],
  ['SUBTOTAL', 42, 390, 140],
  ['TAX', 42, 430, 56],
  ['TOTAL', 42, 470, 91],
  ['VISA ****4242', 42, 550, 196],
  ['Thank you!', 42, 590, 154],
  ['5.50', 357, 270, 63],
  ['4.25', 357, 310, 63],
  ['9.75', 357, 390, 63],
  ['0.85', 357, 430, 63],
  ['10.60', 343, 470, 77],
];

async function importStatement(): Promise<void> {
  pickFile('statement.csv', 'text/csv', STATEMENT);
  fireEvent.press(await screen.findByRole('button', { name: /Choose (a|another) file/ }));
  fireEvent.press(await screen.findByRole('button', { name: 'Preview the import' }));
}

describe('upload a file', () => {
  test('a statement CSV previews, imports as unconfirmed records, and re-importing finds duplicates', async () => {
    await launchSetUp();
    await capture('Upload a file');

    await importStatement();
    expect(await screen.findByText('3 to import, 0 already in your ledger')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Import 3 rows' }));
    expect(await screen.findByText(/3 rows imported, waiting to be confirmed/)).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Back to transactions' }));
    expect(await screen.findByText('RENT MARCH')).toBeTruthy();
    expect(screen.getAllByText('Not counted until you confirm')).toHaveLength(3);

    // The same file again: nothing new, everything recognised.
    await capture('Upload a file');
    await importStatement();
    expect(await screen.findByText('0 to import, 3 already in your ledger')).toBeTruthy();
  });

  // Known bug, found by this suite: the home list shows each row's note, and
  // an imported row's note is the bank's raw description. The web ledger shows
  // the merchant. `test.failing` passes while the bug is there and turns red
  // when it is fixed — then make it a plain `test`.
  test.failing('an imported row is listed by its merchant, not the bank description', async () => {
    await launchSetUp();
    await capture('Upload a file');
    await importStatement();
    fireEvent.press(await screen.findByRole('button', { name: 'Import 3 rows' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Back to transactions' }));

    expect(await screen.findByText('Blue Bottle Coffee')).toBeTruthy();
    expect(screen.queryByText('SQ *BLUE BOTTLE COFFEE')).toBeNull();
  });

  test('a file that is neither a statement nor a receipt is refused by name', async () => {
    await launchSetUp();
    await capture('Upload a file');

    pickFile('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x');
    fireEvent.press(await screen.findByRole('button', { name: 'Choose a file' }));

    expect(await screen.findByText(/notes\.docx is not a file this can read/)).toBeTruthy();
  });

  test('a CSV with a header and no rows says so', async () => {
    await launchSetUp();
    await capture('Upload a file');

    pickFile('empty.csv', 'text/csv', 'Date,Description,Amount\n');
    fireEvent.press(await screen.findByRole('button', { name: 'Choose a file' }));

    expect(await screen.findByText('That file has a header and no rows.')).toBeTruthy();
  });

  test('a receipt image is read, checked and saved as a confirmed record with its items', async () => {
    const app = await launchSetUp();
    await capture('Upload a file');

    ocrWillRead(RECEIPT);
    pickFile('receipt.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fireEvent.press(await screen.findByRole('button', { name: 'Choose a file' }));

    // The rules read the total and the merchant; the user only checks them.
    expect(await screen.findByDisplayValue('BLUE BOTTLE COFFEE')).toBeTruthy();
    expect(app.getPathname()).toMatch(/^\/confirm\//);
    expect(screen.getAllByText(/10\.60/).length).toBeGreaterThan(0);

    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('BLUE BOTTLE COFFEE')).toBeTruthy();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryByText('Not counted until you confirm')).toBeNull();

    fireEvent.press(screen.getByText('BLUE BOTTLE COFFEE'));
    expect(await screen.findByText('photo')).toBeTruthy();
    expect(screen.getByText(/Oat Latte/)).toBeTruthy();
    expect(screen.getByText(/Croissant/)).toBeTruthy();
  });
});
