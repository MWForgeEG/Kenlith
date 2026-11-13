'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calls, createContext } = require('./helpers/fake-vscode');
const {
  CLIENT_ID,
  FakeOpenAI,
  idToken,
  json,
  storedCredentials,
  tokenResponse
} = require('./helpers/fake-openai');
const { AuthService, CREDENTIALS_KEY } = require('../src/auth');
const { OpenAIService } = require('../src/openai');
const { buildRequest } = require('../src/request-builder');

let server;
test.beforeEach(() => {
  server = new FakeOpenAI().install();
  calls.onOpenExternal = undefined;
});
test.afterEach(() => server.uninstall());

function signedInContext(overrides) {
  const context = createContext();
  context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials(overrides)));
  context.stateValues.set('planChat.registration.v1', { clientId: CLIENT_ID });
  return context;
}

function readStored(context) {
  const raw = context.secretValues.get(CREDENTIALS_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

// Answers the browser step of sign-in by calling the loopback redirect the way
// OpenAI would, echoing state and returning an issued client ID.
function completeBrowserSignIn({ nonceOverride } = {}) {
  calls.onOpenExternal = (value) => {
    const url = new URL(value);
    server.lastAuthorizeUrl = url;
    server.lastNonce = nonceOverride || url.searchParams.get('nonce');
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', url.searchParams.get('state'));
    redirect.searchParams.set('code', 'synthetic-code');
    redirect.searchParams.set('client_id', CLIENT_ID);
    setImmediate(() => fetch(redirect).catch(() => undefined));
    return true;
  };
}

test('1. sign-in stores a validated session in SecretStorage and authorizes inference', async () => {
  const context = createContext();
  const auth = new AuthService(context);
  completeBrowserSignIn();
  server.tokenHandler = (request) => {
    assert.equal(request.form.grant_type, 'authorization_code');
    assert.equal(request.form.client_id, CLIENT_ID);
    assert.equal(request.form.resource, 'https://api.openai.com/v1');
    assert.ok(request.form.code_verifier);
    return json(200, tokenResponse({ id_token: idToken({ nonce: server.lastNonce }) }));
  };

  const session = await auth.signIn();

  const url = server.lastAuthorizeUrl;
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/);
  assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  assert.equal(session.email, 'synthetic@example.test');
  assert.equal(session.subject, 'user-synthetic-1');
  assert.equal(JSON.stringify(session).includes('synthetic-access'), false, 'session view must not carry tokens');
  assert.equal(readStored(context).accessToken, 'synthetic-access-1');
  assert.equal(readStored(context).refreshToken, 'synthetic-refresh-1');
  assert.deepEqual(context.stateValues.get('planChat.registration.v1'), { clientId: CLIENT_ID });

  const models = await new OpenAIService(auth).listModels();
  assert.deepEqual(models.map((model) => model.id), ['gpt-alpha', 'gpt-beta']);
  assert.equal(server.requestsTo('/v1/models')[0].headers.authorization, 'Bearer synthetic-access-1');
});

test('1b. reauthorization rejects a different account for the same client', async () => {
  const context = signedInContext();
  const auth = new AuthService(context);
  completeBrowserSignIn();
  server.tokenHandler = () => json(200, tokenResponse({
    id_token: idToken({ nonce: server.lastNonce, sub: 'someone-else' })
  }));

  await assert.rejects(auth.signIn(), /different account/);
  assert.equal(readStored(context).accessToken, 'synthetic-access-0');
});

test('2. missing chatgpt.tokens.use.direct blocks sign-in and inference', async () => {
  const context = createContext();
  const auth = new AuthService(context);
  completeBrowserSignIn();
  server.tokenHandler = () => json(200, tokenResponse({
    id_token: idToken({ nonce: server.lastNonce }),
    scope: 'openid profile email offline_access'
  }));

  await assert.rejects(auth.signIn(), /plan usage was not authorized/);
  assert.equal(readStored(context), undefined);

  // A stored session whose scopes lost the permission (for example after a refresh).
  const limited = signedInContext({ scopes: ['openid', 'offline_access'] });
  const openai = new OpenAIService(new AuthService(limited));
  server.responsesHandler = () => assert.fail('inference must not be attempted');
  await assert.rejects(
    openai.streamResponse({ model: 'gpt-alpha', request: buildRequest({ instructions: '', history: [], text: 'q' }), onDelta() {} }),
    (error) => error.reauthRequired && /not authorized/.test(error.message)
  );
  assert.equal(server.requestsTo('/v1/responses').length, 0);
});

test('3. an expiring access token is refreshed and the rotated refresh token persisted', async () => {
  const context = signedInContext({ expiresAt: Date.now() + 10_000 });
  const auth = new AuthService(context);
  server.tokenHandler = (request) => {
    assert.deepEqual(request.form, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: 'synthetic-refresh-0',
      resource: 'https://api.openai.com/v1'
    });
    return json(200, tokenResponse({ access_token: 'synthetic-access-2', refresh_token: 'synthetic-refresh-2' }));
  };

  assert.equal(await auth.getAccessToken(), 'synthetic-access-2');
  const stored = readStored(context);
  assert.equal(stored.refreshToken, 'synthetic-refresh-2');
  assert.ok(stored.expiresAt > Date.now() + 3_000_000);
  assert.ok(stored.scopes.includes('chatgpt.tokens.use.direct'));
  assert.equal(stored.clientId, CLIENT_ID);
});

test('3b. a refresh that keeps the old refresh token and omits scope keeps the stored values', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  server.tokenHandler = () => json(200, {
    access_token: 'synthetic-access-3',
    token_type: 'Bearer',
    expires_in: 3600
  });

  assert.equal(await new AuthService(context).getAccessToken(), 'synthetic-access-3');
  const stored = readStored(context);
  assert.equal(stored.refreshToken, 'synthetic-refresh-0');
  assert.ok(stored.scopes.includes('chatgpt.tokens.use.direct'));
});

test('4. concurrent callers share one refresh', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const auth = new AuthService(context);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  server.tokenHandler = async () => {
    await gate;
    return json(200, tokenResponse());
  };

  const pending = Array.from({ length: 5 }, () => auth.getAccessToken());
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const tokens = await Promise.all(pending);

  assert.deepEqual(new Set(tokens), new Set(['synthetic-access-1']));
  assert.equal(server.refreshCount, 1);

  // A later caller sees the stored, fresh token and does not refresh again.
  assert.equal(await auth.getAccessToken(), 'synthetic-access-1');
  assert.equal(server.refreshCount, 1);
});

test('4b. a refresh rotated by another window is adopted instead of clearing the session', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const auth = new AuthService(context);
  server.tokenHandler = () => {
    // Another editor window rotated the token first, so ours is now reused.
    context.secretValues.set(CREDENTIALS_KEY, JSON.stringify(storedCredentials({
      accessToken: 'synthetic-access-other-window',
      refreshToken: 'synthetic-refresh-other-window'
    })));
    return json(400, { error: 'refresh_token_reused' });
  };

  assert.equal(await auth.getAccessToken(), 'synthetic-access-other-window');
  assert.equal(readStored(context).refreshToken, 'synthetic-refresh-other-window');
});

for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
  test(`5. a terminal refresh error (${code}) clears tokens and asks for sign-in`, async () => {
    const context = signedInContext({ expiresAt: Date.now() - 1000 });
    const auth = new AuthService(context);
    server.tokenHandler = () => json(400, { error: code, error_description: 'Refresh token is not valid.' });

    await assert.rejects(auth.getAccessToken(), (error) => error.reauthRequired === true);
    assert.equal(readStored(context), undefined);
    assert.equal(await auth.getSession(), undefined);
    // The issued client ID is kept so the next sign-in reuses the registration.
    assert.deepEqual(context.stateValues.get('planChat.registration.v1'), { clientId: CLIENT_ID });
  });
}

test('5b. sign-in after a terminal refresh error reuses the issued client ID', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const auth = new AuthService(context);
  server.tokenHandler = () => json(400, { error: 'invalid_grant' });
  await assert.rejects(auth.getAccessToken());

  completeBrowserSignIn();
  server.tokenHandler = () => json(200, tokenResponse({ id_token: idToken({ nonce: server.lastNonce }) }));
  await auth.signIn();
  assert.equal(server.lastAuthorizeUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(server.lastAuthorizeUrl.searchParams.has('agent_name_hint'), false);
  assert.equal(readStored(context).accessToken, 'synthetic-access-1');
});

test('6. a network failure during refresh keeps the credentials', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const auth = new AuthService(context);
  const before = context.secretValues.get(CREDENTIALS_KEY);
  server.tokenHandler = () => { throw new TypeError('fetch failed'); };

  await assert.rejects(auth.getAccessToken(), /Could not reach OpenAI.*sign-in was kept/);
  assert.equal(context.secretValues.get(CREDENTIALS_KEY), before);

  // Recovery: once the network is back the same session refreshes normally.
  server.tokenHandler = () => json(200, tokenResponse());
  assert.equal(await auth.getAccessToken(), 'synthetic-access-1');
});

for (const status of [500, 503, 429]) {
  test(`6b. a ${status} from the token endpoint keeps the credentials`, async () => {
    const context = signedInContext({ expiresAt: Date.now() - 1000 });
    const before = context.secretValues.get(CREDENTIALS_KEY);
    server.tokenHandler = () => json(status, { error: 'temporarily_unavailable' });

    await assert.rejects(new AuthService(context).getAccessToken(), (error) => !error.reauthRequired);
    assert.equal(context.secretValues.get(CREDENTIALS_KEY), before);
  });
}

test('6c. a refreshed ID token for another account is rejected and not stored', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const before = context.secretValues.get(CREDENTIALS_KEY);
  server.tokenHandler = () => json(200, tokenResponse({ id_token: idToken({ sub: 'someone-else' }) }));

  await assert.rejects(new AuthService(context).getAccessToken(), /different account/);
  assert.equal(context.secretValues.get(CREDENTIALS_KEY), before);
});

test('11. sign-out revokes the refresh token and keeps registration and host ID', async () => {
  const context = signedInContext();
  context.stateValues.set('planChat.hostId.v1', 'urn:uuid:host');
  const result = await new AuthService(context).signOut();

  assert.equal(result.remoteRevoked, true);
  const revoke = server.requestsTo('/oauth/revoke');
  assert.equal(revoke.length, 1);
  assert.deepEqual(revoke[0].form, {
    token: 'synthetic-refresh-0',
    token_type_hint: 'refresh_token',
    client_id: CLIENT_ID
  });
  assert.equal(readStored(context), undefined);
  assert.deepEqual(context.stateValues.get('planChat.registration.v1'), { clientId: CLIENT_ID });
  assert.equal(context.stateValues.get('planChat.hostId.v1'), 'urn:uuid:host');
});

test('11b. sign-out retries 5xx revocation, then reports it unconfirmed but still clears tokens', async () => {
  const context = signedInContext();
  const auth = new AuthService(context);
  auth.revocationRetryDelaysMs = [1, 1];
  server.revokeHandler = () => json(503, { detail: 'unavailable' });

  const result = await auth.signOut();
  assert.equal(result.remoteRevoked, false);
  assert.equal(server.requestsTo('/oauth/revoke').length, 3);
  assert.equal(readStored(context), undefined);
});

test('11c. sign-out during a refresh does not let the refresh restore tokens', async () => {
  const context = signedInContext({ expiresAt: Date.now() - 1000 });
  const auth = new AuthService(context);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  server.tokenHandler = async () => {
    await gate;
    return json(200, tokenResponse());
  };

  const refreshing = auth.getAccessToken().catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const signingOut = auth.signOut();
  release();
  await refreshing;
  await signingOut;

  assert.equal(readStored(context), undefined);
  // The token that was revoked is the rotated one, not the stale one.
  assert.equal(server.requestsTo('/oauth/revoke')[0].form.token, 'synthetic-refresh-1');
  await assert.rejects(auth.getAccessToken(), (error) => error.reauthRequired);
});
