# Backup archive format

The Backup is the durability and portability unit ([ADR 0011](adr/0011-local-first.md)):
one file, encrypted client-side, self-contained — password or Recovery Key opens it
with nothing else on hand. Keys per [crypto-design.md](crypto-design.md).

## Design constraints

- **Streaming both ways.** Web imports without holding the whole archive in memory
  (decrypt → OPFS as frames arrive); mobile writes without a second full copy.
- **Self-contained.** Header carries everything needed to derive keys: KDF salt and
  params, both BMK wraps, the AK wrap. A fresh device restores from the file alone.
- **Tamper-evident end to end.** Every frame is AEAD-sealed and position-bound;
  truncation, reordering, and splicing are all detected.
- **Versioned, forward-only.** Readers keep opening every version ever shipped; the
  restore-from-every-prior-version test never gets deleted.

## Layout (v1)

```
[ magic "BTBK" | version u8 | header_len u32 ]
[ header (plaintext, CBOR):
    kdf: { alg: "argon2id", salt, m, t, p }
    bmk_wraps: [ { by: "password", nonce, ct }, { by: "recovery", nonce, ct } ]
    ak_wrap:   { nonce, ct }                    # AK wrapped by BMK
    created_at, app_version, schema_version
]
[ frame 0 | frame 1 | ... | final frame ]
```

Each frame:

```
[ len u32 | ciphertext ]
ciphertext = XChaCha20-Poly1305(
    key   = AK,
    nonce = 16-byte random prefix (fixed per archive, in header) || u64 frame counter,
    ad    = magic || version || frame counter || final_flag,
    body )
```

The counter in the nonce **and** the AD binds each frame to its position; the final
frame sets `final_flag` and carries the total frame count in its body, so
truncation is detected even though the stream is consumed incrementally.

Frame bodies, in order:

1. **Manifest** (CBOR): list of entries — `db` snapshot, then one entry per
   Document (`capture_id`, kind, byte length, content hash).
2. **DB snapshot** — the `VACUUM INTO` output, chunked into ≤ 4 MiB frames.
3. **Documents** — each chunked the same way, in manifest order.

Content hashes in the manifest let restore verify each entry after reassembly and
let a future incremental format skip unchanged documents (deferred, noted, not
built).

## Naming and retention

`btbk-v1-<device_id_short>-<ISO8601>.btbk`, e.g. `btbk-v1-9f3a-2026-08-29T203000Z.btbk`.
Device id in the name lets Merge-aware tooling and the Drive connector prune per
device. Retention: keep last N per device (default 10) plus the newest of each of
the last 3 months; prune runs after each successful upload.

## Restore = Merge

Restore never blind-overwrites. After decrypt and verification, the snapshot is
attached read-only and merged row-by-row into the live Ledger: match on
`capture_id`, latest `updated_at` wins, losers become tombstones
([data-model.md](data-model.md#merge)). A fresh install is just a merge into an
empty Ledger.

## Failure handling

- Write to a temp file, fsync, atomic rename; a killed backup never leaves a
  half-file under the real name.
- Any AEAD failure aborts restore before the merge touches the Ledger — partial
  restores do not exist.
- A version byte newer than the reader → explicit "update the app" error, not a
  parse attempt.
