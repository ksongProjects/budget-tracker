import * as FileSystem from 'expo-file-system/legacy';

/**
 * The speech model, fetched when it is first needed and never before.
 *
 * A quantized whisper model is tens of megabytes. Bundling it would put that in
 * every install, including the majority who will never speak a spend — so it is
 * downloaded on the user's first use of voice, kept on the device afterwards,
 * and deletable from the same screen.
 *
 * This is the one download the app makes, and it is worth being exact about
 * what it means: the model comes *to* the device. No audio, no transcript and
 * no ledger data goes anywhere — transcription happens locally once the file is
 * here, which is why voice works in airplane mode after the first time.
 */

const MODELS_DIR = `${FileSystem.documentDirectory ?? ''}models/`;

export interface SpeechModel {
  readonly id: string;
  readonly label: string;
  /** Roughly, for the sentence shown before a user agrees to the download. */
  readonly megabytes: number;
  readonly url: string;
  readonly fileName: string;
}

/**
 * Whisper "base", quantized to 5 bits.
 *
 * Chosen over `tiny` because tiny mishears amounts — "fifty" for "fifteen" is
 * the failure that matters here — and over `small` because small is 180 MB and
 * several seconds per utterance on a mid-range phone. Q5_1 keeps most of base's
 * accuracy at about half its size.
 */
export const DEFAULT_MODEL: SpeechModel = {
  id: 'ggml-base-q5_1',
  label: 'Whisper base (quantized)',
  megabytes: 57,
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
  fileName: 'ggml-base-q5_1.bin',
};

export function modelPath(model: SpeechModel = DEFAULT_MODEL): string {
  return `${MODELS_DIR}${model.fileName}`;
}

export async function isModelPresent(model: SpeechModel = DEFAULT_MODEL): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(modelPath(model));
  // A tiny file is a download that died partway and would fail to load with
  // something unhelpful; treat it as absent so it is fetched again.
  return info.exists && info.size > 1024;
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number;
}

/**
 * Fetch the model.
 *
 * Written to a temporary name and moved into place only when complete, so an
 * interrupted download never leaves a file that looks usable — the same rule
 * the backup archives follow, for the same reason.
 */
export async function downloadModel(
  model: SpeechModel = DEFAULT_MODEL,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  await ensureDir();

  const destination = modelPath(model);
  const partial = `${destination}.partial`;
  await FileSystem.deleteAsync(partial, { idempotent: true });

  const download = FileSystem.createDownloadResumable(
    model.url,
    partial,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      onProgress?.({
        received: totalBytesWritten,
        total: totalBytesExpectedToWrite,
      });
    },
  );

  const result = await download.downloadAsync();
  if (result === undefined) {
    throw new Error('The model download was interrupted.');
  }

  await FileSystem.moveAsync({ from: partial, to: destination });
  return destination;
}

/** Remove the model. Voice stops working until it is fetched again; nothing else changes. */
export async function deleteModel(model: SpeechModel = DEFAULT_MODEL): Promise<void> {
  await FileSystem.deleteAsync(modelPath(model), { idempotent: true });
  await FileSystem.deleteAsync(`${modelPath(model)}.partial`, { idempotent: true });
}

/** How much space the model is taking, or zero when it is not here. */
export async function modelSizeBytes(model: SpeechModel = DEFAULT_MODEL): Promise<number> {
  const info = await FileSystem.getInfoAsync(modelPath(model));
  return info.exists ? info.size : 0;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}
