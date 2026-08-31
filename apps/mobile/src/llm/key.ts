import * as SecureStore from 'expo-secure-store';

/**
 * The user's own Cloud Assist key.
 *
 * Their key, their account, their bill — this app ships with no key and no
 * service of its own (docs/extraction.md). It lives in the OS keystore beside
 * the backup key material, because it is a credential: anyone holding it can
 * spend the user's money with the provider.
 *
 * Held nowhere else. Not in app state longer than a call needs it, not in a
 * log, and never in the ledger or a backup archive — a key that travelled in a
 * backup would outlive the phone it was typed into.
 */

const KEY = 'cloud-assist-api-key';

export async function readApiKey(): Promise<string | undefined> {
  const stored = await SecureStore.getItemAsync(KEY);
  return stored === null || stored === '' ? undefined : stored;
}

export async function saveApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed === '') {
    await forgetApiKey();
    return;
  }
  await SecureStore.setItemAsync(KEY, trimmed);
}

/** Turn Cloud Assist off by taking away the thing that makes it possible. */
export async function forgetApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

export async function hasApiKey(): Promise<boolean> {
  return (await readApiKey()) !== undefined;
}

/**
 * A key, shown the way a key should be shown: enough to recognise, not enough
 * to use if someone photographs the screen.
 */
export function maskApiKey(apiKey: string): string {
  return apiKey.length <= 8
    ? '••••'
    : `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}
