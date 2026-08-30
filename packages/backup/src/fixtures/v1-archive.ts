/**
 * A v1 archive, frozen at the bytes.
 *
 * This file exists so every future build is forced to prove it can still open
 * archives written by every earlier one. A user's backups are the only copy of
 * their data, and a format change that quietly stops reading them is the worst
 * bug this project can ship.
 *
 * **Never regenerate this once the format has shipped.** When it changes, add a
 * new frozen fixture beside this one and keep this one passing.
 *
 * Regenerated once, on 2026-08-30, before any release. Running the crypto
 * vectors on a device showed that react-native-libsodium accepts only a string
 * as AEAD associated data, so the original byte-packed associated data could
 * never have been produced on a phone at all — no archive in that shape has
 * ever existed outside this repository. That is the only reason regenerating
 * was correct, and the reason it must not happen again.
 *
 * Written with the password and salt below and the real KDF_PARAMS, so a change
 * to those parameters fails this test too — which is the point.
 */
export const V1_ARCHIVE_BASE64 =
  'QlRCSwEAAAJ8eyJrZGYiOnsiYWxnb3JpdGhtIjoiYXJnb24yaWQiLCJvcHNMaW1pdCI6MywibWVtTGltaXRCeXRlcyI6NjcxMDg4NjQsInNhbHQiOiJLaW9xS2lvcUtpb3FLaW9xS2lvcUtnPT0ifSwiYm1rV3JhcHMiOnsiYnlQYXNzd29yZCI6eyJub25jZSI6Ik5RWUYzNXIrbDlaWGphLytFRHNFUkc2azlqRXVwT2pFIiwiY2lwaGVydGV4dCI6IlMzM2RVS1R3NzJPdzRBM3ZUZk42aWJPU0pSMmgweUM0Q2k0aGp2dzlsRG5IYjlkbUdsZmtJcmtGcTd2NnkvQXMifSwiYnlSZWNvdmVyeUtleSI6eyJub25jZSI6Ildha3d3cWFCaHZLTjJmek45VVBuU3Y3VnlZb2JrVWF4IiwiY2lwaGVydGV4dCI6IkdXQnNUUVRvMnYwd3BjRlBpRXpBR0FVQk9OcE1ndVYwQnpXeFRvV1FqZVM2c2NHRkpIZkUzUnF6MGVid1l5OXYifX0sImFrV3JhcCI6eyJub25jZSI6IlQrWkt2b3BQUC92dDRuZzJ1d2RtTDIyeTNFWG51Z2k4IiwiY2lwaGVydGV4dCI6IkZ1T2ZMTmlJSENsd3pYKzA0Z2dFb2R0TnhpUU9WMmxOK3c0SUhpVE5HSzVnbzFnSjZUMlJEU1hSZmZJc20yc2sifSwibm9uY2VQcmVmaXgiOiJyYWZQak1wTU5iNEswN0NVUUdNWVdRPT0iLCJjcmVhdGVkQXQiOjE3NzIwMDAwMDAwMDAsImFwcFZlcnNpb24iOiIwLjEuMCIsInNjaGVtYVZlcnNpb24iOjJ9AAAAoizHbZY96SqbOxPwCSGRHT7dkX0vzMY4zlMdj+RQJZoDI/Kh/bfn1PG/+JaO0OhLzzJMLhfPGOv3ACcKbb5IC5Q2c3hV1WfAJX7XaGOhiv3CDHJOWReZscu/tIeyqU8S42E1/BhHK1KuHLYHvMGLZ+WsWXAP2vXSd2ZAOWeL7VhBCGdEGA46vsTxbxU5q15S6f5x+JOf+QVvS+0D6ITQgUIA0wAAAC2qmB4fftfz31lCK+CS7Oo+QB47/7k1TH3UOPUADKnmDyVjMrnmldFSPi/M8mIAAAAULRBH8KzPeGK2qZIYCkcLEutnvuk=';

export const V1_PASSWORD = 'frozen-fixture-password';
export const V1_SALT = new Uint8Array(16).fill(0x2a);
export const V1_RECOVERY_KEY = new Uint8Array(32).fill(0x07);
export const V1_EXPECTED_DOCUMENT = Uint8Array.from([9, 8, 7, 6]);
export const V1_CREATED_AT = 1_772_000_000_000;
export const V1_SCHEMA_VERSION = 2;
