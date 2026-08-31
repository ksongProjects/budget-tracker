import { readModelOutput } from './read.js';
import type {
  Capability,
  StructuredCandidate,
  StructuringEngine,
  StructuringRequest,
} from './types.js';

/**
 * Engines that stand in for the real ones.
 *
 * Apple Foundation Models needs an iPhone, Gemini Nano needs a recent Pixel,
 * and CI has neither — so the seam gets a double that goes through the *same*
 * validation as a real adapter: a script produces the raw text a model would
 * emit, and `readModelOutput` decides what survives. A double that returned
 * ready-made candidates would test nothing, because the interesting failures
 * are all in what a model writes.
 *
 * The scripts belong to the tests. What lives here is the machinery, so a
 * diagnostics screen can score the real engine with the same harness.
 */

export interface ScriptedEngineOptions {
  readonly name: string;
  /** What the model writes back, prose, fences and all. */
  readonly respond: (request: StructuringRequest) => string;
  readonly remote?: boolean;
  readonly capability?: Capability;
  /** Reported as the engine's duration, so scoring can compare speeds. */
  readonly durationMs?: number;
}

export function createScriptedEngine(options: ScriptedEngineOptions): StructuringEngine {
  return {
    name: options.name,
    remote: options.remote ?? false,

    capability(): Promise<Capability> {
      return Promise.resolve(options.capability ?? { availability: 'ready' });
    },

    structure(request: StructuringRequest): Promise<StructuredCandidate> {
      return Promise.resolve(
        readModelOutput(options.respond(request), request, {
          engine: options.name,
          durationMs: options.durationMs ?? 0,
        }),
      );
    },
  };
}

/** A device that will never have a model, for testing the path most phones take. */
export function createUnavailableEngine(name: string, reason: string): StructuringEngine {
  return {
    name,
    remote: false,
    capability: () => Promise.resolve({ availability: 'unsupported', reason }),
    structure: () =>
      Promise.reject(new Error(`${name} is not available on this device: ${reason}`)),
  };
}
