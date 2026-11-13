'use strict';

// Kenlith 0.7.0 RC3 (DEC-PLANCHAT-036): recognising sensitive text, shared by
// the command-output boundary (src/exec-boundary.js) and the read tools
// (src/workspace-safety.js readContained, owner decision of 2026-11-11 to
// include the read path in RC3). Pure: no I/O.

const entropy = (s) => {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
};

// A value too plain to be a secret on its own: a lower-case word or
// identifier (development, localhost, service_account), a boolean, a short number.
const plainValue = (v) => /^[a-z][a-z_]{0,19}$/.test(v) || /^(true|false|null|none|yes|no|on|off)$/i.test(v) || /^\d{1,5}$/.test(v);


// ---------- known formats and unknown secrets ----------

// Removed as whole lines (in addition to src/attachments.js credentialLines).
const COMMAND_CREDENTIAL_PATTERNS = Object.freeze([
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprse]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{10,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // Connection strings.
  /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s]{4,}/i
]);

// Configuration-style secrets: `name = value` or `name: value` where a word
// of the name says key, secret, token, password, credential or auth (API_KEY,
// dbPassword, client_secret; not "Author", "monkey" or "keyboard"), and the
// value is a literal, not code (`process.env.API_KEY`) or a placeholder.
// A strong word (password, secret) makes any literal value a secret; a weak
// word (key, token, auth, session, seed, cert) only a random-looking one.
const STRONG_WORDS = new Set(['password', 'passwd', 'passphrase', 'pwd', 'pw', 'pass', 'secret', 'secrets', 'apikey', 'privatekey', 'secretkey', 'accesskey', 'credential', 'credentials', 'pin', 'otp']);
const SECRET_WORDS = new Set(['pw', 'key', 'keys', 'apikey', 'secret', 'secrets', 'token', 'password', 'passwd', 'passphrase', 'pwd', 'pass', 'credential', 'credentials', 'auth', 'privatekey', 'secretkey', 'accesskey', 'signature', 'sas', 'dsn', 'pin', 'otp', 'seed', 'phrase', 'signing', 'salt', 'cookie', 'session', 'private', 'cert', 'sid', 'pat']);
const CONFIG_PAIR = /(?:^|[\s"'{,;(])["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^\s"',;)}]{6,})/g;
const CODE_VALUE = /^(?:process\.env|os\.environ|env\.|getenv|import\.meta|config\.|settings\.|this\.|self\.|req\.|options\.|null$|undefined$|true$|false$|none$|[$%<{]|\$\{)/i;
// Masks the value of each such pair (the rest of the line stays). Returns
// { line, count }.
function maskConfigSecrets(line) {
  let count = 0;
  const masked = line.replace(CONFIG_PAIR, (match, name, value) => {
    const words = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/).filter(Boolean);
    if (!words.some((w) => SECRET_WORDS.has(w))) return match;
    if (CODE_VALUE.test(value) || value.includes('(') || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) return match;
    const strong = words.some((w) => STRONG_WORDS.has(w));
    if (plainValue(value)) return match;
    // A name that says the value is a location (secretsDir, passwordPolicyUrl,
    // credentialsPath): a path or a plain address there is not a secret.
    if (words.some((w) => NAMING_WORDS.has(w)) && NOT_SECRET_VALUE.test(value)) return match;
    if (strong ? value.length < 6 : (NOT_SECRET_VALUE.test(value) || !randomLooking(value))) return match;
    count += 1;
    return match.slice(0, match.length - value.length) + '[redacted]';
  });
  return { line: masked, count };
}
const NAMING_WORDS = new Set(['dir', 'directory', 'path', 'paths', 'url', 'urls', 'uri', 'file', 'files', 'folder', 'policy', 'endpoint', 'route', 'location', 'link', 'page']);
// Values that name something rather than hide something: paths, addresses
// without credentials, numbers and durations, integrity hashes.
const NOT_SECRET_VALUE = /^(?:\.{0,2}\/|[A-Za-z]:\\|~\/|[a-z][a-z0-9+.-]*:\/\/[^\s@]*$|\d+(?:\.\d+)?(?:ms|s|m|h|d|px|em|%)?$|sha(?:1|256|384|512)-)/i;
// A value that looks generated: long, with digits and letters, and varied.
function randomLooking(value) {
  if (value.length < 12 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return entropy(value) >= 3.5;
}
// The user information of an address (scheme://user:password@host,
// scheme://token@host), whatever its shape.
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

const PRIVATE_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

// Removes private key blocks whole (to the END line, or to the end of the
// output when it was cut).
function removePrivateKeys(lines) {
  const out = [];
  let inside = false;
  let removed = 0;
  for (const line of lines) {
    if (!inside && PRIVATE_BEGIN.test(line)) {
      inside = !PRIVATE_END.test(line.slice(line.search(PRIVATE_BEGIN) + 10));
      removed += 1;
      out.push('[private key removed]');
      continue;
    }
    if (inside) {
      if (PRIVATE_END.test(line)) inside = false;
      continue;
    }
    out.push(line);
  }
  return { lines: out, removed };
}

// A long token that looks random: an unknown secret. Pure hexadecimal (git
// object ids, hashes) and ordinary words, paths and numbers are left alone.
function looksSecret(token) {
  if (token.length < 24) return false;
  if (/^[0-9a-f]+$/i.test(token) || /^[0-9a-f-]+$/i.test(token)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(token)).length;
  if (classes < 2 || !/\d/.test(token)) return false;
  const h = entropy(token);
  return token.length >= 32 ? h >= 3.6 : h >= 4.0;
}
const TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;


// Whether a text holds something that looks sensitive: a known credential
// format, a private key, credentials inside an address, a configuration
// secret, or a long random-looking string. The read tools refuse such a file
// whole (as for src/attachments.js credentialLines).
function hasSensitiveText(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (COMMAND_CREDENTIAL_PATTERNS.some((re) => re.test(line)) || PRIVATE_BEGIN.test(line)) return true;
    USERINFO.lastIndex = 0;
    if (USERINFO.test(line)) return true;
    if (maskConfigSecrets(line).count) return true;
    const tokens = (line.match(TOKEN) || []).filter((t) => !/^sha(?:1|256|384|512)-/.test(t));
    if (tokens.some((t) => looksSecret(t) || t.split('/').some(looksSecret))) return true;
  }
  return false;
}

// RC5 (DEC-PLANCHAT-038): a key whose name itself denotes sensitive material.
// The strong words above, `token`, or `key` with a qualifier that makes it a
// credential (API_KEY, PRIVATE_KEY, ACCESS_KEY, ACCOUNT_KEY, SECRET_KEY); a
// bare KEY too. Not: CACHE_KEY, SORT_KEY, SESSION_TIMEOUT, AUTHOR.
const KEY_QUALIFIERS = new Set(['api', 'private', 'access', 'account', 'secret', 'secrets', 'signing', 'encryption', 'master', 'client', 'auth', 'license', 'service', 'shared', 'storage', 'subscription']);
function isSensitiveKeyName(name) {
  const words = String(name).replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/).filter(Boolean);
  if (words.some((w) => STRONG_WORDS.has(w) || w === 'token' || w === 'tokens')) return true;
  if (words.length === 1 && words[0] === 'key') return true;
  return words.includes('key') && words.some((w) => KEY_QUALIFIERS.has(w));
}

module.exports = { isSensitiveKeyName, STRONG_WORDS, randomLooking, COMMAND_CREDENTIAL_PATTERNS, PRIVATE_BEGIN, PRIVATE_END, SECRET_WORDS, TOKEN, USERINFO, entropy, hasSensitiveText, looksSecret, maskConfigSecrets, plainValue, removePrivateKeys };
