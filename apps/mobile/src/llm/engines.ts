import { Platform } from 'react-native';
import { createCloudAssist } from '@budget/extract';
import type { Capability, StructuringEngine } from '@budget/extract';
import { readApiKey } from './key';

/**
 * Which engines this particular phone can offer, and why not, when it cannot.
 *
 * Task 9.4: the app degrades by dropping line-item detail, never by refusing to
 * capture. A device with no on-device model still gets Tiers 0–2 through the
 * rules, and the only thing it loses is the breakdown — so the answer to "no
 * model here" is a sentence in a settings screen, not a broken capture.
 *
 * There are no on-device model adapters yet, and this file is where they land:
 * Apple Foundation Models on iOS 26 and Gemini Nano through AICore on Android.
 * Both need hardware this project has not been able to build for or test on
 * (docs/deferred.md), and shipping an adapter that has never run would be worse
 * than shipping an honest empty list — the fixture harness would score it and
 * nobody would know whether the number meant anything.
 */

export interface DeviceModel {
  readonly label: string;
  readonly capability: Capability;
}

/**
 * On-device models available here. Empty on every device today.
 *
 * Deliberately a function rather than a constant: when the adapters land, this
 * is the one place that changes, and the router, the screens and the scoring
 * harness all pick them up without knowing they exist.
 */
export function deviceEngines(): readonly StructuringEngine[] {
  return [];
}

/** What to tell the user about the model on their phone. */
export function deviceModel(): DeviceModel {
  const label = Platform.OS === 'ios' ? 'Apple Foundation Models' : 'Gemini Nano';

  return {
    label,
    capability: {
      availability: 'unsupported',
      reason: `${label} is not wired up in this build, so receipts are read by the rules on this device.`,
    },
  };
}

/**
 * The engines to try for a capture, in order.
 *
 * Cloud Assist is last and, without a key, absent — and even present it is only
 * consulted for a request that carries the user's consent for that exact
 * capture. That check lives in the adapter, not here, so this list can be built
 * eagerly without any risk of it being used.
 */
export async function engineList(): Promise<readonly StructuringEngine[]> {
  const apiKey = await readApiKey();

  return [
    ...deviceEngines(),
    ...(apiKey === undefined
      ? []
      : [createCloudAssist({ apiKey, fetch: (...args) => fetch(...args) })]),
  ];
}
