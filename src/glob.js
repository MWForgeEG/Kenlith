'use strict';

// A small matcher for the exclude settings of VS Code (`files.exclude`,
// `search.exclude`): objects of { glob: true | false | { when } }. It covers
// the documented glob syntax: `*`, `?`, `**`, `{a,b}` and `[...]`. Patterns
// are matched against a folder-relative path with forward slashes, without
// case distinction (Windows file names are case-insensitive), so a pattern
// can only exclude more, never less. A pattern that matches a directory
// excludes everything under it, as in the editor.
//
// Matching runs a token automaton over the path (one pass, a set of active
// pattern positions), not a regular expression: its cost is at most the
// path length times the pattern length, whatever the pattern. A workspace's
// own settings therefore cannot make matching slow (M1 security review: a
// pattern such as "*a*a*a*a*a*a*a*a*b" made backtracking regular expressions
// take seconds to minutes on a long name).
//
// Exclusion here is a convenience layer only. The security rules are in
// src/workspace-safety.js and no setting can weaken them.

// Token kinds: a literal character; `?`; a [...] class; `*` (any run within
// one segment); `**` (any run, slashes included); `**/` (zero or more whole
// segments).
const LITERAL = 0;
const ONE = 1;
const CLASS = 2;
const STAR = 3;
const ANY = 4;
const SEGMENTS = 5;

// At most this many alternatives after expanding {a,b} groups.
const MAX_ALTERNATIVES = 64;

// Splits "a,b{c,d},e" at top-level commas.
function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// Expands the first top-level {a,b} group, recursively; an unclosed brace is
// a literal character.
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 1;
  let end = open + 1;
  while (end < pattern.length && depth) {
    if (pattern[end] === '{') depth += 1;
    if (pattern[end] === '}') depth -= 1;
    end += 1;
  }
  if (depth) {
    // Unclosed: keep the brace as a literal, expand what follows it.
    return expandBraces(pattern.slice(open + 1)).map((rest) => pattern.slice(0, open + 1) + rest);
  }
  const head = pattern.slice(0, open);
  const tails = expandBraces(pattern.slice(end));
  const out = [];
  for (const alternative of splitAlternatives(pattern.slice(open + 1, end - 1))) {
    for (const middle of expandBraces(alternative)) {
      for (const tail of tails) {
        out.push(head + middle + tail);
        if (out.length > MAX_ALTERNATIVES) throw new Error('too many alternatives');
      }
    }
  }
  return out;
}

// A [...] body as a test for one (lower-case) character.
function classTest(body) {
  const negate = body.startsWith('!') || body.startsWith('^');
  const chars = negate ? body.slice(1) : body;
  const ranges = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index + 1] === '-' && index + 2 < chars.length) {
      ranges.push([chars[index], chars[index + 2]]);
      index += 2;
    } else {
      ranges.push([chars[index], chars[index]]);
    }
  }
  const inRange = (char) => ranges.some(([low, high]) => char >= low && char <= high);
  return (char) => {
    const hit = inRange(char) || inRange(char.toUpperCase());
    return negate ? !hit : hit;
  };
}

function tokenize(pattern) {
  const tokens = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` after a separator (or at the start): whole segments;
        // otherwise `**` is any run.
        const before = index === 0 || pattern[index - 1] === '/';
        if (before && pattern[index + 2] === '/') {
          tokens.push({ kind: SEGMENTS });
          index += 2;
        } else {
          tokens.push({ kind: ANY });
          index += 1;
        }
        // Further stars add nothing.
        while (pattern[index + 1] === '*') index += 1;
      } else {
        tokens.push({ kind: STAR });
      }
    } else if (char === '?') {
      tokens.push({ kind: ONE });
    } else if (char === '[') {
      const end = pattern.indexOf(']', index + 2);
      if (end === -1) {
        tokens.push({ kind: LITERAL, char: '[' });
      } else {
        tokens.push({ kind: CLASS, test: classTest(pattern.slice(index + 1, end).toLowerCase()) });
        index = end;
      }
    } else {
      tokens.push({ kind: LITERAL, char: char.toLowerCase() });
    }
  }
  // Adjacent wildcards that each match any run collapse to one (no effect on
  // the result, less work).
  return tokens.filter((token, index) => !(index > 0
    && (token.kind === STAR || token.kind === ANY) && token.kind === tokens[index - 1].kind));
}

// Positions reachable without reading a character: past every wildcard that
// can match nothing.
function close(active, tokens) {
  for (let position = 0; position < tokens.length; position += 1) {
    if (active[position] && tokens[position].kind >= STAR) active[position + 1] = 1;
  }
  return active;
}

function matchTokens(tokens, path) {
  let active = close(new Uint8Array(tokens.length + 1).fill(0, 0).map((_, index) => (index === 0 ? 1 : 0)), tokens);
  for (const raw of path) {
    const char = raw.toLowerCase();
    const next = new Uint8Array(tokens.length + 1);
    let any = false;
    for (let position = 0; position < tokens.length; position += 1) {
      if (!active[position]) continue;
      const token = tokens[position];
      switch (token.kind) {
        case LITERAL:
          if (token.char === char) { next[position + 1] = 1; any = true; }
          break;
        case ONE:
          if (char !== '/') { next[position + 1] = 1; any = true; }
          break;
        case CLASS:
          if (char !== '/' && token.test(char)) { next[position + 1] = 1; any = true; }
          break;
        case STAR:
          if (char !== '/') { next[position] = 1; any = true; }
          break;
        case ANY:
          next[position] = 1;
          any = true;
          break;
        case SEGMENTS:
          next[position] = 1;
          // Leaving the segments only right after a separator.
          if (char === '/') next[position + 1] = 1;
          any = true;
          break;
        default:
          break;
      }
    }
    if (!any) return false;
    active = close(next, tokens);
  }
  return Boolean(active[tokens.length]);
}

// One glob as a matcher over a whole relative path: { test(path) }.
function globToMatcher(pattern) {
  let text = String(pattern).replace(/\\/g, '/').trim();
  // "./src" and "/src" are folder-relative too.
  text = text.replace(/^\.\//, '').replace(/^\/+/, '');
  // A trailing "/" means the folder itself.
  text = text.replace(/\/+$/, '');
  const alternatives = expandBraces(text).map(tokenize);
  return { test: (path) => alternatives.some((tokens) => matchTokens(tokens, String(path))) };
}

// Compiles an exclude object. `false` entries are ignored: in this matcher
// they never re-include anything (the editor uses `false` only to switch off
// a default entry of the same setting).
function compileExcludes(...objects) {
  const plain = [];
  const conditional = [];
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    // Bounded work for any settings: at most 500 patterns of 1,000 characters.
    for (const [pattern, value] of Object.entries(object).slice(0, 500)) {
      if (!pattern || pattern.length > 1000) continue;
      let matcher;
      try {
        matcher = globToMatcher(pattern);
      } catch {
        continue;
      }
      if (value === true) plain.push(matcher);
      else if (value && typeof value === 'object' && typeof value.when === 'string') conditional.push({ matcher, when: value.when });
    }
  }
  return {
    // `siblingExists(name)`: whether a file with that name is in the same
    // folder; needed only for `when` entries.
    excludes(relPath, siblingExists) {
      if (plain.some((matcher) => matcher.test(relPath))) return true;
      if (!conditional.length) return false;
      const name = relPath.slice(relPath.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      const basename = dot > 0 ? name.slice(0, dot) : name;
      return conditional.some(({ matcher, when }) => matcher.test(relPath)
        && (typeof siblingExists !== 'function' || siblingExists(when.replace(/\$\(basename\)/g, basename))));
    }
  };
}

// globToRegExp: the earlier name, kept for callers; returns the same { test } matcher.
module.exports = { compileExcludes, globToMatcher, globToRegExp: globToMatcher };
