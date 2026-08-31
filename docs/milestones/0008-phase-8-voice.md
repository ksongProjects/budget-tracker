# Milestone report — Phase 8: voice capture

**Dates**: 2026-08-30
**Phase goal**: say what you spent and have the phone read it, on device.
**Outcome**: shipped-with-deviations — both tasks are built, tested and run on
hardware; accuracy from a real microphone is unproven because the emulator has
none.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 8.1 whisper.rn integration, quantized model, on-demand only | done | a known 16 kHz WAV transcribes on the emulator as "12 bucks on coffee at BlueBottle" in 10.7 s; the model is fetched on first use and deletable from the screen |
| 8.2 Transcript → rules fallback for the fixture utterance set | done | 12 fixture utterances, 21 parser tests; the set is the acceptance spec |

## Test evidence

530 node tests and 64 browser tests at phase close, up from 491 — the parser,
its fixture set, and the WAV encoder.

The device runs are the ones that matter here, because everything Phase 8 adds
sits on a native seam:

- **Transcription**: a WAV pushed to the device, transcribed by the real model,
  parsed to 1200 minor units USD at BlueBottle. Words come back and the parser
  reads them.
- **Capture**: three seconds from the microphone, written as a WAV, read back
  at 16 kHz mono 16-bit, accepted by the engine, and deleted afterwards. The
  transcript was "[Music]" — what whisper says about a room with no speech in
  it, which is all an emulator microphone can offer.

## Deviations from plan

**The model is `base`, not `small`.** The plan says small; small is 180 MB and
several seconds per utterance on a mid-range phone. Base quantized to 5 bits is
57 MB and keeps the accuracy that matters — `tiny` was ruled out because it
mishears "fifteen" as "fifty", which is the one error class this feature cannot
afford.

**Recording is not expo-audio.** On Android expo-audio writes m4a or 3gp;
whisper.cpp reads 16-bit PCM WAV and nothing else, and rejects everything else
as "Invalid WAV file". The microphone is read as raw PCM through
`@fugood/react-native-audio-pcm-stream` and the container is written by
`@budget/extract`, where it is tested in CI rather than discovered on a device.

## What this cannot do

- **Prove it hears people.** No physical device has run this. The emulator's
  microphone is silence, so what is proven is the pipeline, not the accuracy.
- **Read a sentence with no number in it.** No amount means no fields and a
  prompt to try again — never a zero, which would import as a real transaction.
- **Speak in another language.** Transcription is pinned to English because the
  parser downstream reads English number words; another language would produce
  text nothing can use.
- **Anything without the model.** First use needs a network for one 57 MB
  download. After that, airplane mode is the normal case.

## Risks carried forward

- **Accuracy is unmeasured.** Ten seconds for six seconds of audio on an x86
  emulator says little about a phone, and the word error rate on real speech in
  a real room is unknown. A physical-device run is the first thing to do.
- **`whisper.rn` resolves only as `whisper.rn/index`.** Its export map has no
  "." entry, so the bare specifier fails under modern resolution and a
  tsconfig path points TypeScript at the shipped declarations. An upstream fix
  changes both.
- **The PCM recorder is an old-architecture native module.** It works through
  the interop layer today; a future React Native release that drops that layer
  would take voice capture with it.
- **A spoken merchant loses its capitalisation and its branch number.** The
  parser stops the merchant phrase at the first number, which is right when the
  amount follows the name and wrong for "at Safeway 0421".

## Next

Phase 9 routes the same transcript through an on-device LLM. The rules parser
stays as the floor underneath it — a model that is missing, slow or wrong still
has to leave the user with something.
