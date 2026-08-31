# Privacy labels

What the stores ask, and the answers this app can give. Every one of them is a
consequence of ADR 0011: the ledger lives on the device, so most of these
questions have the short answer.

Neither store's form has a box for "the developer has no servers", so the
answers below are the closest true thing plus the note that makes them
unambiguous.

## Apple — App Privacy ("nutrition labels")

| Question | Answer |
|---|---|
| Data used to track you | **None.** No advertising identifier, no third-party analytics, no SDK that phones home. |
| Data linked to you | **None.** There is no account, so there is nothing to link data *to*. |
| Data not linked to you | **None collected.** |
| Third-party analytics | None. |
| Crash reporting | None in the MVP. If one is added it must be opt-in and must not carry ledger contents; that is a decision to re-take here, not a default. |

**Purchases, financial info, contacts, location, contacts, photos:** the app
reads what the user gives it — a photo of a receipt, a spoken sentence — and
keeps it on the device. None of it is *collected* in Apple's sense, because
none of it reaches the developer.

Two flows leave the device, both user-initiated, neither to us:

- **Backup to Google Drive** (optional). An encrypted archive goes to the
  user's own Drive, in the hidden app folder, under their own account. The
  contents are opaque to Google and to us: the archive is sealed with a key
  derived from a password that never leaves the phone.
- **Cloud Assist** (optional, off by default, per capture). Redacted extracted
  *text* goes to the AI provider the user chose, using the user's own API key.
  Never the photo, never the recording, never the ledger. The user reads the
  exact text and taps before each send.

Declare both under "Data Not Collected" with the disclosure that the app
facilitates a user-initiated transfer to a service the user controls. The
review note should say so in one sentence.

## Google Play — Data safety

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No.** |
| Is all user data encrypted in transit? | Not applicable to app data — none is transmitted by the app. The two optional user-initiated flows are HTTPS. |
| Do you provide a way for users to request data deletion? | The data is on their device. Uninstalling removes it; the app can delete backups and captures from inside. |
| Is your app's data collection independently validated? | No. |
| Financial info | Not collected. Amounts a user types stay in the local database. |
| Photos | Not collected. Receipt photos are stored on the device and never uploaded by the app. |
| Audio | Not collected. Recordings are transcribed on the device and deleted immediately after. |
| Device or other IDs | The app generates a random device id for merge conflict resolution. It is local, not tied to a hardware identifier, and never leaves except inside an encrypted backup. |

## Permissions, and why

| Permission | Why | What happens without it |
|---|---|---|
| Camera | Photographing a receipt. | Every other capture path works; the photo button explains. |
| Microphone | Speaking a spend. | Voice capture is unavailable; nothing else changes. |
| Network | The speech model download (once), optional Drive backup, optional Cloud Assist. | Everything except those three works offline, permanently. |

The app asks for no storage permission at all: it reads and writes inside its
own directory. That is why the diagnostics fixture lives there rather than in
`/sdcard`.

## The claim we are making

"Your spending stays on your phone" is a promise, and these labels are where it
becomes a legal one. Before submitting, re-read [../architecture.md](../architecture.md)
§ data flow and confirm nothing has been added since that contradicts it — a
single analytics SDK added in a hurry would make every line above false.
