import { describe, expect, jest, test } from '@jest/globals';
import { Alert } from 'react-native';
import { fireEvent, screen, waitFor, within } from 'expo-router/testing-library';
import { capture, launchSetUp, typeAmount } from './app';

describe('the ledger', () => {
  test('starts empty', async () => {
    await launchSetUp();
    expect(await screen.findByText('Nothing recorded yet')).toBeTruthy();
  });

  test('a typed spend lands in the list with its merchant and amount', async () => {
    const app = await launchSetUp();

    await capture('Type it');
    expect(app.getPathname()).toBe('/add');

    // Nothing to save until there is a number.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    typeAmount('1250');
    fireEvent.changeText(screen.getByLabelText('Merchant'), 'Blue Bottle');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Blue Bottle')).toBeTruthy();
    expect(app.getPathname()).toBe('/');
    expect(screen.getAllByText(/12\.50/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing recorded yet')).toBeNull();
  });

  test('a date that is not one is refused, and nothing is saved', async () => {
    const app = await launchSetUp();
    await capture('Type it');

    typeAmount('500');
    fireEvent.changeText(screen.getByLabelText('When'), '2026-13-45');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a date/);
    expect(app.getPathname()).toBe('/add');
  });

  test('a spend opens to its detail, and deleting it takes it off the list', async () => {
    await launchSetUp();
    await capture('Type it');
    typeAmount('899');
    fireEvent.changeText(screen.getByLabelText('Merchant'), 'Safeway');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    fireEvent.press(await screen.findByText('Safeway'));
    expect(await screen.findByText('manual')).toBeTruthy();

    // Delete asks first; answer the alert the way a user would.
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    expect(alert).toHaveBeenCalledWith('Delete this spend?', expect.any(String), expect.any(Array));

    expect(await screen.findByText('Nothing recorded yet')).toBeTruthy();
    alert.mockRestore();
  });

  test('search narrows the list and says when nothing matches', async () => {
    await launchSetUp();
    for (const [amount, merchant] of [
      ['450', 'Blue Bottle'],
      ['4000', 'Shell'],
    ] as const) {
      await capture('Type it');
      typeAmount(amount);
      fireEvent.changeText(screen.getByLabelText('Merchant'), merchant);
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText(merchant);
    }

    fireEvent.changeText(screen.getByLabelText('Search transactions'), 'shell');
    await waitFor(() => {
      expect(screen.queryByText('Blue Bottle')).toBeNull();
    });
    expect(screen.getByText('Shell')).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText('Search transactions'), 'nowhere');
    expect(await screen.findByText('Nothing matches those filters.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: /Clear them/ }));
    expect(await screen.findByText('Blue Bottle')).toBeTruthy();
    expect(within(screen.getByLabelText('Search transactions')).queryByText('nowhere')).toBeNull();
  });
});
