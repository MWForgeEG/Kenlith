'use strict';

// A real local HTTP server standing in for auth.openai.com, shared by several
// worker processes. Refresh tokens rotate: each successful refresh retires the
// presented token, and presenting a retired token returns refresh_token_reused.
// All tokens are synthetic.

const http = require('node:http');
const { CLIENT_ID, FULL_SCOPE, idToken, jwks } = require('./fake-openai');

function startOAuthServer() {
  const state = {
    valid: new Set(['synthetic-refresh-0']),
    retired: new Set(),
    revoked: [],
    refreshes: [],
    issued: 0,
    delayMs: 0,
    mode: 'normal'
  };

  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    if (request.url === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: 'https://auth.openai.com',
        jwks_uri: 'https://auth.openai.com/jwks',
        revocation_endpoint: 'https://auth.openai.com/oauth/revoke'
      });
    }
    if (request.url === '/jwks') {
      return send(200, jwks());
    }
    if (request.url === '/oauth/revoke') {
      state.revoked.push(form.token);
      state.valid.delete(form.token);
      return send(200);
    }
    if (request.url === '/api/accounts/oauth/token' && form.grant_type === 'refresh_token') {
      const presented = form.refresh_token;
      const entry = { token: presented, at: Date.now(), worker: request.headers['x-worker'] || '' };
      state.refreshes.push(entry);
      if (state.mode === 'network') {
        request.socket.destroy();
        return undefined;
      }
      if (state.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.mode === 'revoked' || !state.valid.has(presented)) {
        entry.result = state.retired.has(presented) ? 'refresh_token_reused' : 'invalid_grant';
        return send(400, { error: entry.result, error_description: 'Refresh token is not valid.' });
      }
      state.valid.delete(presented);
      state.retired.add(presented);
      state.issued += 1;
      const next = `synthetic-refresh-${state.issued}`;
      state.valid.add(next);
      entry.result = 'rotated';
      return send(200, {
        access_token: `synthetic-access-${state.issued}`,
        refresh_token: next,
        id_token: idToken({ aud: CLIENT_ID }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: FULL_SCOPE
      });
    }
    return send(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { startOAuthServer };
