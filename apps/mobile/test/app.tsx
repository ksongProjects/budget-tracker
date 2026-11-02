import { join } from 'node:path';
import { expect } from '@jest/globals';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/**
 * The whole app, as expo-router would mount it: the real route files under
 * app/, the real root layout and its ledger and profile gates.
 */
export function launch(initialUrl = '/'): ReturnType<typeof renderRouter> {
  return renderRouter(join(__dirname, '..', 'app'), { initialUrl });
}

/** Type an amount on the keypad, one key at a time, as a thumb would. */
export function typeAmount(digits: string): void {
  for (const key of digits) fireEvent.press(screen.getByRole('button', { name: key }));
}

/** Open the capture menu and pick one of its options. */
export async function capture(option: 'Type it' | 'Photograph a receipt' | 'Say it' | 'Upload a file'): Promise<void> {
  fireEvent.press(await screen.findByRole('button', { name: 'Record a spend' }));
  fireEvent.press(await screen.findByText(option));
}

/** Type a spend from the ledger and wait for it to be listed. */
export async function addSpend(digits: string, merchant: string): Promise<void> {
  await capture('Type it');
  typeAmount(digits);
  fireEvent.changeText(screen.getByLabelText('Merchant'), merchant);
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(merchant);
}

/** First launch, through the setup screen, to the ledger. */
export async function launchSetUp(initialUrl = '/'): Promise<ReturnType<typeof renderRouter>> {
  const app = launch(initialUrl);
  fireEvent.changeText(await screen.findByPlaceholderText('Name'), 'Sam');
  fireEvent.press(screen.getByRole('button', { name: 'Start tracking' }));
  await waitFor(() => {
    expect(screen.queryByText('Start tracking')).toBeNull();
  });
  return app;
}
