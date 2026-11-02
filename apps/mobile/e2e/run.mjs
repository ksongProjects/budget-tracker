/* global console, process */
/**
 * Runs the Maestro flows in e2e/flows against an Android **emulator**.
 *
 *   node apps/mobile/e2e/run.mjs [--apk <path>] [--no-install] [flow.yaml ...]
 *
 * Every flow starts with `clearState`, which deletes the app's data — on a
 * phone, that is someone's ledger. So this refuses to run anywhere but an
 * emulator: the serial must be `emulator-*` and the device must report itself
 * as virtual (ro.kernel.qemu / ro.boot.qemu). A phone plugged in at the same
 * time is ignored, never targeted.
 *
 * The APK must be the build being shipped, for the emulator's ABI. The release
 * APK is arm64-only and does not start on an x86_64 AVD; build the same commit
 * with -PreactNativeArchitectures=x86_64 (docs/running-locally.md).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const APP_ID = 'com.ksongprojects.txns';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [value] = args.splice(at, 2).slice(1);
  return value;
};
const flag = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
};

const apk = option('--apk') ?? join(mobile, 'android/app/build/outputs/apk/release/app-release.apk');
const skipInstall = flag('--no-install');
const flows = args.length > 0 ? args : [join(here, 'flows')];

const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? homedir(), 'Android', 'Sdk');
const adbPath = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adb = (...command) => execFileSync(existsSync(adbPath) ? adbPath : 'adb', command, { encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`e2e: ${message}`);
  process.exit(1);
}

// --- Find the emulator, and only the emulator -----------------------------

const serials = adb('devices')
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter(([, state]) => state === 'device')
  .map(([serial]) => serial);

const emulators = serials.filter((serial) => serial.startsWith('emulator-'));
if (emulators.length === 0) {
  fail(`no emulator attached (devices: ${serials.join(', ') || 'none'}). Start one; this never runs on a phone.`);
}
if (emulators.length > 1) fail(`more than one emulator attached: ${emulators.join(', ')}. Leave one.`);
const [serial] = emulators;

const prop = (name) => adb('-s', serial, 'shell', 'getprop', name);
if (prop('ro.kernel.qemu') !== '1' && prop('ro.boot.qemu') !== '1') {
  fail(`${serial} does not report itself as an emulator. Refusing: the flows wipe app data.`);
}
if (prop('sys.boot_completed') !== '1') fail(`${serial} has not finished booting.`);

const others = serials.filter((s) => s !== serial);
if (others.length > 0) console.log(`e2e: ignoring ${others.join(', ')}; running on ${serial} only.`);

// --- Install the build under test, and the files the flows pick -----------

if (!skipInstall) {
  if (!existsSync(apk)) fail(`no APK at ${apk}. Build one, or pass --apk.`);
  console.log(`e2e: installing ${apk}`);
  adb('-s', serial, 'install', '-r', apk);
}

const fixtures = join(here, 'fixtures');
const files = [
  ...readdirSync(fixtures).map((name) => join(fixtures, name)),
  join(mobile, 'assets', 'test-receipt.png'),
];
for (const file of files) {
  const name = file.split(/[\\/]/).pop();
  adb('-s', serial, 'push', file, `/sdcard/Download/${name}`);
  adb(
    '-s', serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file:///sdcard/Download/${name}`,
  );
}

// --- Run ------------------------------------------------------------------

const maestroHome = join(homedir(), '.maestro', 'maestro', 'bin');
const maestro = join(maestroHome, process.platform === 'win32' ? 'maestro.bat' : 'maestro');
const studioJava = 'C:/Program Files/Android/Android Studio/jbr';
const env = {
  ...process.env,
  ...(process.env.JAVA_HOME === undefined && existsSync(studioJava) ? { JAVA_HOME: studioJava } : {}),
  MAESTRO_CLI_NO_ANALYTICS: '1',
};

console.log(`e2e: running ${flows.join(' ')} on ${serial} (${APP_ID})`);
const result = spawnSync(
  existsSync(maestro) ? maestro : 'maestro',
  ['--device', serial, 'test', '--format', 'junit', '--output', join(here, 'report.xml'), ...flows],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
