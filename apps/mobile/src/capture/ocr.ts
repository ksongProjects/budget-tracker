import type { OcrEngine, OcrResult } from '@budget/extract';

/**
 * On-device text recognition, when the native module is present.
 *
 * ML Kit is a native module: it exists in a development build and not in Expo
 * Go. `loadOcrEngine` returns null rather than crashing when it is missing, and
 * the confirm screen falls back to typing the amount.
 *
 * That fallback is not a consolation prize — a photo with a hand-typed total is
 * a complete, correct transaction. OCR only saves typing.
 */

interface MlKitLine {
  readonly text: string;
  readonly frame?: { left: number; top: number; width: number; height: number };
}

interface MlKitBlock {
  readonly lines: readonly MlKitLine[];
}

interface MlKitResult {
  readonly blocks: readonly MlKitBlock[];
}

interface MlKitModule {
  recognize(uri: string): Promise<MlKitResult>;
}

let cached: OcrEngine | null | undefined;

export function loadOcrEngine(): OcrEngine | null {
  if (cached !== undefined) return cached;

  cached = createMlKitEngine();
  return cached;
}

function createMlKitEngine(): OcrEngine | null {
  const recognizer = requireMlKit();
  if (!recognizer) return null;

  return {
    name: 'mlkit',
    async recognize(imageUri: string): Promise<OcrResult> {
      const started = Date.now();
      const result = await recognizer.recognize(imageUri);

      return {
        engine: 'mlkit',
        durationMs: Date.now() - started,
        // ML Kit groups lines into blocks; the heuristics work line by line and
        // do not care about the grouping.
        lines: result.blocks.flatMap((block) =>
          block.lines.map((line) => ({
            text: line.text,
            // ML Kit reports pixel boxes as {left, top}; the rules use
            // {x, y}. Units do not matter to them, only relative positions.
            ...(line.frame
              ? {
                  box: {
                    x: line.frame.left,
                    y: line.frame.top,
                    width: line.frame.width,
                    height: line.frame.height,
                  },
                }
              : {}),
          })),
        ),
      };
    },
  };
}

/**
 * A literal `require` so Metro can resolve it statically, in a try/catch because
 * the native side is absent in Expo Go and touching it throws there.
 */
function requireMlKit(): MlKitModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-ml-kit/text-recognition') as {
      default?: MlKitModule;
    };

    const recognizer = mod.default;
    if (!recognizer || typeof recognizer.recognize !== 'function') return null;

    return recognizer;
  } catch {
    return null;
  }
}
