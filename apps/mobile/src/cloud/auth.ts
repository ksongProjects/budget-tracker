import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

/**
 * Signing in to Google Drive, and nothing else.
 *
 * The scope is `drive.appdata` alone: an app-private folder the user cannot see
 * in the Drive UI and cannot share, holding files Google cannot read. The
 * consent screen showing the narrowest possible grant is part of the privacy
 * story, not an implementation detail — never widen this to `drive` or
 * `drive.file` ([drive-connector.md](../../../../docs/drive-connector.md)).
 *
 * Authorization code with PKCE, through the system browser. No client secret
 * exists: a secret shipped inside an app is not a secret, and the flow is built
 * for public clients precisely so one is not needed.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const TOKEN_KEY = 'budget.driveTokens';

/** Refresh this early, so a token does not expire between deciding to upload and uploading. */
const EXPIRY_MARGIN_MS = 60_000;

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

/**
 * The OAuth client id for this build.
 *
 * Read from configuration rather than committed: it is not a secret, but it is
 * per-project, and a hard-coded one silently signs users into someone else's
 * Google Cloud project.
 */
export function clientId(): string | undefined {
  const extra: unknown = Constants.expoConfig?.extra;
  const configured =
    typeof extra === 'object' && extra !== null && 'googleClientId' in extra
      ? (extra as { googleClientId?: unknown }).googleClientId
      : undefined;

  const fromEnv: unknown = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

export function isDriveConfigured(): boolean {
  return clientId() !== undefined;
}

function redirectUri(id: string): string {
  // Google's reverse-DNS scheme for installed apps. Derived from the client id
  // rather than configured separately, because the two must agree exactly and
  // two places to get it wrong is one too many.
  const [bare] = id.split('.apps.googleusercontent.com');
  return `com.googleusercontent.apps.${String(bare)}:/oauthredirect`;
}

/**
 * Run the consent flow. Returns false if the user backed out, which is an
 * answer rather than an error.
 */
export async function signIn(): Promise<boolean> {
  const id = clientId();
  if (id === undefined) {
    throw new DriveAuthError('This build has no Google client id configured.');
  }

  const request = new AuthSession.AuthRequest({
    clientId: id,
    scopes: [SCOPE],
    redirectUri: redirectUri(id),
    usePKCE: true,
    extraParams: {
      // Without these Google returns no refresh token on a repeat consent, and
      // backups would stop working an hour after the user set them up.
      access_type: 'offline',
      prompt: 'consent',
    },
  });

  const result = await request.promptAsync(DISCOVERY);
  if (result.type !== 'success') return false;

  const exchanged = await AuthSession.exchangeCodeAsync(
    {
      clientId: id,
      code: result.params.code ?? '',
      redirectUri: redirectUri(id),
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    DISCOVERY,
  );

  await store({
    accessToken: exchanged.accessToken,
    ...(exchanged.refreshToken === undefined ? {} : { refreshToken: exchanged.refreshToken }),
    expiresAt: expiryOf(exchanged),
  });

  return true;
}

export async function isSignedIn(): Promise<boolean> {
  return (await load()) !== undefined;
}

/**
 * A usable access token, refreshing when it is spent.
 *
 * `refresh` is passed by the connector when Drive rejects a token it was given,
 * which covers the case where the token died between being read and being used.
 */
export async function accessToken(refresh = false): Promise<string> {
  const tokens = await load();
  if (tokens === undefined) {
    throw new DriveAuthError('Not signed in to Google Drive.');
  }

  const stale = Date.now() >= tokens.expiresAt - EXPIRY_MARGIN_MS;
  if (!refresh && !stale) return tokens.accessToken;

  if (tokens.refreshToken === undefined) {
    // Nothing to refresh with. Better to say so than to keep handing over a
    // token that will fail on every call.
    throw new DriveAuthError('Google Drive needs to be connected again.');
  }

  const id = clientId();
  if (id === undefined) throw new DriveAuthError('This build has no Google client id configured.');

  const renewed = await AuthSession.refreshAsync(
    { clientId: id, refreshToken: tokens.refreshToken },
    DISCOVERY,
  );

  await store({
    accessToken: renewed.accessToken,
    // Google does not resend the refresh token; keeping the old one is the
    // difference between staying connected and asking for consent every hour.
    refreshToken: renewed.refreshToken ?? tokens.refreshToken,
    expiresAt: expiryOf(renewed),
  });

  return renewed.accessToken;
}

/**
 * Forget the tokens, and tell Google to forget them too.
 *
 * Revoking is best-effort: if the network is down the local tokens still go,
 * because a user who pressed disconnect has said what they want.
 */
export async function signOut(): Promise<void> {
  const tokens = await load();
  const id = clientId();

  if (tokens !== undefined && id !== undefined) {
    try {
      await AuthSession.revokeAsync(
        { token: tokens.refreshToken ?? tokens.accessToken, clientId: id },
        DISCOVERY,
      );
    } catch {
      // Nothing to do about it, and nothing that should stop the local wipe.
    }
  }

  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

function expiryOf(response: AuthSession.TokenResponse): number {
  const seconds = response.expiresIn ?? 3600;
  return Date.now() + seconds * 1000;
}

async function store(tokens: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
}

async function load(): Promise<StoredTokens | undefined> {
  const stored = await SecureStore.getItemAsync(TOKEN_KEY);
  if (stored === null) return undefined;

  try {
    return JSON.parse(stored) as StoredTokens;
  } catch {
    return undefined;
  }
}
