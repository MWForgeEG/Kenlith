'use strict';

// A scripted fake of the OpenAI auth and API endpoints, installed as global
// fetch. Every token here is synthetic and signed by a throwaway test key.

const crypto = require('node:crypto');

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'oaiapp_synthetic_test';
const FULL_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'synthetic-test-key';
const realFetch = globalThis.fetch;

function idToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-synthetic-1',
    email: 'synthetic@example.test',
    name: 'Synthetic User',
    iat: now,
    exp: now + 3600,
    ...claims
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function jwks() {
  return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function sse(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// A stream that emits `deltas` and then stays open until the request is aborted.
function hangingStream(deltas, signal) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const delta of deltas) {
        const event = { type: 'response.output_text.delta', delta };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function completedStream(text) {
  return sse([
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { status: 'completed' } }
  ]);
}

class FakeOpenAI {
  constructor() {
    this.requests = [];
    this.tokenHandler = undefined;
    this.responsesHandler = undefined;
    this.revokeHandler = () => json(200);
    this.models = [
      { slug: 'gpt-alpha', display_name: 'GPT Alpha', visibility: 'list' },
      { slug: 'gpt-beta', display_name: 'GPT Beta', visibility: 'list' },
      { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' }
    ];
    this.refreshCount = 0;
  }

  install() {
    globalThis.fetch = (url, options = {}) => this.#handle(String(url), options);
    return this;
  }

  uninstall() {
    globalThis.fetch = realFetch;
  }

  async #handle(url, options) {
    if (url.startsWith('http://127.0.0.1')) {
      return realFetch(url, options);
    }

    const body = typeof options.body === 'string'
      ? options.body
      : options.body instanceof URLSearchParams ? options.body.toString() : undefined;
    const request = {
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body,
      form: body && !body.startsWith('{') ? Object.fromEntries(new URLSearchParams(body)) : undefined,
      json: body?.startsWith('{') ? JSON.parse(body) : undefined,
      signal: options.signal
    };
    this.requests.push(request);

    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/jwks`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`
      });
    }
    if (url === `${ISSUER}/jwks`) {
      return json(200, jwks());
    }
    if (url === `${ISSUER}/api/accounts/oauth/token`) {
      if (request.form.grant_type === 'refresh_token') {
        this.refreshCount += 1;
      }
      return this.tokenHandler(request);
    }
    if (url === `${ISSUER}/oauth/revoke`) {
      return this.revokeHandler(request);
    }
    if (url === 'https://api.openai.com/v1/models') {
      return json(200, { models: this.models });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      return this.responsesHandler(request);
    }
    return json(404, { error: { message: `Unexpected URL in test: ${url}` } });
  }

  requestsTo(suffix) {
    return this.requests.filter((request) => request.url.endsWith(suffix));
  }
}

// Stored credentials in the shape AuthService writes to SecretStorage.
function storedCredentials(overrides = {}) {
  return {
    email: 'synthetic@example.test',
    name: 'Synthetic User',
    subject: 'user-synthetic-1',
    clientId: CLIENT_ID,
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    accessToken: 'synthetic-access-0',
    refreshToken: 'synthetic-refresh-0',
    idToken: idToken(),
    tokenType: 'Bearer',
    scopes: FULL_SCOPE.split(' '),
    expiresAt: Date.now() + 3_600_000,
    savedAt: new Date().toISOString(),
    ...overrides
  };
}

function tokenResponse(overrides = {}) {
  return {
    access_token: 'synthetic-access-1',
    refresh_token: 'synthetic-refresh-1',
    id_token: idToken(),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: FULL_SCOPE,
    ...overrides
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

module.exports = {
  CLIENT_ID,
  FULL_SCOPE,
  FakeOpenAI,
  completedStream,
  hangingStream,
  idToken,
  json,
  jwks,
  sse,
  storedCredentials,
  tokenResponse,
  waitFor
};
