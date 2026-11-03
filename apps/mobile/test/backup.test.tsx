import { describe, expect, test } from '@jest/globals';
import { fireEvent, screen } from 'expo-router/testing-library';
import { addSpend, launch, launchSetUp } from './app';
import { DOCUMENTS, listFiles, pickFile, readFile, resetDevice } from './device';

const PASSWORD = 'correct horse battery';

/**
 * Long enough for a step that derives a key from the password (Argon2 in the
 * WASM build) or encrypts the ledger. Locally that is well under a second; on
 * a shared CI runner it has taken longer than Testing Library's default 1 s.
 */
const CRYPTO_WAIT = { timeout: 20_000 };

/**
 * Through the whole ceremony: password, recovery key shown once, last group
 * typed back, first backup written. Returns the key as printed on screen.
 */
async function setUpBackup(): Promise<string> {
  fireEvent.press(await screen.findByRole('button', { name: 'Set up backup' }));
  fireEvent.changeText(screen.getByPlaceholderText('Backup password'), PASSWORD);
  fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

  await screen.findByText('Save your recovery key', {}, CRYPTO_WAIT);
  const printed = screen.getByText(/^[A-Z0-9]+(-[A-Z0-9]+){3,}$/).props.children as string;

  fireEvent.press(screen.getByRole('button', { name: 'I have saved it' }));
  fireEvent.changeText(screen.getByPlaceholderText('Last group'), printed.split('-').at(-1) ?? '');
  fireEvent.press(screen.getByRole('button', { name: 'Confirm and back up' }));

  await screen.findByText(/^Backed up /, {}, CRYPTO_WAIT);
  return printed;
}

/** Ledger → profile → backup, the way a user gets there. */
async function openBackup(): Promise<void> {
  fireEvent.press(await screen.findByLabelText('Profile and settings'));
  fireEvent.press(await screen.findByText('Backup and restore'));
}

/** Close the app and open it again on the same device: the ledger it finds is what is stored. */
async function reopenApp(): Promise<void> {
  screen.unmount();
  launch();
  await screen.findByLabelText('Profile and settings');
}

function archivesOnDevice(): string[] {
  return listFiles(DOCUMENTS).filter((path) => path.endsWith('.btbk'));
}

describe('backup and restore', () => {
  test('a password shorter than 8 characters is refused', async () => {
    await launchSetUp('/backup');
    fireEvent.press(await screen.findByRole('button', { name: 'Set up backup' }));
    fireEvent.changeText(screen.getByPlaceholderText('Backup password'), 'short');
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/at least 8 characters/)).toBeTruthy();
    expect(screen.queryByText('Save your recovery key')).toBeNull();
  });

  test('a recovery key nobody wrote down cannot slip through', async () => {
    await launchSetUp('/backup');
    fireEvent.press(await screen.findByRole('button', { name: 'Set up backup' }));
    fireEvent.changeText(screen.getByPlaceholderText('Backup password'), PASSWORD);
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Save your recovery key', {}, CRYPTO_WAIT);

    fireEvent.press(screen.getByRole('button', { name: 'I have saved it' }));
    fireEvent.changeText(screen.getByPlaceholderText('Last group'), 'WRONG');
    fireEvent.press(screen.getByRole('button', { name: 'Confirm and back up' }));

    expect(await screen.findByText(/does not match the last group/)).toBeTruthy();
    expect(archivesOnDevice()).toHaveLength(0);
  });

  test('a backup restores onto a wiped phone with the recovery key, and the ledger comes back', async () => {
    await launchSetUp();
    await addSpend('1250', 'Blue Bottle');
    await addSpend('4000', 'Shell');

    await openBackup();
    const recoveryKey = await setUpBackup();

    const [archive] = archivesOnDevice();
    expect(archive).toBeDefined();
    const bytes = readFile(archive ?? '');
    screen.unmount();

    // A new phone: no database, no keystore, no files. Only the archive,
    // carried over by the user.
    resetDevice();
    await launchSetUp('/backup');

    fireEvent.press(await screen.findByRole('button', { name: 'I already have a backup' }));
    fireEvent.changeText(screen.getByPlaceholderText('Backup password or recovery key'), recoveryKey);
    pickFile('txns-backup.btbk', 'application/octet-stream', bytes ?? Buffer.alloc(0));
    fireEvent.press(screen.getByRole('button', { name: 'Choose a backup file' }));

    expect(await screen.findByText(/^Restored a backup from .* rows added/, {}, CRYPTO_WAIT)).toBeTruthy();

    await reopenApp();
    expect(await screen.findByText('Blue Bottle')).toBeTruthy();
    expect(screen.getByText('Shell')).toBeTruthy();
  });

  test('the backup password opens the archive too', async () => {
    await launchSetUp();
    await addSpend('899', 'Safeway');
    await openBackup();
    await setUpBackup();
    const bytes = readFile(archivesOnDevice()[0] ?? '');
    screen.unmount();

    resetDevice();
    await launchSetUp('/backup');
    fireEvent.press(await screen.findByRole('button', { name: 'I already have a backup' }));
    fireEvent.changeText(screen.getByPlaceholderText('Backup password or recovery key'), PASSWORD);
    pickFile('txns-backup.btbk', 'application/octet-stream', bytes ?? Buffer.alloc(0));
    fireEvent.press(screen.getByRole('button', { name: 'Choose a backup file' }));
    await screen.findByText(/^Restored a backup/, {}, CRYPTO_WAIT);

    await reopenApp();
    expect(await screen.findByText('Safeway')).toBeTruthy();
  });

  test('a wrong secret says so, and blames the secret rather than the file', async () => {
    await launchSetUp();
    await addSpend('899', 'Safeway');
    await openBackup();
    await setUpBackup();
    const bytes = readFile(archivesOnDevice()[0] ?? '');
    screen.unmount();

    resetDevice();
    await launchSetUp('/backup');
    fireEvent.press(await screen.findByRole('button', { name: 'I already have a backup' }));
    fireEvent.changeText(screen.getByPlaceholderText('Backup password or recovery key'), 'not the password');
    pickFile('txns-backup.btbk', 'application/octet-stream', bytes ?? Buffer.alloc(0));
    fireEvent.press(screen.getByRole('button', { name: 'Choose a backup file' }));

    expect(
      await screen.findByText(/not open this backup/, {}, CRYPTO_WAIT),
    ).toBeTruthy();
  });
});
