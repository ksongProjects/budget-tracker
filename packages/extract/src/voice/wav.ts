/**
 * Wrapping raw PCM in a WAV container.
 *
 * The speech engine reads one format and one only: 16-bit PCM in a WAV
 * container. Phone recorders hand back m4a, 3gp or webm, and the recorder that
 * does give raw PCM (see the mobile app's voice recorder) gives it with no
 * header at all — so somebody has to write the 44 bytes in front.
 *
 * It lives here, in a package that runs in Node, because a header is exactly
 * the kind of thing that is wrong by two bytes and only says so on a device
 * ten minutes later. The device found that once already: a recording with an
 * 18-byte `fmt ` chunk and a reader that wanted 16.
 */

export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

/** What a spoken spend is captured at: enough for speech, small enough to hold in memory. */
export const SPEECH_PCM: PcmFormat = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
};

const HEADER_BYTES = 44;

/**
 * A canonical WAV: `RIFF`/`WAVE`, a 16-byte `fmt ` chunk declaring PCM, then
 * `data`. No `LIST`, no padding, no extension field — readers disagree about
 * those, and there is nothing here worth disagreeing over.
 */
export function encodeWav(pcm: Uint8Array, format: PcmFormat = SPEECH_PCM): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = format;

  if (sampleRate <= 0 || channels <= 0) {
    throw new Error('A WAV needs a positive sample rate and channel count.');
  }
  if (bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM is supported.');
  }

  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);

  ascii(out, 0, 'RIFF');
  // Everything after this field: the eight bytes of "WAVE" plus the two chunk
  // headers, plus the samples.
  view.setUint32(4, 36 + pcm.length, true);
  ascii(out, 8, 'WAVE');

  ascii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM, uncompressed.
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  ascii(out, 36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, HEADER_BYTES);

  return out;
}

/** How long a run of PCM lasts, for the "that was too short to be a sentence" case. */
export function pcmDurationMs(byteLength: number, format: PcmFormat = SPEECH_PCM): number {
  const bytesPerSecond = (format.sampleRate * format.channels * format.bitsPerSample) / 8;
  return bytesPerSecond === 0 ? 0 : (byteLength / bytesPerSecond) * 1000;
}

export interface WavHeader extends PcmFormat {
  readonly dataOffset: number;
  readonly dataSize: number;
}

/**
 * Read back what `encodeWav` writes.
 *
 * Only exists so the encoder can be checked against a reader rather than
 * against a copy of its own arithmetic.
 */
export function readWavHeader(bytes: Uint8Array): WavHeader {
  if (bytes.length < HEADER_BYTES) throw new Error('Too short to be a WAV.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV.');
  }
  if (readAscii(bytes, 12, 4) !== 'fmt ' || view.getUint32(16, true) !== 16) {
    throw new Error('Not a canonical fmt chunk.');
  }
  if (readAscii(bytes, 36, 4) !== 'data') {
    throw new Error('Not a canonical data chunk.');
  }

  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataOffset: HEADER_BYTES,
    dataSize: view.getUint32(40, true),
  };
}

function ascii(out: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    out[offset + index] = value.charCodeAt(index);
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}
