import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The Drive stand-in, running for the browser suite.
 *
 * The web connector's own `fetch` adapter is what is under test here, and it
 * only means anything against a real socket — a stubbed transport would be the
 * code checked against itself. The same server the phone is pointed at serves
 * the browser, so both platforms are checked against one implementation of the
 * protocol rather than two guesses at it.
 */

export const FAKE_DRIVE_PORT = 8788;

let server: ChildProcess | undefined;

/**
 * Vitest calls this once for the suite and awaits the function it returns.
 * The teardown has to be the returned value rather than a named export, or the
 * child outlives the run and the process never exits.
 */
export default async function globalSetup(): Promise<() => void> {
  await setup();
  return teardown;
}

export async function setup(): Promise<void> {
  const root = fileURLToPath(new URL('../../..', import.meta.url));

  server = spawn(process.execPath, ['tools/fake-drive.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(FAKE_DRIVE_PORT) },
    stdio: 'ignore',
  });

  // Not counted as a reason to keep the test process alive.
  server.unref();

  await waitForIt();
}

export function teardown(): void {
  server?.kill('SIGKILL');
  server = undefined;
}

async function waitForIt(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // Unauthenticated on purpose: a 401 proves it is listening and is ours.
      const response = await fetch(`http://localhost:${String(FAKE_DRIVE_PORT)}/drive/v3/files`);
      if (response.status === 401) return;
    } catch {
      // Not up yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('the fake Drive did not start');
}
