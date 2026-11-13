'use strict';

const crypto = require('node:crypto');

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function pkceChallenge(verifier) {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('The identity token is not a valid JWT.');
  }

  return {
    header: decodeJwtPart(parts[0]),
    payload: decodeJwtPart(parts[1]),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    signature: Buffer.from(parts[2], 'base64url')
  };
}

const REQUEST_TIMEOUT_MS = 30_000;

// An HTTP error response from OpenAI. Network failures stay plain errors so
// callers can tell "the server rejected this" apart from "we could not reach it".
class RequestError extends Error {
  constructor(message, { status, code, requestId, param } = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    // 0.8.0: the request field OpenAI named, if any (for example reasoning.effort).
    this.param = param;
  }
}

const SECRET_PATTERNS = [
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[REDACTED_JWT]'],
  [/\b(Bearer)\s+[\w.~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\bsk-[\w-]{8,}/g, '[REDACTED_KEY]'],
  [/((?:access|refresh|id)_token|code_verifier|client_secret)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1$2[REDACTED]']
];

function redactSecrets(text) {
  let result = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function safeError(error) {
  if (error instanceof Error && error.message) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error || 'Unknown error'));
}

function parseBody(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function errorCode(body) {
  if (typeof body?.error === 'string') {
    return body.error;
  }
  return typeof body?.error?.code === 'string' ? body.error.code : undefined;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  const body = parseBody(text);

  if (!response.ok) {
    const message = body?.error_description
      || body?.error?.message
      || (typeof body?.error === 'string' ? body.error : undefined)
      || body?.detail
      || body?.message
      || `${response.status} ${response.statusText}`;
    throw new RequestError(`OpenAI request failed: ${message}`, {
      status: response.status,
      code: errorCode(body),
      requestId: response.headers?.get?.('x-request-id') || undefined
    });
  }

  return body;
}

function normalizeEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return number > 10_000_000_000 ? number : number * 1000;
}

module.exports = {
  RequestError,
  SECRET_PATTERNS,
  base64Url,
  errorCode,
  fetchJson,
  normalizeEpoch,
  parseBody,
  parseJwt,
  pkceChallenge,
  randomToken,
  redactSecrets,
  safeError
};
