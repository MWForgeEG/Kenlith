'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');
const { readTextIfExists, sleep, writeFileAtomic } = require('./fsutil');
const { LockTimeoutError, acquireLock } = require('./lock');
const {
  RequestError,
  fetchJson,
  normalizeEpoch,
  parseJwt,
  pkceChallenge,
  randomToken
} = require('./util');

const AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const DISCOVERY_ENDPOINT = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const ISSUER = 'https://auth.openai.com';
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct'
].join(' ');

const INFERENCE_SCOPE = 'chatgpt.tokens.use.direct';
const REFRESH_MARGIN_MS = 90_000;

// Refresh errors that mean the refresh token can never work again
// (OpenAI "Errors and recovery"). Anything else keeps the stored credentials.
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
]);

const CREDENTIALS_KEY = 'planChat.credentials.v1';
const HOST_ID_KEY = 'planChat.hostId.v1';
const REGISTRATION_KEY = 'planChat.registration.v1';

// Cross-window coordination (all windows of a profile share globalStorage and
// SecretStorage, but each runs in its own process):
// - session.lock serializes refresh, sign-in and sign-out across processes.
// - session-state.json holds no secrets, only { generation, signedOut }. Every
//   credential record carries the generation it was written with, so a window
//   whose SecretStorage read is older than the journal knows it is looking at
//   a stale copy and must not refresh with that (already rotated) token.
const SESSION_LOCK_FILE = 'session.lock';
const SESSION_STATE_FILE = 'session-state.json';

class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
    this.reauthRequired = true;
  }
}

// Coordination with another window could not be confirmed. Nothing was
// changed; the user can simply try again.
class SessionSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionSyncError';
    this.code = 'SESSION_SYNC';
  }
}

class AuthService {
  constructor(context) {
    this.context = context;
    this.refreshPromise = undefined;
    this.discovery = undefined;
    // Bumped on sign-in and sign-out so a refresh that started earlier
    // cannot write its tokens over the newer state.
    this.sessionEpoch = 0;
    this.signingOut = false;
    this.revocationRetryDelaysMs = [500, 2000];
    this.sessionLockOptions = { timeoutMs: 45_000, staleMs: 20_000 };
    this.visibilityTimeoutMs = 5_000;
    this.visibilityPollMs = 100;
  }

  async getSession() {
    const credentials = await this.#readCredentials();
    if (!credentials || (await this.#signedOutElsewhere(credentials))) {
      return undefined;
    }

    return {
      email: credentials.email,
      name: credentials.name,
      subject: credentials.subject,
      scopes: credentials.scopes,
      expiresAt: credentials.expiresAt
    };
  }

  async getAccessToken() {
    if (this.signingOut) {
      throw new ReauthRequiredError('Signing out of ChatGPT.');
    }

    let credentials = await this.#readCredentials();
    if (!credentials) {
      throw new ReauthRequiredError('Sign in with ChatGPT before sending a message.');
    }
    if (await this.#signedOutElsewhere(credentials)) {
      throw new ReauthRequiredError('You signed out of ChatGPT in another Kenlith window. Sign in again to continue.');
    }

    if (credentials.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.#refresh().finally(() => {
          this.refreshPromise = undefined;
        });
      }

      try {
        credentials = await this.refreshPromise;
      } catch (error) {
        if (isNetworkError(error)) {
          throw new Error('Could not reach OpenAI to renew the ChatGPT session. Your sign-in was kept; check your connection and try again.');
        }
        throw error;
      }
    }

    if (!credentials.scopes?.includes(INFERENCE_SCOPE)) {
      throw new ReauthRequiredError('ChatGPT plan usage is not authorized for this session. Sign in again and approve ChatGPT plan usage.');
    }
    return credentials.accessToken;
  }

  async signIn() {
    const previous = await this.#readCredentials();
    const registration = this.context.globalState.get(REGISTRATION_KEY);
    const hostId = await this.#getOrCreateHostId();
    const clientId = registration?.clientId || 'dynamic_agent_client';
    const isRegistration = clientId === 'dynamic_agent_client';
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(64);
    const challenge = pkceChallenge(verifier);

    const callback = await createLoopbackCallback(state);
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    authorizationUrl.searchParams.set('client_id', clientId);
    authorizationUrl.searchParams.set('ext_agent_host_id', hostId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', callback.redirectUri);
    authorizationUrl.searchParams.set('scope', SCOPES);
    authorizationUrl.searchParams.set('resource', RESOURCE);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('code_challenge', challenge);

    if (isRegistration) {
      authorizationUrl.searchParams.set('agent_name_hint', 'Kenlith');
    } else {
      if (previous?.idToken) {
        authorizationUrl.searchParams.set('id_token_hint', previous.idToken);
      }
      if (previous?.email) {
        authorizationUrl.searchParams.set('login_hint', previous.email);
      }
    }

    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl.toString()));
      if (!opened) {
        throw new Error('The editor could not open the system browser.');
      }

      const result = await callback.waitForResult();
      const issuedClientId = result.clientId || (isRegistration ? undefined : clientId);
      if (!issuedClientId) {
        throw new Error('OpenAI did not return the issued OAuth client ID.');
      }
      if (!isRegistration && issuedClientId !== clientId) {
        throw new Error('OpenAI returned a different client ID during reauthorization.');
      }

      const tokens = await this.#exchangeCode({
        clientId: issuedClientId,
        code: result.code,
        verifier,
        redirectUri: callback.redirectUri
      });

      const identity = await this.#validateIdToken(tokens.id_token, issuedClientId, nonce);
      if (!isRegistration && previous?.subject && identity.subject !== previous.subject) {
        throw new Error('OpenAI signed in a different account than the one linked to Kenlith. Sign out first to switch accounts.');
      }
      const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
      if (!scopes.includes(INFERENCE_SCOPE)) {
        throw new Error('ChatGPT plan usage was not authorized for this account.');
      }

      const credentials = credentialsFromTokenResponse(tokens, {
        clientId: issuedClientId,
        hostId,
        identity,
        fallbackRefreshToken: undefined
      });

      await this.#withSessionLock('Another Kenlith window is updating the ChatGPT session. Try signing in again in a moment.', async () => {
        const journal = await this.#readJournal();
        credentials.generation = Math.max(journal.generation, effectiveGeneration(previous, journal)) + 1;
        this.sessionEpoch += 1;
        await this.#storeCredentials(credentials);
        await this.#writeJournal({ generation: credentials.generation, signedOut: false });
      });
      await this.context.globalState.update(REGISTRATION_KEY, {
        clientId: issuedClientId
      });

      return this.getSession();
    } finally {
      callback.close();
    }
  }

  async signOut() {
    this.signingOut = true;
    try {
      // Let an in-flight refresh finish so the token we revoke is the latest one.
      await this.refreshPromise?.catch(() => undefined);
      this.sessionEpoch += 1;

      // Wait for a refresh running in another window, so the token revoked is
      // the newest one. A stuck window must not block signing out, so on
      // timeout continue without the lock; the journal still records it.
      const lock = await this.#acquireSessionLock('').catch(() => undefined);
      try {
        let credentials;
        try {
          ({ credentials } = await this.#readConsistent());
        } catch {
          credentials = await this.#readCredentials().catch(() => undefined);
        }

        let remoteRevoked = true;
        if (credentials?.refreshToken) {
          remoteRevoked = await this.#revoke(credentials);
        }

        await this.#endSession(await this.#readJournal(), credentials);
        return { remoteRevoked };
      } finally {
        await lock?.release();
      }
    } finally {
      this.signingOut = false;
    }
  }

  async #revoke(credentials) {
    // Retry network failures and 5xx with backoff, as OpenAI's sign-out guidance asks.
    for (const delay of [0, ...this.revocationRetryDelaysMs]) {
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const discovery = await this.#getDiscovery();
        if (!discovery.revocation_endpoint) {
          return false;
        }
        const response = await fetch(discovery.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: credentials.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: credentials.clientId
          }),
          signal: AbortSignal.timeout(15_000)
        });
        if (response.ok) {
          return true;
        }
        if (response.status < 500) {
          return false;
        }
      } catch {
        // Network failure: retry.
      }
    }
    return false;
  }

  async #exchangeCode({ clientId, code, verifier, redirectUri }) {
    return fetchJson(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE
      })
    });
  }

  async #refresh() {
    const lock = await this.#acquireSessionLock('Another Kenlith window is renewing the ChatGPT session. Try again in a moment.');
    try {
      return await this.#refreshLocked();
    } finally {
      await lock.release();
    }
  }

  async #refreshLocked() {
    // Re-read under the cross-process lock: another caller or window may
    // already have rotated the refresh token.
    const { journal, credentials } = await this.#readConsistent();
    if (!credentials) {
      throw new ReauthRequiredError('The ChatGPT session has ended. Sign in again.');
    }
    if (credentials.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return credentials;
    }
    if (!credentials.refreshToken) {
      throw new ReauthRequiredError('The ChatGPT session cannot be refreshed. Sign in again.');
    }

    const earliestRefreshAt = normalizeEpoch(credentials.earliestRefreshAt);
    if (earliestRefreshAt && Date.now() < earliestRefreshAt && credentials.expiresAt > Date.now()) {
      return credentials;
    }

    const epoch = this.sessionEpoch;
    let tokens;
    try {
      tokens = await fetchJson(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credentials.clientId,
          refresh_token: credentials.refreshToken,
          resource: RESOURCE
        })
      });
    } catch (error) {
      if (!(error instanceof RequestError) || !TERMINAL_REFRESH_ERRORS.has(error.code)) {
        throw error;
      }
      const latest = await this.#readCredentials();
      if (latest?.refreshToken && latest.refreshToken !== credentials.refreshToken) {
        return latest;
      }
      if (this.sessionEpoch === epoch) {
        await this.#endSession(journal, credentials);
      }
      throw new ReauthRequiredError('Your ChatGPT session is no longer valid. Sign in again.');
    }

    let identity = {
      email: credentials.email,
      name: credentials.name,
      subject: credentials.subject
    };

    if (tokens.id_token) {
      identity = await this.#validateIdToken(tokens.id_token, credentials.clientId);
      if (credentials.subject && identity.subject !== credentials.subject) {
        throw new Error('OpenAI returned tokens for a different account. Sign out and sign in again.');
      }
    }

    if (this.sessionEpoch !== epoch) {
      throw new ReauthRequiredError('The ChatGPT session changed while it was being renewed.');
    }
    if ((await this.#readJournal()).generation > journal.generation) {
      // Only possible if a sign-out could not take the lock and went ahead.
      throw new SessionSyncError('The ChatGPT session changed in another Kenlith window. Try again.');
    }

    const refreshed = credentialsFromTokenResponse(tokens, {
      clientId: credentials.clientId,
      hostId: credentials.hostId,
      identity,
      fallbackRefreshToken: credentials.refreshToken,
      fallbackIdToken: credentials.idToken,
      fallbackScopes: credentials.scopes
    });
    refreshed.generation = Math.max(journal.generation, effectiveGeneration(credentials, journal)) + 1;

    await this.#storeCredentials(refreshed);
    await this.#writeJournal({ generation: refreshed.generation, signedOut: false });
    return refreshed;
  }

  // Reads the credential record and makes sure it is not older than the
  // journal. SecretStorage writes from another window can become visible here
  // after a delay; until they do, wait rather than act on a stale token.
  async #readConsistent() {
    const journal = await this.#readJournal();
    const deadline = Date.now() + this.visibilityTimeoutMs;
    for (;;) {
      const credentials = await this.#readCredentials();
      const generation = effectiveGeneration(credentials, journal);
      if (journal.signedOut && journal.generation >= generation) {
        return { journal, credentials: undefined };
      }
      if (generation >= journal.generation) {
        return { journal, credentials };
      }
      if (Date.now() >= deadline) {
        if (!credentials) {
          return { journal, credentials: undefined };
        }
        throw new SessionSyncError('Kenlith could not yet read the ChatGPT session saved by another window. Try again in a moment.');
      }
      await sleep(this.visibilityPollMs);
    }
  }

  async #signedOutElsewhere(credentials) {
    const journal = await this.#readJournal();
    return journal.signedOut && journal.generation >= effectiveGeneration(credentials, journal);
  }

  // The journal is written first, so even if the process stops before the
  // secret is deleted, every window already treats the session as ended.
  async #endSession(journal, credentials) {
    await this.#writeJournal({
      generation: Math.max(journal.generation, effectiveGeneration(credentials, journal)) + 1,
      signedOut: true
    });
    await this.context.secrets.delete(CREDENTIALS_KEY);
  }

  async #storeCredentials(record) {
    const serialized = JSON.stringify(record);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.context.secrets.store(CREDENTIALS_KEY, serialized);
        const deadline = Date.now() + this.visibilityTimeoutMs;
        for (;;) {
          if ((await this.context.secrets.get(CREDENTIALS_KEY)) === serialized) {
            return;
          }
          if (Date.now() >= deadline) {
            break;
          }
          await sleep(this.visibilityPollMs);
        }
      } catch {
        // Retry below; the error text is not surfaced because it is not ours.
      }
    }
    throw new SessionSyncError('Kenlith could not save the ChatGPT session to secure storage. Try again; if this keeps happening, sign in again.');
  }

  #sessionPath(name) {
    return path.join(this.context.globalStorageUri.fsPath, name);
  }

  async #readJournal() {
    let parsed;
    try {
      parsed = JSON.parse((await readTextIfExists(this.#sessionPath(SESSION_STATE_FILE))) || '{}');
    } catch {
      parsed = {};
    }
    const generation = Number.isSafeInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0;
    const updatedAt = Date.parse(parsed.updatedAt);
    return { generation, signedOut: parsed.signedOut === true, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 };
  }

  async #writeJournal({ generation, signedOut }) {
    await fs.promises.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    await writeFileAtomic(this.#sessionPath(SESSION_STATE_FILE), JSON.stringify({
      version: 1,
      generation,
      signedOut,
      updatedAt: new Date().toISOString()
    }));
  }

  async #acquireSessionLock(timeoutMessage) {
    await fs.promises.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    try {
      return await acquireLock(this.#sessionPath(SESSION_LOCK_FILE), this.sessionLockOptions);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        throw new SessionSyncError(timeoutMessage);
      }
      throw error;
    }
  }

  async #withSessionLock(timeoutMessage, operation) {
    const lock = await this.#acquireSessionLock(timeoutMessage);
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  async #validateIdToken(token, clientId, expectedNonce) {
    if (!token) {
      throw new Error('OpenAI did not return an identity token.');
    }

    const jwt = parseJwt(token);
    if (!jwt.header.kid) {
      throw new Error('The OpenAI identity token has no signing-key ID.');
    }

    const discovery = await this.#getDiscovery();
    const jwks = await fetchJson(discovery.jwks_uri);
    const jwk = jwks.keys?.find((candidate) => candidate.kid === jwt.header.kid);
    if (!jwk) {
      throw new Error('The OpenAI identity token signing key was not found.');
    }

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = verifyJwtSignature(jwt, publicKey);
    if (!verified) {
      throw new Error('The OpenAI identity token signature is invalid.');
    }

    const now = Math.floor(Date.now() / 1000);
    const tolerance = 60;
    const audiences = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];

    if (jwt.payload.iss !== (discovery.issuer || ISSUER)) {
      throw new Error('The OpenAI identity token issuer is invalid.');
    }
    if (!audiences.includes(clientId)) {
      throw new Error('The OpenAI identity token audience is invalid.');
    }
    if (!jwt.payload.exp || jwt.payload.exp < now - tolerance) {
      throw new Error('The OpenAI identity token has expired.');
    }
    if (jwt.payload.nbf && jwt.payload.nbf > now + tolerance) {
      throw new Error('The OpenAI identity token is not valid yet.');
    }
    if (expectedNonce && jwt.payload.nonce !== expectedNonce) {
      throw new Error('The OpenAI identity token nonce is invalid.');
    }
    if (!jwt.payload.sub) {
      throw new Error('The OpenAI identity token has no account subject.');
    }

    return {
      email: typeof jwt.payload.email === 'string' ? jwt.payload.email : undefined,
      name: typeof jwt.payload.name === 'string' ? jwt.payload.name : undefined,
      subject: jwt.payload.sub
    };
  }

  async #getDiscovery() {
    if (!this.discovery) {
      this.discovery = await fetchJson(DISCOVERY_ENDPOINT);
      if (this.discovery.issuer !== ISSUER || !this.discovery.jwks_uri) {
        this.discovery = undefined;
        throw new Error('OpenAI returned unexpected OAuth discovery metadata.');
      }
    }
    return this.discovery;
  }

  async #getOrCreateHostId() {
    let hostId = this.context.globalState.get(HOST_ID_KEY);
    if (!hostId) {
      hostId = `urn:uuid:${crypto.randomUUID()}`;
      await this.context.globalState.update(HOST_ID_KEY, hostId);
    }
    return hostId;
  }

  async #readCredentials() {
    const raw = await this.context.secrets.get(CREDENTIALS_KEY);
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw);
    } catch {
      await this.context.secrets.delete(CREDENTIALS_KEY);
      throw new Error('Stored ChatGPT credentials were invalid and have been cleared.');
    }
  }
}

// Generation of a credential record relative to the journal. Records written
// by 0.1.0/0.1.1 have none: one saved after the journal's last update (for
// example after rolling back and signing in again) is newer than everything
// the journal knows; an older one is treated as generation 0, i.e. stale.
function effectiveGeneration(credentials, journal) {
  if (!credentials) {
    return 0;
  }
  if (Number.isSafeInteger(credentials.generation)) {
    return credentials.generation;
  }
  const savedAt = Date.parse(credentials.savedAt);
  return Number.isFinite(savedAt) && savedAt > journal.updatedAt ? journal.generation + 1 : 0;
}

function isNetworkError(error) {
  return error instanceof TypeError
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError';
}

function credentialsFromTokenResponse(tokens, options) {
  const now = Date.now();
  const expiresIn = Number(tokens.expires_in || 3600);
  const scopes = String(tokens.scope || options.fallbackScopes?.join(' ') || '')
    .split(/\s+/)
    .filter(Boolean);

  return {
    email: options.identity.email,
    name: options.identity.name,
    subject: options.identity.subject,
    clientId: options.clientId,
    hostId: options.hostId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || options.fallbackRefreshToken,
    idToken: tokens.id_token || options.fallbackIdToken,
    tokenType: tokens.token_type || 'Bearer',
    scopes,
    expiresAt: now + Math.max(1, expiresIn) * 1000,
    earliestRefreshAt: tokens.earliest_refresh_at,
    savedAt: new Date(now).toISOString()
  };
}

function verifyJwtSignature(jwt, publicKey) {
  switch (jwt.header.alg) {
    case 'RS256':
      return crypto.verify('RSA-SHA256', jwt.signingInput, publicKey, jwt.signature);
    case 'PS256':
      return crypto.verify('RSA-SHA256', jwt.signingInput, {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32
      }, jwt.signature);
    case 'ES256':
      return crypto.verify('sha256', jwt.signingInput, {
        key: publicKey,
        dsaEncoding: 'ieee-p1363'
      }, jwt.signature);
    default:
      throw new Error(`Unsupported OpenAI identity-token algorithm: ${jwt.header.alg || 'unknown'}`);
  }
}

async function createLoopbackCallback(expectedState) {
  let settled = false;
  let resolveResult;
  let rejectResult;

  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const clientId = url.searchParams.get('client_id') || undefined;

      if (state !== expectedState) {
        throw new Error('OAuth state validation failed.');
      }
      if (error) {
        throw new Error(url.searchParams.get('error_description') || `OpenAI sign-in failed: ${error}`);
      }
      if (!code) {
        throw new Error('OpenAI did not return an authorization code.');
      }

      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      response.end('<!doctype html><meta charset="utf-8"><title>Kenlith</title><style>body{font:16px system-ui;margin:4rem;max-width:42rem}h1{font-size:1.5rem}</style><h1>Sign-in complete</h1><p>You can close this tab and return to your editor.</p>');

      settled = true;
      resolveResult({ code, clientId });
    } catch (error) {
      response.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end('Sign-in could not be completed. Return to your editor for details.');
      settled = true;
      rejectResult(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local OAuth callback server.');
  }

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(new Error('ChatGPT sign-in timed out. Please try again.'));
      server.close();
    }
  }, 5 * 60 * 1000);

  return {
    redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
    waitForResult: () => resultPromise,
    close: () => {
      clearTimeout(timeout);
      if (server.listening) {
        server.close();
      }
    }
  };
}

module.exports = {
  AuthService,
  CREDENTIALS_KEY,
  ReauthRequiredError,
  SessionSyncError,
  createLoopbackCallback,
  verifyJwtSignature
};
