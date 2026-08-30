/**
 * A v1 archive, frozen at the bytes.
 *
 * This file exists so every future build is forced to prove it can still open
 * archives written by every earlier one. A user's backups are the only copy of
 * their data, and a format change that quietly stops reading them is the worst
 * bug this project can ship.
 *
 * **Never delete or regenerate this.** When the format changes, add a new frozen
 * fixture beside it and keep this one passing.
 *
 * Written with the password and salt below and the real KDF_PARAMS, so a change
 * to those parameters fails this test too — which is the point.
 */
export const V1_ARCHIVE_BASE64 =
  'QlRCSwEAAAJ8eyJrZGYiOnsiYWxnb3JpdGhtIjoiYXJnb24yaWQiLCJvcHNMaW1pdCI6MywibWVtTGltaXRCeXRlcyI6NjcxMDg4NjQsInNhbHQiOiJLaW9xS2lvcUtpb3FLaW9xS2lvcUtnPT0ifSwiYm1rV3JhcHMiOnsiYnlQYXNzd29yZCI6eyJub25jZSI6IjR2aGdLMkZkWW9BOGFCWi9rVHNRWGt6Y21mQi9tU054IiwiY2lwaGVydGV4dCI6IjhCK3BWZU1qNzliemZTMXowK1k3YXRjaGxFOWY3czViYk1BdXpORGhRY1pBREw3YUhoa3pHbXV1UTVWQnk5c1EifSwiYnlSZWNvdmVyeUtleSI6eyJub25jZSI6Ikd1dGJjVU5pMEt3TXNPQko5SzVWcWpkWm1MdnF1M01UIiwiY2lwaGVydGV4dCI6IkF2bFVteVpGcEFsenFHZmtwMENEQXdjZVcxUnVXRnVKMWVkZXE3bE00RGo0cENkNStrTGRrMXRjazlYYjkxeGsifX0sImFrV3JhcCI6eyJub25jZSI6ImxtcEtBeVdQNVZ2dVhranBXTHR2aHE1SEJmZzF0U2FYIiwiY2lwaGVydGV4dCI6IkFSR2poM0xBZmJTR3F1T2I4MFJRdkIxMVVWaWpDci9lK1QzenppVUpYZmxhOGMyMDREVER5dHoyVkZjQlc2a0EifSwibm9uY2VQcmVmaXgiOiJkMUFIRGhkbzBJRGlHSjFoYVY1U1NRPT0iLCJjcmVhdGVkQXQiOjE3NzIwMDAwMDAwMDAsImFwcFZlcnNpb24iOiIwLjEuMCIsInNjaGVtYVZlcnNpb24iOjJ9AAAAosjAsqDdzLiWM2JTwhy9ws0/ATeiG1HoULSub/1XrkmY8XeecENzMKIIwdqVy6oTvW/XYu5uOcugZiGARR7156576/ZVDE/rNIzpAvq7/qnIwxDKUsZmMlAoKR+DcN5j/p9HMeuIxy3+3aLS9HrxMItNloqpVxIRpdyrJkeHZWyzSvrytRJ8vKiiPtl+lht2OdSyA8SjP5lPkac9C+ilF23zBgAAAC0a3b5OV+WipGssXrfSdv+LIbjFQXfqYTob2OYzNYsXse0s2GDShjT1MN0BNYMAAAAUx2cYRrK/X0SNYwJ59+B+iPpw2MQ=';

export const V1_PASSWORD = 'frozen-fixture-password';
export const V1_SALT = new Uint8Array(16).fill(0x2a);
export const V1_RECOVERY_KEY = new Uint8Array(32).fill(0x07);
export const V1_EXPECTED_DOCUMENT = Uint8Array.from([9, 8, 7, 6]);
export const V1_CREATED_AT = 1_772_000_000_000;
export const V1_SCHEMA_VERSION = 2;
