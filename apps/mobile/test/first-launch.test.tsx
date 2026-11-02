import { describe, expect, test } from '@jest/globals';
import { fireEvent, screen } from 'expo-router/testing-library';
import { launch } from './app';

describe('first launch', () => {
  test('asks whose ledger it is before showing one', async () => {
    launch();

    expect(await screen.findByText('Start tracking')).toBeTruthy();
    expect(screen.queryByText('TXNS', { exact: true })).toBeTruthy();

    // Nothing to start with until there is a name.
    expect(screen.getByRole('button', { name: 'Start tracking' })).toBeDisabled();

    fireEvent.changeText(screen.getByPlaceholderText('Name'), 'Sam');
    fireEvent.press(screen.getByRole('button', { name: 'Start tracking' }));

    expect(await screen.findByLabelText('Profile and settings')).toBeTruthy();
  });

  test('rejects an email that cannot be one', async () => {
    launch();

    fireEvent.changeText(await screen.findByPlaceholderText('Name'), 'Sam');
    fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'not-an-email');

    expect(screen.getByRole('button', { name: 'Start tracking' })).toBeDisabled();
  });
});
