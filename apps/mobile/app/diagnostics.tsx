import { useState } from 'react';
import type { ReactNode } from 'react';
import { Buffer } from 'buffer';
import { Asset } from 'expo-asset';
import { AudioModule } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DRIVER_CONTRACT, SCHEMA_VERSION } from '@budget/db';
import {
  CRYPTO_VECTORS,
  KDF_PARAMS,
  deriveKek,
  formatRecoveryKey,
  generateRecoveryKey,
  generateSalt,
} from '@budget/crypto';
import { readArchive, writeArchive } from '@budget/backup';
import { createNativeSodiumBackend } from '../src/crypto/backend';
import { applyRules, extractReceipt, formatScore, readWavHeader, scoreEngine } from '@budget/extract';
import type { StructuringEngine } from '@budget/extract';
import { CurrencySchema, formatAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { createExpoDriver } from '../src/db/driver';
import { useLedger } from '../src/db/provider';
import {
  isAutoBackupRegistered,
  registerAutoBackupTask,
  triggerAutoBackupForTesting,
} from '../src/backup/auto';
import {
  lastBackupAt,
  listBackups,
  readScheduledRun,
  restoreBackup,
  sweepPartials,
} from '../src/backup/service';
import { parseUtterance } from '@budget/extract';
import { isModelPresent } from '../src/voice/model';
import { whisperEngine } from '../src/voice/whisper';
import { discardRecording, startRecording, stopRecording } from '../src/voice/recorder';
import { deviceEngines, deviceModel, engineList } from '../src/llm/engines';
import { assistOffer, runAssist, textToSend } from '../src/llm/assist';
import { loadOcrEngine } from '../src/capture/ocr';
import { colors, radius, spacing, text } from '../src/ui/theme';

const DEFAULT_CURRENCY = CurrencySchema.parse('USD');

/**
 * Runs the shared driver contract against the real expo-sqlite driver, on the
 * device.
 *
 * CI proves the contract against node:sqlite, which is not the database that
 * ships. This screen is how the mobile driver's behaviour gets checked on real
 * hardware — a device build, open this, everything green. Without it, "the
 * mobile driver behaves like the tested one" is an assumption.
 */

interface Result {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}

/**
 * Run something that is supposed to fail, and report whether it did.
 *
 * A refusal is the pass here. Written as one helper so a check that quietly
 * *succeeded* — the dangerous outcome — cannot be mistaken for a green line.
 */
async function refuses(what: string, work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return `✗ ${what}: accepted, which it must not`;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `✓ ${what} refused: ${message.slice(0, 80)}`;
  }
}

export default function DiagnosticsScreen(): ReactNode {
  const ledger = useLedger();
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [ocr, setOcr] = useState<string[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [cryptoResults, setCryptoResults] = useState<Result[]>([]);
  const [cryptoRunning, setCryptoRunning] = useState(false);
  const [archiveLines, setArchiveLines] = useState<string[]>([]);
  const [archiveRunning, setArchiveRunning] = useState(false);
  const [scheduleLines, setScheduleLines] = useState<string[]>([]);
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [voiceLines, setVoiceLines] = useState<string[]>([]);
  const [voiceRunning, setVoiceRunning] = useState(false);
  const [captureLines, setCaptureLines] = useState<string[]>([]);
  const [captureRunning, setCaptureRunning] = useState(false);
  const [tierLines, setTierLines] = useState<string[]>([]);
  const [tierRunning, setTierRunning] = useState(false);
  const [failLines, setFailLines] = useState<string[]>([]);
  const [failRunning, setFailRunning] = useState(false);

  /**
   * Transcribe a known recording, rather than whatever the microphone hears.
   *
   * The emulator's microphone produces silence, and a person with a real phone
   * proves accuracy better than any fixture could. What this proves is the part
   * that cannot be checked any other way: the model loads, the native library
   * runs, and words come back. Push a 16 kHz mono WAV into the app's own
   * documents directory first — `/sdcard` needs a storage permission this app
   * has no reason to hold, and a denied read reaches whisper.rn as an empty
   * buffer, which it reports as "Invalid WAV file".
   */
  const runVoice = async (): Promise<void> => {
    setVoiceRunning(true);
    setVoiceLines([]);

    const lines: string[] = [];
    try {
      lines.push(`model present: ${String(await isModelPresent())}`);

      const uri = `${FileSystem.documentDirectory ?? ''}voice-test.wav`;
      lines.push(`fixture: ${String((await FileSystem.getInfoAsync(uri)).exists)}`);
      const started = Date.now();
      const spoken = await whisperEngine.transcribe(uri);

      lines.push(`heard: "${spoken.text}"`);
      lines.push(`took: ${String(Date.now() - started)} ms`);

      const candidate = parseUtterance(spoken.text);
      lines.push(
        candidate.total === undefined
          ? 'read: no amount found'
          : `read: ${String(candidate.total.value)} minor units ` +
            (candidate.currency?.value ?? '?') +
            (candidate.merchant === undefined ? '' : ` at ${candidate.merchant.value}`),
      );
    } catch (cause) {
      // Native rejections are not always Errors, and "[object Object]" is the
      // least useful thing a diagnostic can say.
      lines.push(
        `failed: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
      );
    }

    setVoiceLines(lines);
    setVoiceRunning(false);
  };

  /**
   * Record from the microphone and read the result back.
   *
   * The seam this covers is the format one: the recorder writes raw PCM into a
   * WAV header of our own making, and whisper.cpp accepts exactly one shape of
   * that. What the emulator's microphone hears is silence, so the transcript
   * here proves nothing about accuracy — but "no error, header reads back at
   * 16 kHz mono" proves the recording is something the engine can read, which
   * is the part that was broken when the screen used expo-audio's m4a.
   */
  const runCapture = async (): Promise<void> => {
    setCaptureRunning(true);
    setCaptureLines([]);

    const lines: string[] = [];
    try {
      const granted = await AudioModule.requestRecordingPermissionsAsync();
      lines.push(`microphone: ${granted.granted ? 'granted' : 'denied'}`);
      if (!granted.granted) {
        setCaptureLines(lines);
        setCaptureRunning(false);
        return;
      }

      startRecording();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const recorded = await stopRecording();

      const base64 = await FileSystem.readAsStringAsync(recorded.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      const header = readWavHeader(bytes);

      lines.push(`captured: ${recorded.durationMs.toFixed(0)} ms, ${String(bytes.length)} bytes`);
      lines.push(
        `header: ${String(header.sampleRate)} Hz, ${String(header.channels)} ch, ` +
          `${String(header.bitsPerSample)}-bit, data ${String(header.dataSize)} bytes`,
      );

      const spoken = await whisperEngine.transcribe(recorded.uri);
      lines.push(`heard: "${spoken.text}"`);
      await discardRecording(recorded);
      lines.push(`cleaned up: ${String(!(await FileSystem.getInfoAsync(recorded.uri)).exists)}`);
    } catch (cause) {
      lines.push(`failed: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`);
    }

    setCaptureLines(lines);
    setCaptureRunning(false);
  };

  /**
   * Score every engine this device can offer against the fixture suite.
   *
   * The same harness CI runs, run where the models actually live. On a phone
   * with an on-device model this is the number that answers whether Tier 3 is
   * worth the battery; on every phone it reports the rules floor, which is
   * what a device with no model gets and the bar anything else has to clear.
   *
   * Cloud Assist is scored only if a key is here, and even then the fixtures
   * are invented text rather than anyone's receipts — sending them costs the
   * user a few cents of their own quota, and nothing personal leaves.
   */
  const runTiers = async (): Promise<void> => {
    setTierRunning(true);
    setTierLines([]);

    const lines: string[] = [];
    const model = deviceModel();
    lines.push(`${model.label}: ${model.capability.availability}`);

    const rules: StructuringEngine = {
      name: 'rules',
      remote: false,
      capability: () => Promise.resolve({ availability: 'ready' }),
      structure: (request) => Promise.resolve(applyRules(request)),
    };

    // The remote engine is left out: scoring it would send eight captures
    // without the per-capture tap that is the whole point of the consent rule.
    const engines = [rules, ...deviceEngines()];
    lines.push(`engines configured: ${String((await engineList()).length + 1)}`);

    for (const engine of engines) {
      try {
        const score = await scoreEngine(engine, { defaultCurrency: DEFAULT_CURRENCY });
        lines.push(...formatScore(score).split('\n'));
      } catch (cause) {
        lines.push(`${engine.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    setTierLines(lines);
    setTierRunning(false);
  };

  /**
   * Break the backup path on purpose, three ways, and check it holds.
   *
   * The archive tests cover corrupt bytes in CI. What only a device can show is
   * what the *app* does with them: whether a refused restore leaves the ledger
   * exactly as it was, whether a write killed midway leaves megabytes behind
   * forever, and whether a backup from a newer version of the app is refused
   * rather than merged into a schema that cannot hold it.
   *
   * Each of these is a real user's worst day. Nothing here is destructive: the
   * restores are all expected to fail, and the row count is checked before and
   * after to prove they did nothing.
   */
  const runFailures = async (): Promise<void> => {
    setFailRunning(true);
    setFailLines([]);

    const lines: string[] = [];
    const count = async (): Promise<number> =>
      (await ledger.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'))?.n ?? 0;

    try {
      const sodium = await createNativeSodiumBackend();
      const salt = generateSalt(sodium);
      const kek = deriveKek(sodium, 'a real password', salt);
      const recoveryKey = generateRecoveryKey(sodium);
      const before = await count();
      lines.push(`ledger holds ${String(before)} transactions`);

      // Big enough that the encrypted body is most of the file: with a
      // four-byte payload the header is nearly the whole archive, and a byte
      // flipped "in the middle" would land in JSON rather than in ciphertext.
      const payload = new Uint8Array(20_000);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

      const good = writeArchive(
        sodium,
        [{ id: 'db', kind: 'db', bytes: payload }],
        kek,
        recoveryKey,
        salt,
        {
          appVersion: '0.1.0',
          schemaVersion: SCHEMA_VERSION,
          createdAt: Date.now(),
          kdfParams: KDF_PARAMS,
        },
      );

      // 1. A bit flipped in the ciphertext — a failing disk, a truncated
      // download, a file someone edited. The AEAD tag is what must catch it.
      const flipped = Uint8Array.from(good.bytes);
      const inBody = flipped.length - 200;
      flipped[inBody] = (flipped[inBody] ?? 0) ^ 0xff;

      lines.push(await refuses('flipped bit in the body', () => restoreBackup(ledger, flipped, kek, sodium)));

      // 2. A damaged header, which fails earlier and differently — before any
      // key is derived, so the message must still be one a person can act on.
      const damagedHeader = Uint8Array.from(good.bytes);
      damagedHeader[60] = (damagedHeader[60] ?? 0) ^ 0xff;

      lines.push(await refuses('damaged header', () => restoreBackup(ledger, damagedHeader, kek, sodium)));

      // 3. Truncation: the write that stopped halfway and was renamed anyway.
      lines.push(
        await refuses('truncated archive', () =>
          restoreBackup(ledger, good.bytes.slice(0, good.bytes.length - 500), kek, sodium),
        ),
      );

      // 4. An archive from a newer version of the app.
      const newer = writeArchive(
        sodium,
        [{ id: 'db', kind: 'db', bytes: payload }],
        kek,
        recoveryKey,
        salt,
        {
          appVersion: '99.0.0',
          schemaVersion: SCHEMA_VERSION + 1,
          createdAt: Date.now(),
          kdfParams: KDF_PARAMS,
        },
      );

      lines.push(await refuses('downgrade', () => restoreBackup(ledger, newer.bytes, kek, sodium)));

      // 5. The wrong password, which is the one a user hits by accident.
      const wrong = deriveKek(sodium, 'not the password', salt);
      lines.push(await refuses('wrong password', () => restoreBackup(ledger, good.bytes, wrong, sodium)));

      const after = await count();
      lines.push(
        after === before
          ? `✓ ledger untouched: still ${String(after)} transactions`
          : `✗ ledger changed: ${String(before)} → ${String(after)}`,
      );

      // 6. A write killed midway leaves a `.partial`. The next backup must
      // clear it, or a device that dies mid-backup leaks megabytes every time.
      const planted = `${FileSystem.documentDirectory ?? ''}backups/killed-write.btbk.partial`;
      await FileSystem.writeAsStringAsync(planted, 'not a real archive');
      const swept = await sweepPartials();
      const stillThere = (await FileSystem.getInfoAsync(planted)).exists;
      lines.push(
        !stillThere && swept > 0
          ? `✓ interrupted write swept (${String(swept)} file)`
          : '✗ interrupted write left behind',
      );
    } catch (cause) {
      lines.push(`✗ failed: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`);
    }

    setFailLines(lines);
    setFailRunning(false);
  };

  /**
   * Checks the OS-scheduled backup path.
   *
   * It cannot be run from here: expo-background-task refuses while the app is
   * foregrounded ("runTasks: App is in the foreground") and only reschedules,
   * so the trigger returns null and nothing happens. What this can do is report
   * whether the OS is holding a registration, and show what the worker recorded
   * the last time it did run — which is the only evidence that exists, since
   * the task runs with no UI attached.
   */
  const runSchedule = async (): Promise<void> => {
    setScheduleRunning(true);
    setScheduleLines([]);

    const lines: string[] = [];
    try {
      lines.push(`status: ${String(await registerAutoBackupTask())} (2 = available)`);
      lines.push(`registered: ${String(await isAutoBackupRegistered())}`);

      // Asked for anyway, so the null result is visible rather than folklore.
      lines.push(`trigger from the foreground: ${String(await triggerAutoBackupForTesting())}`);

      const run = await readScheduledRun();
      lines.push(
        run === undefined
          ? 'the scheduled worker has never run on this device'
          : `last worker run: ${run.outcome}${run.error === undefined ? '' : ` — ${run.error}`}` +
            ` at ${new Date(run.at).toLocaleString()}`,
      );

      const listStarted = Date.now();
      const backups = await listBackups();
      lines.push(`listBackups: ${String(backups.length)} in ${String(Date.now() - listStarted)} ms`);
      lines.push(`newest archive: ${String((await lastBackupAt()) ?? 'none')}`);
      lines.push(
        'to make the OS run it: background the app, then ' +
          'adb shell cmd jobscheduler run -f <package> <job id>',
      );
    } catch (cause) {
      lines.push(`failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    setScheduleLines(lines);
    setScheduleRunning(false);
  };

  /**
   * The Cloud Assist gate, on hardware, against real OCR output.
   *
   * The adapter tests prove the refusals in CI with a fake fetch. This proves
   * the same thing where it matters — a real key from the keystore, a real
   * network stack, a real receipt — by asking twice: once with no permission,
   * which must reach the network never and fall back to the rules, and once
   * with permission for that exact text, which must actually go.
   *
   * With a test key the second call comes back 401, and that is the point: a
   * refusal from the provider is proof the request left, and a request that
   * never left could not be refused.
   */
  const checkAssistGate = async (receiptText: string): Promise<string[]> => {
    const lines = ['--- cloud assist gate ---'];
    const offer = await assistOffer();

    lines.push(`offer: ${offer.available ? offer.label : 'nothing to offer'}`);
    if (!offer.available) return lines;

    const withoutConsent = await runAssist({ text: receiptText, kind: 'receipt' });
    lines.push(`no permission: read by ${withoutConsent.engine} (expect rules)`);

    const sending = textToSend(receiptText);
    lines.push(`would send ${String(sending.length)} characters, masked`);

    try {
      const withConsent = await runAssist({
        text: receiptText,
        kind: 'receipt',
        approvedText: sending,
        onError: (engine, cause) => {
          lines.push(`${engine} said: ${cause instanceof Error ? cause.message : String(cause)}`);
        },
      });
      lines.push(`with permission: read by ${withConsent.engine}`);
    } catch (cause) {
      lines.push(`with permission: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    return lines;
  };

  /**
   * Runs the published crypto vectors against native libsodium.
   *
   * CI runs them against the WASM build, which Hermes cannot load. If the two
   * disagree, backups written on a phone are unopenable on the web — and
   * nothing else in the project would catch it.
   */
  const runCrypto = async (): Promise<void> => {
    setCryptoRunning(true);
    setCryptoResults([]);

    const collected: Result[] = [];
    try {
      const backend = await createNativeSodiumBackend();

      for (const vector of CRYPTO_VECTORS) {
        try {
          vector.run(backend);
          collected.push({ name: vector.name, passed: true });
        } catch (error) {
          collected.push({
            name: vector.name,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        setCryptoResults([...collected]);
      }
    } catch (error) {
      collected.push({
        name: 'load native libsodium',
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      setCryptoResults([...collected]);
    }

    setCryptoRunning(false);
  };

  /**
   * Runs the real OCR engine over a known receipt and reports what the tier-2
   * rules made of it. The rules are unit-tested against fixture text; this is
   * the only check of the seam between a real engine's output and those rules.
   */
  const runOcr = async (): Promise<void> => {
    setOcrRunning(true);
    setOcr([]);

    const lines: string[] = [];
    const engine = loadOcrEngine();

    if (!engine) {
      setOcr(['No OCR engine — this is Expo Go. Use a development build.']);
      setOcrRunning(false);
      return;
    }

    try {
      // Metro resolves bundled assets through require and nothing else.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const asset = Asset.fromModule(require('../assets/test-receipt.png') as number);
      await asset.downloadAsync();

      const uri = asset.localUri ?? asset.uri;
      const result = await engine.recognize(uri);
      lines.push(`engine ${result.engine}, ${result.lines.length} lines, ${result.durationMs} ms`);

      const candidate = extractReceipt(result);
      const money = (m: MinorUnits, c: Currency | undefined): string =>
        c ? formatAmount(m, c) : String(m);

      // The expected values are the ones printed on assets/test-receipt.png.
      lines.push(
        candidate.total
          ? `total ${money(candidate.total.value, candidate.currency?.value)} (expect 10.60)`
          : 'total: not found (expect 10.60)',
      );
      lines.push(
        candidate.tax
          ? `tax ${money(candidate.tax.value, candidate.currency?.value)} (expect 0.85)`
          : 'tax: not found (expect 0.85)',
      );
      lines.push(`merchant ${candidate.merchant?.value ?? 'not found'} (expect BLUE BOTTLE COFFEE)`);
      lines.push(`card ${candidate.cardLast4?.value ?? 'not found'} (expect 4242)`);
      lines.push(
        candidate.occurredAt
          ? `date ${new Date(candidate.occurredAt.value).toDateString()} (expect Mar 14 2026)`
          : 'date: not found (expect Mar 14 2026)',
      );

      // The raw lines, because how an engine splits a receipt is the thing
      // fixture text cannot tell you.
      lines.push('--- raw lines ---');
      for (const [i, line] of result.lines.entries()) {
        lines.push(`${i}: ${JSON.stringify(line.text)}`);
      }
      // Written to a file so the exact engine output can be pulled off the
      // device and committed as a fixture.
      await FileSystem.writeAsStringAsync(
        `${FileSystem.documentDirectory ?? ''}ocr-lines.json`,
        JSON.stringify(result.lines, null, 2),
      );

      lines.push(...(await checkAssistGate(result.lines.map((line) => line.text).join('\n'))));
    } catch (error) {
      lines.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    setOcr(lines);
    setOcrRunning(false);
  };

  /**
   * A full archive write-and-read on the device, with native crypto.
   *
   * The vectors prove the primitives agree; this proves the format built on
   * them survives Hermes. It is the first thing here to exercise BigInt and
   * DataView.setBigUint64, which the frame nonces depend on and which no vector
   * touches.
   */
  const runArchive = async (): Promise<void> => {
    setArchiveRunning(true);
    setArchiveLines([]);

    const lines: string[] = [];
    const engine =
      typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object'
        ? 'Hermes'
        : 'JavaScriptCore';
    lines.push(`JS engine: ${engine}`);

    try {
      const sodium = await createNativeSodiumBackend();

      const salt = generateSalt(sodium);
      const started = Date.now();
      const kek = deriveKek(sodium, 'a real password', salt);
      lines.push(`Argon2id (64 MiB, t=3): ${String(Date.now() - started)} ms`);

      const recoveryKey = generateRecoveryKey(sodium);
      lines.push(`recovery key: ${formatRecoveryKey(recoveryKey).slice(0, 11)}…`);

      // Several frames, so the nonce counter actually advances past zero.
      const payload = new Uint8Array(5000);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

      const { bytes } = writeArchive(
        sodium,
        [
          { id: 'db', kind: 'db', bytes: payload },
          { id: 'cap-1', kind: 'document', bytes: Uint8Array.from([9, 8, 7, 6]) },
        ],
        kek,
        recoveryKey,
        salt,
        {
          appVersion: '0.1.0',
          schemaVersion: 2,
          createdAt: Date.now(),
          kdfParams: KDF_PARAMS,
          maxFrameBytes: 1024,
        },
      );
      lines.push(`wrote ${String(bytes.length)} bytes`);

      const byPassword = readArchive(sodium, bytes, kek);
      const restored = byPassword.entries[0]?.bytes;
      const roundTripped =
        restored !== undefined &&
        restored.length === payload.length &&
        restored.every((byte, i) => byte === payload[i]);
      lines.push(roundTripped ? '✓ round-trip byte for byte' : '✗ ROUND-TRIP CORRUPTED');

      const byRecovery = readArchive(sodium, bytes, recoveryKey);
      lines.push(
        byRecovery.entries.length === 2 ? '✓ opens with recovery key' : '✗ recovery key failed',
      );

      // Tamper detection has to work on device too, not just in CI.
      const tampered = Uint8Array.from(bytes);
      tampered[bytes.length - 1] = (tampered[bytes.length - 1] ?? 0) ^ 0x01;
      try {
        readArchive(sodium, tampered, kek);
        lines.push('✗ TAMPERED ARCHIVE WAS ACCEPTED');
      } catch {
        lines.push('✓ rejects a tampered archive');
      }
    } catch (error) {
      lines.push(`✗ failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    setArchiveLines(lines);
    setArchiveRunning(false);
  };

  const run = async (): Promise<void> => {
    setRunning(true);
    setResults([]);

    const collected: Result[] = [];
    for (const [index, testCase] of DRIVER_CONTRACT.entries()) {
      // A scratch database per case, so one failure cannot cascade.
      const name = `contract-${String(index)}-${String(Date.now())}.db`;
      const driver = await createExpoDriver(name);
      try {
        await testCase.run(driver);
        collected.push({ name: testCase.name, passed: true });
      } catch (error) {
        collected.push({
          name: testCase.name,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await driver.close();
      }
      setResults([...collected]);
    }

    setRunning(false);
  };

  const failed = results.filter((r) => !r.passed).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={text.muted}>
        Runs the same contract CI runs against node:sqlite, but against the
        database this app actually uses.
      </Text>

      <Pressable style={styles.button} onPress={() => void run()} disabled={running}>
        <Text style={styles.buttonText}>{running ? 'Running…' : 'Run driver contract'}</Text>
      </Pressable>

      {results.length > 0 && (
        <Text style={[text.heading, failed > 0 ? styles.fail : styles.pass]}>
          {failed === 0
            ? `All ${String(results.length)} passed`
            : `${String(failed)} of ${String(results.length)} failed`}
        </Text>
      )}

      <Pressable
        style={styles.button}
        onPress={() => void runSchedule()}
        disabled={scheduleRunning}
      >
        <Text style={styles.buttonText}>
          {scheduleRunning ? 'Checking…' : 'Check the scheduled backup'}
        </Text>
      </Pressable>

      {scheduleLines.map((line) => (
        <Text key={line} style={text.muted}>
          {line}
        </Text>
      ))}

      <Pressable style={styles.button} onPress={() => void runVoice()} disabled={voiceRunning}>
        <Text style={styles.buttonText}>
          {voiceRunning ? 'Listening…' : 'Transcribe the test recording'}
        </Text>
      </Pressable>

      {voiceLines.map((line) => (
        <Text key={line} style={text.muted}>
          {line}
        </Text>
      ))}

      <Pressable style={styles.button} onPress={() => void runCapture()} disabled={captureRunning}>
        <Text style={styles.buttonText}>
          {captureRunning ? 'Recording…' : 'Record three seconds and read it'}
        </Text>
      </Pressable>

      {captureLines.map((line) => (
        <Text key={line} style={text.muted}>
          {line}
        </Text>
      ))}

      <Pressable style={styles.button} onPress={() => void runTiers()} disabled={tierRunning}>
        <Text style={styles.buttonText}>
          {tierRunning ? 'Scoring…' : 'Score the reading engines'}
        </Text>
      </Pressable>

      {tierLines.map((line) => (
        <Text key={line} style={text.muted}>
          {line}
        </Text>
      ))}

      <Pressable style={styles.button} onPress={() => void runCrypto()} disabled={cryptoRunning}>
        <Text style={styles.buttonText}>
          {cryptoRunning ? 'Checking…' : 'Run crypto vectors'}
        </Text>
      </Pressable>

      {cryptoResults.length > 0 && (
        <Text
          style={[text.heading, cryptoResults.some((r) => !r.passed) ? styles.fail : styles.pass]}
        >
          {cryptoResults.every((r) => r.passed)
            ? `All ${String(cryptoResults.length)} crypto vectors passed`
            : `${String(cryptoResults.filter((r) => !r.passed).length)} crypto vectors FAILED`}
        </Text>
      )}

      {cryptoResults
        .filter((result) => !result.passed)
        .map((result) => (
          <View key={result.name} style={styles.row}>
            <Text style={styles.fail}>✗ {result.name}</Text>
            {result.error !== undefined && <Text style={styles.errorText}>{result.error}</Text>}
          </View>
        ))}

      <Pressable style={styles.button} onPress={() => void runArchive()} disabled={archiveRunning}>
        <Text style={styles.buttonText}>
          {archiveRunning ? 'Writing…' : 'Round-trip a real archive'}
        </Text>
      </Pressable>

      {archiveLines.map((line) => (
        <View key={line} style={styles.row}>
          <Text style={line.startsWith('✗') ? styles.fail : styles.pass}>{line}</Text>
        </View>
      ))}

      <Pressable style={styles.button} onPress={() => void runFailures()} disabled={failRunning}>
        <Text style={styles.buttonText}>
          {failRunning ? 'Breaking…' : 'Break backup and restore on purpose'}
        </Text>
      </Pressable>

      {failLines.map((line) => (
        <View key={line} style={styles.row}>
          <Text style={line.startsWith('✗') ? styles.fail : styles.pass}>{line}</Text>
        </View>
      ))}

      <Pressable style={styles.button} onPress={() => void runOcr()} disabled={ocrRunning}>
        <Text style={styles.buttonText}>{ocrRunning ? 'Reading…' : 'Run OCR on a known receipt'}</Text>
      </Pressable>

      {ocr.map((line) => (
        <View key={line} style={styles.row}>
          <Text style={styles.pass}>{line}</Text>
        </View>
      ))}

      {results.map((result) => (
        <View key={result.name} style={styles.row}>
          <Text style={result.passed ? styles.pass : styles.fail}>
            {result.passed ? '✓' : '✗'} {result.name}
          </Text>
          {result.error !== undefined && <Text style={styles.errorText}>{result.error}</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonText: { color: colors.accentText, fontWeight: '600', fontSize: 16 },
  row: { backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm, gap: spacing.xs },
  pass: { color: colors.text },
  fail: { color: colors.danger },
  errorText: { color: colors.danger, fontSize: 12 },
});
