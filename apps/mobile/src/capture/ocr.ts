import type { OcrEngine, OcrResult } from '@budget/extract';

/**
 * The on-device OCR engine, when one is available.
 *
 * Text recognition (iOS Vision, Android ML Kit) is a native module, so it is
 * absent in Expo Go and present in a development build. Rather than crash or
 * pretend, `loadOcrEngine` returns null when there is no engine, and the
 * capture flow falls back to typing the amount.
 *
 * That fallback is not a consolation prize: a captured photo with a hand-typed
 * total is a complete, correct transaction. OCR only saves typing.
 */

let cached: OcrEngine | null | undefined;

export async function loadOcrEngine(): Promise<OcrEngine | null> {
  if (cached !== undefined) return cached;

  cached = await tryMlKit();
  return cached;
}

async function tryMlKit(): Promise<OcrEngine | null> {
  try {
    // Resolved at runtime: the module is absent in Expo Go, and a static import
    // would fail the bundle rather than this call.
    const moduleName = '@react-native-ml-kit/text-recognition';
    const mlkit = (await import(/* @vite-ignore */ moduleName)) as {
      default?: { recognize(uri: string): Promise<MlKitResult> };
    };

    const recognizer = mlkit.default;
    if (!recognizer) return null;

    return {
      name: 'mlkit',
      async recognize(imageUri: string): Promise<OcrResult> {
        const started = Date.now();
        const result = await recognizer.recognize(imageUri);

        return {
          engine: 'mlkit',
          durationMs: Date.now() - started,
          lines: result.blocks.flatMap((block) =>
            block.lines.map((line) => ({ text: line.text })),
          ),
        };
      },
    };
  } catch {
    return null;
  }
}

interface MlKitResult {
  readonly blocks: readonly { readonly lines: readonly { readonly text: string }[] }[];
}
