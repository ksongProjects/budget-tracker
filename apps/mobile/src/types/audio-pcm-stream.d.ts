/**
 * The PCM recorder ships its typings under the name of the package it was
 * forked from ("react-native-live-audio-stream"), so importing it by its real
 * name resolves to nothing. This is that declaration, under the right name.
 */
declare module '@fugood/react-native-audio-pcm-stream' {
  export interface AudioStreamOptions {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource?: number;
    wavFile: string;
    bufferSize?: number;
  }

  export interface LiveAudioStream {
    init: (options: AudioStreamOptions) => void;
    start: () => void;
    /** Resolves with the path of the file the library wrote, which we ignore. */
    stop: () => Promise<string>;
    on: (event: 'data', callback: (base64: string) => void) => void;
  }

  const stream: LiveAudioStream;
  export default stream;
}
