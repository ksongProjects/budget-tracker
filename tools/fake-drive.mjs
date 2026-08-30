#!/usr/bin/env node
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { FakeDrive } from '../packages/backup/dist/fake-drive.js';

/**
 * The in-memory Drive double, behind a socket.
 *
 * This is how the phone exercises the real upload path — resumable sessions,
 * multi-megabyte chunks, a network that dies mid-transfer — without a Google
 * account, a client id, or anything leaving the machine. It stores archives in
 * memory and forgets them when it stops, which is the point: it is a test
 * double, not somewhere to keep a backup.
 *
 *   pnpm --filter @budget/backup build && node tools/fake-drive.mjs
 *
 * Then start the app with EXPO_PUBLIC_FAKE_DRIVE_URL set to the address it
 * prints. Add --fail-every=N to drop one chunk in every N, which is what the
 * resume path is for.
 */

const port = Number(process.env.PORT ?? 8787);
const failEvery = Number(
  process.argv.find((arg) => arg.startsWith('--fail-every='))?.split('=')[1] ?? '0',
);

const address = lanAddress();
const origin = `http://${address}:${String(port)}`;
const drive = new FakeDrive({ origin });

let chunkCount = 0;

const server = createServer((request, response) => {
  const chunks = [];

  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);

    // A dropped chunk, on a schedule. The connection is closed rather than
    // answered, because that is what a radio losing signal looks like — an
    // error status is the polite version the client already handles.
    if (failEvery > 0 && request.method === 'PUT' && !isProbe(request)) {
      chunkCount += 1;
      if (chunkCount % failEvery === 0) {
        console.log(`  dropping chunk ${String(chunkCount)}`);
        request.destroy();
        return;
      }
    }

    let answer;
    try {
      answer = drive.handle({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: normalise(request.headers),
        body: body.length === 0 ? undefined : new Uint8Array(body),
      });
    } catch (error) {
      answer = {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: String(error) }),
      };
    }

    console.log(`${request.method ?? '?'} ${request.url ?? '?'} → ${String(answer.status)}`);

    response.writeHead(answer.status, answer.headers);
    response.end(answer.body === undefined ? undefined : Buffer.from(answer.body));
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`fake Drive on ${origin}`);
  console.log(`  EXPO_PUBLIC_FAKE_DRIVE_URL=${origin}`);
  // The Android emulator reaches the host through a fixed alias rather than
  // its address, and picking the wrong one of a laptop's several adapters is
  // the usual way this wastes ten minutes.
  console.log(`  on an Android emulator: EXPO_PUBLIC_FAKE_DRIVE_URL=http://10.0.2.2:${String(port)}`);
  if (failEvery > 0) console.log(`  dropping one chunk in every ${String(failEvery)}`);
});

function isProbe(request) {
  const range = request.headers['content-range'];
  return typeof range === 'string' && range.startsWith('bytes */');
}

function normalise(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
}

/** The address an emulator or a phone on the same network can actually reach. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}
