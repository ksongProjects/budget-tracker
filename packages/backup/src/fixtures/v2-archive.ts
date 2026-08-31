/**
 * A v2 archive, frozen at the bytes.
 *
 * Format 2 binds the header into every frame's associated data, so a header
 * edited in place no longer authenticates. That is a change to how archives are
 * sealed, which means a new frozen fixture: this file is the proof that a build
 * years from now can still open what this one wrote.
 *
 * **Never regenerate this.** When the format changes again, add a v3 fixture
 * beside it and leave this one passing. The v1 fixture next door stays too —
 * archives written before header authentication must keep opening.
 *
 * Written with the password and salt below and the real KDF_PARAMS, so a change
 * to those parameters fails this test as well, which is the point.
 */
export const V2_ARCHIVE_BASE64 =
  'QlRCSwIAAAJ8eyJrZGYiOnsiYWxnb3JpdGhtIjoiYXJnb24yaWQiLCJvcHNMaW1pdCI6MywibWVtTGltaXRCeXRlcyI6NjcxMDg4NjQsInNhbHQiOiJLaW9xS2lvcUtpb3FLaW9xS2lvcUtnPT0ifSwiYm1rV3JhcHMiOnsiYnlQYXNzd29yZCI6eyJub25jZSI6ImhFQnNad0VFSDVzRmdPa0lsNE9PUm1PS3E5NkxLaVlBIiwiY2lwaGVydGV4dCI6IjhvdWNiL1M1OGQ4bDdlRkRUUWVJS3JQaXNRVlU5TjBiV3NzRHo3eWhta3F3TnN4d1VSRUJidGV6THdSUGZWQzAifSwiYnlSZWNvdmVyeUtleSI6eyJub25jZSI6ImhpbXhHZmdkdnpwWWFWRG5UT05Ud1BRbU52YkNyN01YIiwiY2lwaGVydGV4dCI6IkNZUzJKRjlvR05XM1ZDR2hqTGk2SHJEeHRra3RxeFlONmlMaENxZHFjWWNodG9hTWFadmhBbENhNUNJbmUrQXQifX0sImFrV3JhcCI6eyJub25jZSI6IkdYMlpoZytWajR3Z3U2UkhMekhTdHJXeVM4RTRUQ3RIIiwiY2lwaGVydGV4dCI6InpVRENQYlREWHFWU216QUF3S2w0MzVHSmlMamphajBHTk1rZm5JU2NkeHRseW9VdkphcmJ4elhMbUVVYTJBd0sifSwibm9uY2VQcmVmaXgiOiJRU0I1SnJjZklSaHg3SGlhSXhIZnR3PT0iLCJjcmVhdGVkQXQiOjE3NzIwMDAwMDAwMDAsImFwcFZlcnNpb24iOiIwLjEuMCIsInNjaGVtYVZlcnNpb24iOjJ9AAAAi9u0vtTvmcLSV+zLd1YN3lkQOAwM0mV9VoINgebvr4IsqpxzANCiosPGqZ6L6k99dOLS9jCyX/WId9emsFNWlVmHaVtImoGZEkLSQsIpgyMgvzwaf1UGbfxEBwqXnFwh+9swrUGonnnazYP16EP1opdSJZDFn7iHRGS0+w5rySRBcQV2rWZ+RaCnoAAAAAAm2GbYKNt7OKy+EzJt+fPMTBhpgJisSn308AOkqaaj+FpgRYc3x5cAAAAUb729tsHgMNtwzZAbq4j9TEMWqTY=';

export const V2_PASSWORD = 'frozen-fixture-password';
export const V2_SALT = new Uint8Array(16).fill(0x2a);
export const V2_RECOVERY_KEY = new Uint8Array(32).fill(0x07);
export const V2_EXPECTED_LEDGER = 'frozen ledger snapshot';
export const V2_EXPECTED_DOCUMENT = Uint8Array.from([9, 8, 7, 6]);
export const V2_CREATED_AT = 1_772_000_000_000;
export const V2_SCHEMA_VERSION = 2;
