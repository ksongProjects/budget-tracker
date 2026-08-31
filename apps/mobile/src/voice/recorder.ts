import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { SPEECH_PCM, encodeWav, pcmDurationMs } from '@budget/extract';

/**
 * Capturing a spoken spend as raw PCM.
 *
 * Not expo-audio, which the rest of the app would reach for first: on Android
 * it can only write m4a or 3gp, and the speech engine reads 16-bit PCM WAV and
 * nothing else. Handing it an m4a fails as "Invalid WAV file", which sounds
 * like a broken file rather than the wrong format.
 *
 * So the microphone is read directly, at the rate whisper wants — 16 kHz mono,
 * which is also a sixth of the bytes CD-quality stereo would cost for audio
 * nobody is going to listen to.
 */

/** A spoken spend is a sentence. Past this, stop growing the buffer. */
const MAX_SECONDS = 60;
const MAX_BYTES = ((SPEECH_PCM.sampleRate * SPEECH_PCM.bitsPerSample) / 8) * MAX_SECONDS;

/** Shorter than this is a mis-tap, not a sentence. */
const MIN_MS = 400;

/**
 * `VOICE_RECOGNITION` rather than the default microphone: Android applies
 * noise suppression tuned for speech and skips the AGC ramp that eats the
 * first syllable — and the first syllable here is usually the number.
 */
const VOICE_RECOGNITION = 6;

export interface Recording {
  readonly uri: string;
  readonly durationMs: number;
}

let chunks: Uint8Array[] = [];
let captured = 0;
let listening = false;
let recording = false;

export function isRecording(): boolean {
  return recording;
}

export function startRecording(): void {
  if (recording) return;

  chunks = [];
  captured = 0;

  LiveAudioStream.init({
    sampleRate: SPEECH_PCM.sampleRate,
    channels: SPEECH_PCM.channels,
    bitsPerSample: SPEECH_PCM.bitsPerSample,
    audioSource: VOICE_RECOGNITION,
    // Named by the library, unused here: the file it would write is the one
    // format we cannot use. The WAV is assembled at stop instead.
    wavFile: 'unused.wav',
    bufferSize: 4096,
  });

  // Subscribed once for the life of the process. The library replaces its own
  // listener on every `on`, and re-subscribing per recording was how a stopped
  // recording kept appending to the next one.
  if (!listening) {
    LiveAudioStream.on('data', (base64: string) => {
      if (!recording || captured >= MAX_BYTES) return;
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      chunks.push(bytes);
      captured += bytes.length;
    });
    listening = true;
  }

  recording = true;
  LiveAudioStream.start();
}

/**
 * Stop, and write what was heard as a WAV the engine can read.
 *
 * The file goes in the app's own documents directory, not shared storage:
 * `/sdcard` needs a permission this app has no reason to hold, and a denied
 * read arrives at the engine as an empty buffer.
 */
export async function stopRecording(): Promise<Recording> {
  if (!recording) throw new Error('Nothing was being recorded.');

  recording = false;
  await LiveAudioStream.stop();

  const pcm = concat(chunks, captured);
  chunks = [];

  const durationMs = pcmDurationMs(pcm.length);
  if (durationMs < MIN_MS) {
    throw new Error('That was too short to hear. Hold the button while you speak.');
  }

  const uri = `${FileSystem.documentDirectory ?? ''}voice-capture.wav`;
  const wav = encodeWav(pcm);

  await FileSystem.writeAsStringAsync(uri, Buffer.from(wav).toString('base64'), {
    encoding: FileSystem.EncodingType.Base64,
  });

  return { uri, durationMs };
}

/** Throw away a capture once it has been read. Audio is the most personal thing here. */
export async function discardRecording(recorded: Recording): Promise<void> {
  await FileSystem.deleteAsync(recorded.uri, { idempotent: true });
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}
