'use strict';

// Kenlith 0.9.0: URL citation annotations from a Deep Research reply, mapped
// to places in the reply text. The annotations are the authority for which
// pages were cited; this module only decides where each one sits.
//
// The Responses API gives `start_index` and `end_index` without stating the
// unit. The live probe (2026-11-14) had no character where UTF-16 and
// code-point offsets differ, so both are tried, in this order:
//   1. JavaScript (UTF-16) offsets;
//   2. Unicode code-point offsets.
// A mapping is accepted only if the text it covers carries the cited URL
// (src/markdown.js spanCarries; in the live evidence the covered text is the
// model's own Markdown link to the page). A citation with no valid mapping
// keeps its URL and title but no place: the text is left as it is, and the
// page is still listed under Sources. Nothing is guessed.

const { MAX_CITATIONS, citationKey, cleanTitle, safeUrl, spanCarries } = require('./markdown');

// UTF-16 offsets of every code-point boundary (index = code-point offset).
function codePointOffsets(text) {
  const offsets = [0];
  let position = 0;
  for (const character of text) {
    position += character.length;
    offsets.push(position);
  }
  return offsets;
}

function validRange(text, start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length
    && !/[\uDC00-\uDFFF]/.test(text[start] || '') && !/[\uD800-\uDBFF]/.test(text[end - 1] || '');
}

// The UTF-16 range of one annotation in `text`, or undefined.
function mapRange(text, start, end, url, offsets) {
  if (validRange(text, start, end) && spanCarries(text.slice(start, end), url)) {
    return { start, end, unit: 'utf16' };
  }
  const points = offsets || codePointOffsets(text);
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end < points.length) {
    const from = points[start];
    const to = points[end];
    if (validRange(text, from, to) && spanCarries(text.slice(from, to), url)) {
      return { start: from, end: to, unit: 'codepoint' };
    }
  }
  return undefined;
}

// One annotation as received (untrusted): a URL citation with a safe
// http(s) URL, or undefined (malformed or another kind of annotation).
function readAnnotation(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'url_citation') return undefined;
  const url = safeUrl(typeof raw.url === 'string' ? raw.url : '');
  if (!url || !citationKey(url)) return undefined;
  return {
    url,
    title: cleanTitle(typeof raw.title === 'string' ? raw.title : ''),
    start: Number.isInteger(raw.start_index) ? raw.start_index : undefined,
    end: Number.isInteger(raw.end_index) ? raw.end_index : undefined
  };
}

// The citations to keep for a reply: [{ url, title, start, end }] with
// UTF-16 offsets where the place was proven, [{ url, title }] otherwise.
// Overlapping places keep the first. `malformed` counts annotations that
// were not URL citations with a safe address.
function placeCitations(text, annotations) {
  const source = String(text ?? '');
  const offsets = codePointOffsets(source);
  const citations = [];
  let malformed = 0;
  let codepoint = 0;
  for (const raw of (Array.isArray(annotations) ? annotations : []).slice(0, MAX_CITATIONS)) {
    const annotation = readAnnotation(raw);
    if (!annotation) {
      malformed += 1;
      continue;
    }
    const range = mapRange(source, annotation.start, annotation.end, annotation.url, offsets);
    if (range?.unit === 'codepoint') codepoint += 1;
    citations.push(range ? { url: annotation.url, title: annotation.title, start: range.start, end: range.end } : { url: annotation.url, title: annotation.title });
  }
  // Overlaps: the earlier citation in the text keeps its place.
  const placed = citations.filter((citation) => Number.isInteger(citation.start)).sort((a, b) => a.start - b.start);
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed.slice(0, index).filter((c) => Number.isInteger(c.start)).at(-1);
    if (previous && placed[index].start < previous.end) {
      delete placed[index].start;
      delete placed[index].end;
    }
  }
  return { citations, malformed, codepoint, unplaced: citations.filter((c) => !Number.isInteger(c.start)).length };
}

module.exports = { codePointOffsets, mapRange, placeCitations, readAnnotation };
