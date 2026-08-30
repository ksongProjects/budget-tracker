import { useState } from 'react';
import type { ReactNode } from 'react';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DRIVER_CONTRACT } from '@budget/db';
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
import { extractReceipt } from '@budget/extract';
import { formatAmount } from '@budget/schema';
import type { Currency, MinorUnits } from '@budget/schema';
import { createExpoDriver } from '../src/db/driver';
import { loadOcrEngine } from '../src/capture/ocr';
import { colors, radius, spacing, text } from '../src/ui/theme';

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

export default function DiagnosticsScreen(): ReactNode {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [ocr, setOcr] = useState<string[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [cryptoResults, setCryptoResults] = useState<Result[]>([]);
  const [cryptoRunning, setCryptoRunning] = useState(false);
  const [archiveLines, setArchiveLines] = useState<string[]>([]);
  const [archiveRunning, setArchiveRunning] = useState(false);

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
