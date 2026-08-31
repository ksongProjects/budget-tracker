# Running it yourself

Everything below runs from the repository root unless a step says otherwise.
No IDE is required for any of it — VS Code is a text editor here, not part of
the build, and Android Studio is only needed for the SDK it installs.

```bash
pnpm install
```

## The web app

The fastest thing to look at, and the only one with no device involved.

```bash
pnpm --filter @budget/web dev
```

Open the address it prints (http://localhost:5173). The ledger is empty on a
first visit — that is the intended state, not an error. Type a spend on **Add**,
import a bank CSV on **Import**, or open a phone's backup on **Backup**.

Data lives in the browser's OPFS storage, per origin. To start clean, clear site
data for localhost in devtools.

Other useful ones:

```bash
pnpm --filter @budget/web build     # production bundle into apps/web/dist
pnpm --filter @budget/web preview   # serve that bundle, which is what CI checks
node tools/bundle-budget.mjs        # what the bundle weighs, after a build
```

## The Android app

The SDK is installed but **not on PATH** on this machine, so the emulator and
`adb` are called by full path.

**1. Start an emulator.** Any AVD works; `Pixel_9` is the one already created.

```bash
"$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe" -avd Pixel_9 -no-snapshot-save -no-boot-anim
```

Leave it running. Wait until `adb shell getprop sys.boot_completed` prints `1` —
`adb devices` says `device` well before the system is actually usable.

```bash
export PATH="$PATH:$LOCALAPPDATA/Android/Sdk/platform-tools"
adb shell getprop sys.boot_completed
```

**2. Build and install the development build.** Needed once, and again after any
change to native dependencies. Gradle wants the JDK that ships with Android
Studio — the JDK on PATH is too new for it.

```bash
cd apps/mobile
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"
npx expo run:android --port 8082
```

That compiles the app, installs it, starts Metro, and opens it. Takes a few
minutes the first time and about a minute after.

**3. Later runs** only need Metro, since the app is already installed:

```bash
cd apps/mobile && npx expo start --port 8082
```

Then press `a`, or open the app on the emulator by hand.

**Expo Go will not do.** The app uses native modules that are not in it —
libsodium for the backup crypto, ML Kit for OCR — so the ledger opens but
backup, restore and receipt capture do not. The development build is the real
thing.

### Getting around the app

Only the ledger has navigation to Backup and Export. The rest are reachable by
deep link:

```bash
adb shell am start -a android.intent.action.VIEW -d "txns://backup"
adb shell am start -a android.intent.action.VIEW -d "txns://export"
adb shell am start -a android.intent.action.VIEW -d "txns://diagnostics"
adb shell am start -a android.intent.action.VIEW -d "txns://perf"
```

`/diagnostics` runs the driver contract, the crypto vectors and an archive
round-trip on the device itself. `/perf` seeds 10,000 transactions and measures
the budgets — useful, and it will take about half a minute.

Handy while poking at it:

```bash
adb shell run-as com.ksongprojects.txns ls -l files/backups
adb shell pm clear com.ksongprojects.txns    # wipe the app completely
adb exec-out screencap -p > shot.png
```

## Trying Drive without a Google account

`tools/fake-drive.mjs` speaks Drive's protocol into memory, so the upload and
restore paths can be driven with nothing leaving the machine.

```bash
pnpm --filter @budget/backup build
node tools/fake-drive.mjs --fail-every=2
```

It prints the address to use. On the Android emulator the host is always
`10.0.2.2`, whatever the machine's own address is:

```bash
cd apps/mobile
EXPO_PUBLIC_FAKE_DRIVE_URL=http://10.0.2.2:8787 npx expo start --port 8082
```

For the web app, use the address it printed for the LAN:

```bash
VITE_FAKE_DRIVE_URL=http://localhost:8787 pnpm --filter @budget/web dev
```

`--fail-every=2` drops one upload chunk in every two by killing the connection,
which is what the resume path exists for. Drop the flag for a quiet run.

## iOS

**Not possible from this machine.** Building an iOS app requires macOS and
Xcode; there is no Windows path to it, and no emulator that helps. The options,
in order of cost:

1. **A Mac.** Install Xcode, then `cd apps/mobile && npx expo run:ios`. Same
   development build as Android, running in the iOS Simulator. Nothing in the
   project is Android-specific, but nothing has been *run* on iOS either — see
   the note below.
2. **EAS Build**, Expo's cloud builder, from any machine:
   ```bash
   npx eas-cli build --platform ios --profile development
   ```
   This needs an Expo account, and an `eas.json` the repository does not have
   yet. Installing the result on a physical iPhone additionally needs an Apple
   Developer Program membership ($99/year) so the build can be signed for your
   device. A simulator build avoids the membership but still needs a Mac to run
   it on.
3. **Expo Go on an iPhone** shows the ledger and nothing that matters — no
   backup, no restore, no capture — for the reason given above. It is not a
   useful test of this app.

**Nothing has ever run on iOS.** That is recorded in
[deferred.md](deferred.md), and the specific unknown is whether the OS keystore
can be read while the device is locked, which is when a scheduled backup would
run. Expect the first iOS session to find things.

## Checks

```bash
pnpm check       # typecheck, lint, node tests, browser tests, bundle budget
pnpm test        # the fast suite only
pnpm test:web    # the browser suite, in headless Chromium
```

The browser suite downloads a headless Chromium the first time:

```bash
pnpm --filter @budget/web exec playwright install chromium
```

## When something will not start

- **Metro refuses the port.** A previous run is still holding it. Kill stray
  node processes, or pick another port — but keep the port in the `expo start`
  and the emulator's URL the same.
- **`adb` finds no device.** The emulator is still booting. Wait for
  `sys.boot_completed`.
- **The app opens to a white screen.** Metro is not reachable from the emulator.
  Check the address Expo printed and that the two agree.
- **Gradle fails on the JDK version.** `JAVA_HOME` is not pointing at Android
  Studio's bundled JDK. See step 2.
