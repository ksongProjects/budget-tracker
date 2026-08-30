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
[ header (plaintext, JSON — readable without any secret, so backups can be
  listed by date without unlocking them):
    kdf: { alg: "argon2id", salt, m, t, p }
    bmk_wraps: [ { by: "password", nonce, ct }, { by: "recovery", nonce, ct } ]
    ak_wrap:   { nonce, ct }                    # AK wrapped by BMK
    nonce_prefix: bytes(16)                     # random per archive; see frames
    created_at, app_version, schema_version
]
[ frame 0 | frame 1 | ... | final frame ]
```

Each frame:

```
[ len u32 | ciphertext ]
ciphertext = XChaCha20-Poly1305(
    key   = AK,
    nonce = header.nonce_prefix (16 B) || u64 frame counter,
    ad    = magic || version || frame counter || final_flag,
    body )
```

The counter appears in the nonce **and** in the AD. In the nonce it guarantees
no two frames of an archive share one; in the AD it binds each frame to its
position, so a frame moved or spliced in from another archive fails to
authenticate.

Truncation is caught by `final_flag`: every frame but the last is sealed as
non-final, so a reader that runs out of bytes early treats some earlier frame as
final and authentication fails. The manifest's per-entry frame count and byte
length catch it a second time. No separate frame-count field is needed, and
earlier drafts of this doc that described one were never implemented.

Frame bodies, in order:

1. **Manifest** (JSON): list of entries — `db` snapshot, then one entry per
   Document (`capture_id`, kind, byte length, content hash, frame count).
2. **DB snapshot** — the `VACUUM INTO` output, chunked into ≤ 4 MiB frames.
3. **Documents** — each chunked the same way, in manifest order.

Content hashes in the manifest let restore verify each entry after reassembly and
let a future incremental format skip unchanged documents (deferred, noted, not
built).

## Writing a backup with neither secret present

Both BMK wraps are ciphertext, so a device can keep them and reuse them verbatim
in later archives. That is what makes an **automatic** backup possible: when the
app is sent to the background, nobody is there to type a password or read a
recovery key off paper, and the BMK is stable by design, so the wraps written at
setup stay correct forever.

Keeping them costs nothing an attacker does not already have — the BMK itself is
in the same OS keystore, and it unwraps every archive key directly. What is
never stored is either *secret*: the password and the Recovery Key exist only in
memory, only while the user is supplying them.

The archive key is still fresh per archive, so this does not make one compromised
key open the whole history.

One consequence has teeth: **a restore must replace the stored wraps with the
restored archive's own**, because they wrap that archive's BMK and the ones
already on the device wrap the BMK it had a moment earlier. Leaving them would
make the next automatic backup seal a file whose wraps hand back the wrong master
key — an archive nothing opens, discovered only on the day it is needed.

## Naming and retention

`btbk-v1-<device_id_short>-<ISO8601>.btbk`, e.g. `btbk-v1-9f3a-2026-08-29T203000Z.btbk`.
Device id in the name lets Merge-aware tooling and the Drive connector prune per
device.

**On the device today**: keep the newest 5 archives, and delete any `.partial`
left by an interrupted write. Prune runs inside every successful write —
automatic and manual alike, because hanging it off the scheduler let a user who
backed up by hand fill the device and never be told. The
richer policy — last N *per device*, plus the newest of each of the last three
months — belongs to the Drive connector, where archives from several devices
land in one place; on a phone every archive is this device's and the newest is
the one that matters.

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
