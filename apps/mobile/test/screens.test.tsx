import { describe, expect, test } from '@jest/globals';
import { fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { addSpend, capture, launch, launchSetUp } from './app';
import { CACHE, listFiles, pickFile, readFile } from './device';

async function importOneUnconfirmed(): Promise<void> {
  await capture('Upload a file');
  pickFile('statement.csv', 'text/csv', 'Date,Description,Amount\n03/15/2026,SHELL OIL 5741,-40.00\n');
  fireEvent.press(await screen.findByRole('button', { name: 'Choose a file' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Preview the import' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Import 1 rows' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Back to transactions' }));
  await screen.findByText('SHELL OIL 5741');
}

describe('confirming', () => {
  test('an imported row counts once confirmed, and not before', async () => {
    await launchSetUp();
    await importOneUnconfirmed();
    expect(screen.getByText('Not counted until you confirm')).toBeTruthy();

    fireEvent.press(screen.getByText('SHELL OIL 5741'));
    expect(await screen.findByText('Not counted yet')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.queryByText('Not counted yet')).toBeNull();
    });
  });

  test('"To confirm" shows only what still needs a look', async () => {
    await launchSetUp();
    await addSpend('450', 'Blue Bottle');
    await importOneUnconfirmed();

    fireEvent.press(screen.getByRole('button', { name: 'To confirm' }));
    await waitFor(() => {
      expect(screen.queryByText('Blue Bottle')).toBeNull();
    });
    expect(screen.getByText('SHELL OIL 5741')).toBeTruthy();
  });
});

describe('summary', () => {
  test('totals confirmed spending only', async () => {
    await launchSetUp();
    await addSpend('1250', 'Blue Bottle');
    await addSpend('750', 'Tartine');
    await importOneUnconfirmed();
    screen.unmount();

    // Nothing links here today; the route is reached by its URL.
    launch('/summary');
    expect(await screen.findByText('Confirmed spending')).toBeTruthy();
    expect(await screen.findAllByText(/20\.00/)).not.toHaveLength(0);
    expect(screen.queryByText(/60\.00/)).toBeNull();

    fireEvent.press(screen.getByText('By month'));
    expect(await screen.findAllByText(/20\.00/)).not.toHaveLength(0);
  });
});

describe('profile', () => {
  test('changes are saved and shown, and survive a restart', async () => {
    await launchSetUp();
    fireEvent.press(await screen.findByLabelText('Profile and settings'));

    expect(await screen.findByText('No email set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.changeText(screen.getByPlaceholderText('Name'), 'Sam Lee');
    fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'sam@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.getByText('SL')).toBeTruthy();

    screen.unmount();
    launch('/profile');
    expect(await screen.findByText('sam@example.com')).toBeTruthy();
  });
});

describe('export', () => {
  test('a CSV export holds the ledger, warns it is not encrypted, and can be deleted', async () => {
    await launchSetUp();
    await addSpend('1250', 'Blue Bottle');
    fireEvent.press(await screen.findByLabelText('Profile and settings'));
    fireEvent.press(await screen.findByText('Export'));

    expect(await screen.findByText('Exports are not protected')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/^CSV: 1 entries, .* Not encrypted\.$/)).toBeTruthy();

    const [file] = listFiles(`${CACHE}exports/`);
    expect(file).toMatch(/\.csv$/);
    expect(readFile(file ?? '')?.toString('utf8')).toContain('Blue Bottle');

    fireEvent.press(screen.getByRole('button', { name: 'Delete the files from this device' }));
    expect(await screen.findByText('Deleted 1 exported file(s).')).toBeTruthy();
    expect(listFiles(`${CACHE}exports/`)).toHaveLength(0);
  });
});
