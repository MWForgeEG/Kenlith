'use strict';

// Kenlith 0.12.0 (DEC-PLANCHAT-051): explicit "do not use the internet"
// instructions, recognized deterministically in the user's typed message.
// Design: docs/kenlith-0.12.0/AUTOMATIC-SEARCH.md §4.
//
// Direction of failure: a match only REMOVES web search from one message (no
// hosted web_search and no internal search signal in that request or any
// continuation of it). It never adds a search. A phrasing this list does not
// know falls back to the model's own judgment, which is not a guarantee.
//
// What is read: the text the user typed for this message only. Not earlier
// messages, attached code, project files, tool results or web content, and
// not text inside quotation marks, code spans, fenced code or "> " quote
// lines (quoted text is material, not an instruction to Kenlith).
//
// Limits: a fixed list of common English and Arabic (MSA and Egyptian)
// forms. It is not general language understanding: unusual wording,
// sarcasm, typos and other languages are not recognized.

const cc = String.fromCharCode;
const range = (from, to) => `${cc(from)}-${cc(to)}`;

// Arabic: harakat, superscript alef, tatweel; alef forms unified to bare alef.
const AR_MARKS = new RegExp(`[${range(0x064B, 0x065F)}${cc(0x0670)}${cc(0x0640)}]`, 'g');
const AR_ALEF = new RegExp(`[${cc(0x0622)}${cc(0x0623)}${cc(0x0625)}${cc(0x0671)}]`, 'g');
const BARE_ALEF = cc(0x0627);
// Typographic apostrophes become ASCII ones ("don’t" reads as "don't").
const APOSTROPHES = new RegExp(`[${cc(0x2018)}${cc(0x2019)}${cc(0x02BC)}]`, 'g');
// Quoted material, removed before matching.
const FENCED = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const DOUBLE_QUOTED = /"[^"\n]*"/g;
const CURLY_QUOTED = new RegExp(`${cc(0x201C)}[^${cc(0x201D)}\\n]*${cc(0x201D)}`, 'g');
const GUILLEMETS = new RegExp(`${cc(0x00AB)}[^${cc(0x00BB)}\\n]*${cc(0x00BB)}`, 'g');
const QUOTE_LINES = /^[ \t]*>.*$/gm;
// Sentence boundaries (Latin and Arabic comma, semicolon, question mark).
const BOUNDARY = new RegExp(`[.,;:!?\\n${cc(0x060C)}${cc(0x061B)}${cc(0x061F)}]+`, 'g');

const MAX_CHARS = 20_000;

function normalize(text) {
  let s = String(text || '').slice(0, MAX_CHARS);
  s = s.replace(FENCED, ' ').replace(INLINE_CODE, ' ').replace(QUOTE_LINES, ' ');
  s = s.replace(APOSTROPHES, "'");
  s = s.replace(DOUBLE_QUOTED, ' ').replace(CURLY_QUOTED, ' ').replace(GUILLEMETS, ' ');
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(AR_MARKS, '').replace(AR_ALEF, BARE_ALEF);
  s = s.replace(BOUNDARY, ' | ');
  s = s.replace(/[^\p{L}\p{N}'|]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
  return ` ${s} `;
}

// English building blocks.
const EN_NEG = String.raw`(?:i don't want you to|i do not want you to|i dont want you to|you don't need to|you do not need to|you dont need to|no need to|don't|dont|do not|never|avoid|refrain from|stop)`;
const EN_USE = String.raw`(?:use|using|access|accessing|rely on|consult|check)`;
const EN_WEB = String.raw`(?:the )?(?:internet|web|net|online sources?|online|web search|search engines?|google|browsing|browser|websites?)`;
const EN_SEARCH = String.raw`(?:search|searching|google|googling|browse|browsing|look (?:\S+ )?up|looking (?:\S+ )?up)`;
// Arabic building blocks (after normalization: bare alef, no harakat).
const AR_NEG = String.raw`(?:و?لا|و?ما|بلاش|مش عايزك|مش عاوزك|مش محتاج|مش لازم|لا داعي|مفيش داعي|ارجو عدم|يرجى عدم)`;
const AR_USE = String.raw`(?:تستخدم|تستعمل|تدخل على|تدخل|تفتح|تروح على)`;
const AR_WEB = String.raw`(?:ال)?(?:انترنت|نت|ويب|جوجل|مواقع|متصفح)`;
const AR_SEARCH = String.raw`(?:تبحث|تدور|تفتش|تتصفح|تجوجل)`;

const rule = (id, source, bare = false) => Object.freeze({ id, re: new RegExp(`(?<= )${source}(?= )`, 'u'), bare });

const RULES = Object.freeze([
  rule('en-neg-use-web', `${EN_NEG} (?:\\S+ )?${EN_USE} ${EN_WEB}`),
  rule('en-neg-online', `${EN_NEG} (?:go|going|get|getting) online`),
  rule('en-neg-search', `${EN_NEG} ${EN_SEARCH}`, true),
  rule('en-without', `without (?:searching|browsing|googling|looking (?:\\S+ )?up|going online|(?:using|accessing) ${EN_WEB})`, true),
  rule('en-no-web', String.raw`no (?:web|internet|online)(?: (?:search|searches|searching|access|lookups?|browsing|sources))?`),
  rule('en-offline', String.raw`(?:offline only|stay offline|work offline|answer offline|from memory only|(?:answer|reply|respond)(?: only)? from (?:your )?(?:own )?(?:memory|knowledge|training(?: data)?))`),
  rule('en-turn-off', String.raw`(?:turn off|disable|skip) (?:the )?(?:web search|web|internet|search|browsing)`, true),
  rule('ar-neg-use-web', `${AR_NEG} ${AR_USE} ${AR_WEB}`),
  rule('ar-neg-search', `${AR_NEG} ${AR_SEARCH}`, true),
  rule('ar-without', String.raw`و?(?:بدون|من غير|دون|من دون) (?:ما )?(?:بحث|البحث|تبحث|تدور|تصفح|التصفح|انترنت|الانترنت|نت|النت|ويب|الويب|(?:استخدام|استعمال) (?:ال)?(?:انترنت|نت|ويب|بحث))`, true),
  rule('ar-egyptian', String.raw`(?:ما ?|م)?ت(?:بحث|دور|فتش|تصفح)ش`, true),
  rule('ar-egyptian-use', `(?:ما ?|م)?ت(?:ستخدم|ستعمل|دخل|فتح)ش (?:على )?${AR_WEB}`),
  rule('ar-masdar', String.raw`(?:عدم|بلاش) (?:ال)?(?:بحث|تدوير|تصفح)`, true),
  rule('ar-masdar-use', `(?:عدم|بلاش) (?:استخدام|استعمال|دخول) ${AR_WEB}`),
  rule('ar-offline', String.raw`(?:اوفلاين|بدون اتصال|(?:جاوب|جاوبني|اجب|اجبني|رد)(?: فقط)? من (?:ذاكرتك|معلوماتك|معرفتك))`)
]);

// A bare "don't search" about something local ("don't search the project
// files") is not about the web. The rest of the clause decides.
const LOCAL = new Set(['project', 'repo', 'repository', 'codebase', 'code', 'file', 'files', 'folder', 'folders', 'workspace', 'chat', 'chats', 'history', 'conversation', 'log', 'logs', 'database', 'docs', 'document', 'documents', 'notes', 'source',
  'المشروع', 'مشروعي', 'الملفات', 'ملفاتي', 'الملف', 'الكود', 'كودي', 'المستودع', 'الريبو', 'المجلد', 'الفولدر', 'المحادثه', 'المحادثة', 'السجل', 'الشات']);
const WEB = new Set(['internet', 'web', 'online', 'google', 'net', 'website', 'websites', 'browser', 'انترنت', 'الانترنت', 'نت', 'النت', 'ويب', 'الويب', 'جوجل', 'مواقع']);
// A statement about someone else ("I don't use the internet much", "my app
// does not use the web") is not an instruction. These words before the
// negation mark it as a statement.
const SUBJECTS = new Set(['i', 'we', 'they', 'he', 'she', 'it', "it's", 'people', 'users', 'user', 'this', 'that', 'which', 'who', 'app', 'server', 'system', 'program', 'script', 'service', 'extension', 'tool', 'kenlith', 'model']);

// "No internet" is an instruction only where a clause starts ("No internet.
// What is a monad?", "please, no web search"), not inside a description
// ("checks whether there is no internet connection").
const CLAUSE_START = new Set(['', '|', 'please', 'and', 'but', 'so', 'just', 'with', 'also']);

function clauseAfter(padded, end) {
  const rest = padded.slice(end).split('|')[0];
  return rest.trim().split(' ').filter(Boolean).slice(0, 6);
}

function wordBefore(padded, start) {
  const words = padded.slice(0, start).trim().split(' ');
  return words.length ? words[words.length - 1] : '';
}

// { noWeb: boolean, rule: id of the first rule that matched, or undefined }.
function detectNoWeb(text) {
  const padded = normalize(text);
  for (const { id, re, bare } of RULES) {
    const global = new RegExp(re.source, 'gu');
    for (const match of padded.matchAll(global)) {
      const start = match.index;
      const end = start + match[0].length;
      if (id.startsWith('en-neg') && SUBJECTS.has(wordBefore(padded, start))) continue;
      if (id === 'en-no-web' && !CLAUSE_START.has(wordBefore(padded, start))) continue;
      if (bare) {
        const said = match[0].split(' ');
        if (!said.some((word) => WEB.has(word))) {
          const clause = clauseAfter(padded, end);
          if (clause.some((word) => LOCAL.has(word)) && !clause.some((word) => WEB.has(word))) continue;
        }
      }
      return Object.freeze({ noWeb: true, rule: id });
    }
  }
  return Object.freeze({ noWeb: false, rule: undefined });
}

module.exports = { RULES, detectNoWeb, normalize };
