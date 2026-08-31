import { describe, expect, it } from 'vitest';
import { SPEECH_PCM, encodeWav, pcmDurationMs, readWavHeader } from './wav.js';

/** A second of a quiet tone, as 16-bit little-endian samples. */
function tone(seconds: number): Uint8Array {
  const samples = SPEECH_PCM.sampleRate * seconds;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((index / SPEECH_PCM.sampleRate) * 440 * 2 * Math.PI) * 8000;
    view.setInt16(index * 2, Math.trunc(value), true);
  }

  return pcm;
}

describe('encodeWav', () => {
  it('writes a header the reader agrees with', () => {
    const pcm = tone(1);
    const header = readWavHeader(encodeWav(pcm));

    expect(header).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataSize: pcm.length,
    });
  });

  it('declares the fmt chunk as exactly 16 bytes', () => {
    // The device rejected an 18-byte fmt chunk — the WAVEFORMATEX shape some
    // recorders emit. This is the byte that failure came down to.
    const wav = encodeWav(tone(0.1));
    expect(new DataView(wav.buffer).getUint32(16, true)).toBe(16);
  });

  it('sizes RIFF as everything after the size field', () => {
    const pcm = tone(0.5);
    const wav = encodeWav(pcm);

    expect(new DataView(wav.buffer).getUint32(4, true)).toBe(wav.length - 8);
    expect(new DataView(wav.buffer).getUint32(4, true)).toBe(36 + pcm.length);
  });

  it('keeps the samples byte for byte', () => {
    const pcm = tone(0.25);
    const wav = encodeWav(pcm);

    expect(wav.slice(44)).toEqual(pcm);
  });

  it('carries a non-default format through', () => {
    const wav = encodeWav(new Uint8Array(8), {
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
    });
    const header = readWavHeader(wav);

    expect(header.sampleRate).toBe(44_100);
    expect(header.channels).toBe(2);
    // Byte rate and block align follow the channel count, not the default.
    expect(new DataView(wav.buffer).getUint32(28, true)).toBe(44_100 * 4);
    expect(new DataView(wav.buffer).getUint16(32, true)).toBe(4);
  });

  it('refuses a bit depth the engine cannot read', () => {
    expect(() =>
      encodeWav(new Uint8Array(4), { sampleRate: 16_000, channels: 1, bitsPerSample: 8 }),
    ).toThrow(/16-bit/);
  });

  it('encodes an empty recording rather than a broken file', () => {
    const header = readWavHeader(encodeWav(new Uint8Array(0)));
    expect(header.dataSize).toBe(0);
  });
});

describe('pcmDurationMs', () => {
  it('reads a second of speech PCM as a second', () => {
    expect(pcmDurationMs(16_000 * 2)).toBe(1000);
  });

  it('is what tells a tap apart from a sentence', () => {
    expect(pcmDurationMs(1_600)).toBeLessThan(100);
  });
});
