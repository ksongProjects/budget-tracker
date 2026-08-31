// `whisper.rn/index` rather than `whisper.rn`: the package's export map
// declares `./*` and `./*/` but no `.`, so the bare specifier does not resolve
// under modern resolution. The subpath hits the same entry point.
import { initWhisper } from 'whisper.rn/index';
import type { WhisperContext } from 'whisper.rn/index';
import type { SpeechEngine, SpeechResult } from '@budget/extract';
import { DEFAULT_MODEL, isModelPresent, modelPath } from './model';

/**
 * whisper.cpp on the device.
 *
 * The engine behind voice capture, and the reason a spoken spend never leaves
 * the phone: the model is a local file and the audio is a local file, so
 * transcription in airplane mode is the normal case rather than a feature.
 *
 * The context is expensive to create — it loads tens of megabytes — so it is
 * made once and kept. Released when voice is finished with, because holding
 * that memory for a user who spoke once is rude on a phone.
 */

let context: WhisperContext | undefined;

export const whisperEngine: SpeechEngine = {
  name: 'whisper.rn',

  isReady: () => isModelPresent(),

  async transcribe(audioUri: string): Promise<SpeechResult> {
    const whisper = await load();
    const started = Date.now();

    // Same as the model: whisper.cpp wants a filesystem path, and everything
    // that hands us a file in this app produces a `file://` URL.
    const { promise } = whisper.transcribe(audioUri.replace('file://', ''), {
      // English only: the parser downstream reads English number words, so
      // transcribing to another language would produce text nothing can use.
      language: 'en',
      // A spoken spend is one sentence. Letting whisper hallucinate a
      // continuation past the audio is the classic failure here.
      maxLen: 1,
    });

    const result = await promise;

    return {
      text: result.result.trim(),
      engine: 'whisper.rn',
      durationMs: Date.now() - started,
    };
  },
};

async function load(): Promise<WhisperContext> {
  if (context !== undefined) return context;

  if (!(await isModelPresent())) {
    throw new Error('The speech model has not been downloaded yet.');
  }

  context = await initWhisper({
    // `file://` is what expo-file-system hands out; whisper.rn wants a path.
    filePath: modelPath(DEFAULT_MODEL).replace('file://', ''),
  });

  return context;
}

/** Let the model go. Voice still works; the next use pays to load it again. */
export async function releaseWhisper(): Promise<void> {
  await context?.release();
  context = undefined;
}
