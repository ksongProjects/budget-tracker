/**
 * Signing in to Google Drive from a browser.
 *
 * Authorization code with PKCE, redirecting through Google and back. No client
 * secret exists — this is a public client, and a secret in a JavaScript bundle
 * is a published secret.
 *
 * **Tokens live in memory only.** Not `localStorage`, not a cookie: a token in
 * storage survives the tab, and anything that can run script on this origin can
 * read it. The cost is signing in again after a reload, which is the right
 * trade for a key to the user's Drive. The verifier is the one exception — it
 * has to survive the redirect, so it goes in `sessionStorage` and is deleted
 * the moment the code is exchanged.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

const VERIFIER_KEY = 'budget.driveVerifier';

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
}

let tokens: Tokens | undefined;

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

export function clientId(): string | undefined {
  const configured: unknown = import.meta.env['VITE_GOOGLE_CLIENT_ID'];
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

export function usingFakeDrive(): boolean {
  if (!import.meta.env.DEV) return false;

  const configured: unknown = import.meta.env['VITE_FAKE_DRIVE_URL'];
  return typeof configured === 'string' && configured.length > 0;
}

export function isDriveConfigured(): boolean {
  return usingFakeDrive() || clientId() !== undefined;
}

export function isSignedIn(): boolean {
  return usingFakeDrive() || tokens !== undefined;
}

/** Where Google sends the user back to. The path, not the hash, so a route change cannot break it. */
export function redirectUri(): string {
  return `${location.origin}${location.pathname}`;
}

/**
 * Start the consent flow by leaving the page.
 *
 * A redirect rather than a popup: popups are blocked by default in most
 * browsers, and a sign-in the user cannot see is a sign-in that does not
 * happen.
 */
export async function signIn(): Promise<void> {
  const id = clientId();
  if (id === undefined) throw new DriveAuthError('This build has no Google client id.');

  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const query = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    // Without these Google returns no refresh token, and the connector would
    // stop working an hour after it started.
    access_type: 'offline',
    prompt: 'consent',
  });

  location.assign(`${AUTHORIZE}?${query.toString()}`);
}

/**
 * Finish the flow if this load is the redirect back.
 *
 * Returns true when a code was exchanged, so the caller knows to re-render. The
 * code is stripped from the URL afterwards: leaving it there means a refresh
 * replays a one-time code, and it ends up in history and in any screenshot.
 */
export async function completeSignIn(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code === null) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState(null, '', redirectUri());

  const id = clientId();
  if (verifier === null || id === undefined) {
    throw new DriveAuthError('That sign-in could not be completed. Try again.');
  }

  tokens = await exchange({
    client_id: id,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });

  return true;
}

/** A usable access token, refreshed when it is spent. */
export async function accessToken(refresh = false): Promise<string> {
  const current = tokens;
  if (current === undefined) throw new DriveAuthError('Not signed in to Google Drive.');

  const stale = Date.now() >= current.expiresAt - 60_000;
  if (!refresh && !stale) return current.accessToken;

  const id = clientId();
  if (current.refreshToken === undefined || id === undefined) {
    tokens = undefined;
    throw new DriveAuthError('Google Drive needs to be connected again.');
  }

  tokens = await exchange({
    client_id: id,
    refresh_token: current.refreshToken,
    grant_type: 'refresh_token',
  });

  return tokens.accessToken;
}

export function signOut(): void {
  tokens = undefined;
}

async function exchange(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    throw new DriveAuthError(`Google refused the sign-in (${String(response.status)}).`);
  }

  const parsed = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: parsed.access_token,
    // Google does not resend the refresh token on a refresh; keeping the one we
    // have is the difference between staying connected and asking for consent
    // every hour.
    ...(parsed.refresh_token === undefined
      ? tokens?.refreshToken === undefined
        ? {}
        : { refreshToken: tokens.refreshToken }
      : { refreshToken: parsed.refresh_token }),
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
}

/** 43–128 characters of unreserved alphabet, per RFC 7636. */
export function randomVerifier(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(64));

  return [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? '-').join('');
}

/** The S256 challenge: base64url of the verifier's SHA-256, unpadded. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
