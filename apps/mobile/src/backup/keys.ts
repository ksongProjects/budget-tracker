import * as SecureStore from 'expo-secure-store';
import type { SodiumBackend } from '@budget/crypto';
import { generateBmk, generateSalt } from '@budget/crypto';
import type { WrappedKey } from '@budget/crypto';
import { fromBase64, toBase64 } from '@budget/backup';

/**
 * Where the backup keys live between sessions.
 *
 * The Backup Master Key and the KDF salt go in the OS keystore — Keychain on
 * iOS, the Android Keystore-backed store here — because they must be the same
 * for every backup this device writes. If the BMK changed per backup, each
 * archive would need its own password and the recovery key would open only one
 * of them.
 *
 * The **recovery key is never stored**. It is shown once and the user keeps it.
 * Storing it beside the data it protects would make it decoration.
 *
 * The password is never stored either. It exists only as a KEK in memory for as
 * long as a backup or restore is running.
 */

const BMK_KEY = 'budget.bmk';
const SALT_KEY = 'budget.kdfSalt';
const RECOVERY_WRAP_KEY = 'budget.recoveryWrap';

export interface BackupKeyMaterial {
  readonly bmk: Uint8Array;
  readonly salt: Uint8Array;
  /** True when this call created them, meaning backup has not been set up before. */
  readonly created: boolean;
}

export async function loadOrCreateKeyMaterial(
  sodium: SodiumBackend,
): Promise<BackupKeyMaterial> {
  const [storedBmk, storedSalt] = await Promise.all([
    SecureStore.getItemAsync(BMK_KEY),
    SecureStore.getItemAsync(SALT_KEY),
  ]);

  if (storedBmk !== null && storedSalt !== null) {
    return { bmk: fromBase64(storedBmk), salt: fromBase64(storedSalt), created: false };
  }

  const bmk = generateBmk(sodium);
  const salt = generateSalt(sodium);

  await Promise.all([
    SecureStore.setItemAsync(BMK_KEY, toBase64(bmk)),
    SecureStore.setItemAsync(SALT_KEY, toBase64(salt)),
  ]);

  return { bmk, salt, created: true };
}

/** Whether backup has been set up on this device. */
export async function hasKeyMaterial(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BMK_KEY)) !== null;
}

/**
 * Adopt the key material from a restored archive, so backups written after a
 * restore stay openable with the same secrets as the ones before it.
 */
export async function adoptKeyMaterial(bmk: Uint8Array, salt: Uint8Array): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(BMK_KEY, toBase64(bmk)),
    SecureStore.setItemAsync(SALT_KEY, toBase64(salt)),
  ]);
}

/**
 * The BMK wrapped under the recovery key, kept so later backups can carry a
 * recovery path without the recovery key itself ever being stored.
 *
 * This is ciphertext: useless to anyone who does not hold the key the user
 * wrote down. Storing the key instead would make the whole ceremony pointless.
 */
export async function storeRecoveryWrap(wrap: WrappedKey): Promise<void> {
  await SecureStore.setItemAsync(
    RECOVERY_WRAP_KEY,
    JSON.stringify({ nonce: toBase64(wrap.nonce), ciphertext: toBase64(wrap.ciphertext) }),
  );
}

export async function loadRecoveryWrap(): Promise<WrappedKey | null> {
  const stored = await SecureStore.getItemAsync(RECOVERY_WRAP_KEY);
  if (stored === null) return null;

  const parsed = JSON.parse(stored) as { nonce: string; ciphertext: string };
  return { nonce: fromBase64(parsed.nonce), ciphertext: fromBase64(parsed.ciphertext) };
}
