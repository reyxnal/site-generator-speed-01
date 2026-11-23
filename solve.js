// Fast drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// Own implementation, written from the reference's README and code: same answers for
// every input, less work. No imports, no I/O, no clock, no randomness.
//
// Where the time goes in the reference, and what this does instead:
//  - escapeHtml called once per character while rendering inline Markdown: this scans
//    whole runs at once and writes the five entities directly; ranges keep emphasis,
//    strong and link text uncopied, and text with no Markdown construct is only escaped.
//  - the Markdown lexer tests eight regexes per line: this dispatches on the first
//    character, inlined, and checks the rest by hand.
//  - lexing builds a token array that rendering walks again: this renders each block
//    as it lexes it, and the front matter and the body share one line split.
//  - slugify normalises and strips combining marks on every call: this caches every
//    distinct string (tags repeat heavily) and skips the Unicode work for ASCII.
//  - wordsOf runs /\S+/g: this counts word runs by hand in one pass over the joined
//    body (with a Unicode-whitespace check per non-ASCII character).
//  - templates are walked node by node with a scope-chain lookup per variable: this
//    keeps the same walk but pushes into one output array per render (no string
//    concatenation per node), reuses one scope object per for-loop execution and one
//    root scope per build, and reuses each page's card and each link resolution.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const UNI_MARKS = /\p{M}/gu;

/**
 * The slug of `text`, cached per run in `cache`: NFKD, combining marks dropped, A-Z
 * lowered, every run of characters other than a-z and 0-9 one "-", none at either end,
 * at most SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when nothing
 * is left. ASCII strings skip the normalisation: NFKD is the identity on ASCII and
 * no ASCII character is a combining mark.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(UNI_MARKS, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** JavaScript whitespace beyond ASCII (for the /\S+/ fallback in wordsOf). */
const UNI_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The words of a text: its runs of characters other than whitespace. One pass: ASCII
 * whitespace by code, anything else by the Unicode-whitespace test on that one
 * character (a whole-string pre-test would scan the text twice). */
function wordsOf(t) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    else ws = UNI_WS.test(t[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}



/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function isKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function isBlank(l) {
  if (l === '') return true;
  let i = 0;
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++;
  return i === l.length;
}

function stripTrailingST(s) {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  return s.slice(0, e);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

function numAt(s, i, len) {
  let v = 0;
  for (let k = 0; k < len; k++) {
    const c = s[i + k];
    if (!isDigit(c)) return -1;
    v = v * 10 + (c.charCodeAt(0) - 48);
  }
  return v;
}

function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}

function isSlug(s) {
  if (s.length === 0) return false;
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '-') {
      if (seg === 0) return false;
      seg = 0;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) seg++;
    else return false;
  }
  return seg > 0;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      const y = ok ? numAt(raw, 0, 4) : -1;
      const mo = ok ? numAt(raw, 5, 2) : -1;
      const d = ok ? numAt(raw, 8, 2) : -1;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let k = 0; k < t.length; k++) {
          const c = t[k];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body start: { data, bodyStart }, or { error } with the
 * first reason it is refused. `lines` is the source's text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line[0] === '#') continue;
    let j = 0;
    while (j < line.length && isKeyChar(line[j])) j++;
    if (j === 0 || line[j] !== ':' || (j + 1 < line.length && line[j + 1] !== ' ')) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, j);
    const raw = stripTrailingST(j + 1 < line.length ? line.slice(j + 2) : '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ------------------------------------------------------------------ Markdown

/** A line of spaces and tabs, trimmed at both ends. Most lines have neither: return them untouched. */
function trimLine(l) {
  if (l.length === 0) return l;
  const a0 = l[0];
  const b0 = l[l.length - 1];
  if (a0 !== ' ' && a0 !== '\t' && b0 !== ' ' && b0 !== '\t') return l;
  let a = 0;
  let b = l.length;
  while (a < b && (l[a] === ' ' || l[a] === '\t')) a++;
  while (b > a && (l[b - 1] === ' ' || l[b - 1] === '\t')) b--;
  return l.slice(a, b);
}

/** A fence's language, or null when the line does not open one. */
function fenceOpen(l) {
  if (l[0] !== '`' || l[1] !== '`' || l[2] !== '`') return null;
  let i = 3;
  let lang = '';
  while (i < l.length) {
    const c = l[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') {
      lang += c;
      i++;
    } else break;
  }
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++;
  return i === l.length ? lang : null;
}

/** Whether the line closes a fence. */
function fenceClose(l) {
  if (l[0] !== '`' || l[1] !== '`' || l[2] !== '`') return false;
  for (let i = 3; i < l.length; i++) if (l[i] !== ' ' && l[i] !== '\t') return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(l) {
  if (l[0] !== '#') return null;
  let n = 0;
  while (n < l.length && l[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= l.length || (l[n] !== ' ' && l[n] !== '\t')) return null;
  let i = n;
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) i++;
  if (i >= l.length) return null;
  let e = l.length;
  while (e > i && (l[e - 1] === ' ' || l[e - 1] === '\t')) e--;
  return { depth: n, text: l.slice(i, e) };
}

/** Whether the line is a thematic break. */
function isHR(l) {
  const c = l[0];
  if (c !== '-' && c !== '*') return false;
  if (l[1] !== c || l[2] !== c) return false;
  for (let i = 3; i < l.length; i++) if (l[i] !== ' ' && l[i] !== '\t') return false;
  return true;
}

/** A list item's marker, or null: { ordered, start, text }. */
function listMarker(l) {
  const c0 = l[0];
  if (c0 === '-' || c0 === '*') {
    if (l[1] === ' ') return { ordered: false, start: 1, text: l.slice(2) };
    return null;
  }
  if (c0 >= '0' && c0 <= '9') {
    let i = 0;
    while (i < l.length && l[i] >= '0' && l[i] <= '9') i++;
    if (i > 9) return null;
    if (l[i] === '.' && l[i + 1] === ' ') return { ordered: true, start: Number(l.slice(0, i)), text: l.slice(i + 2) };
    return null;
  }
  return null;
}

/** Whether the line continues a list item (two or more spaces, then a non-space). */
function isContinued(l) {
  if (l[0] !== ' ' || l[1] !== ' ') return false;
  let i = 0;
  while (i < l.length && l[i] === ' ') i++;
  if (i < 2 || i >= l.length) return false;
  const c = l[i];
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') return false;
  if (c.charCodeAt(0) >= 128 && UNI_WS.test(c)) return false;
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break.
 * Dispatched on the first character: a paragraph line is none of those, and each test
 * only fires for a line that could pass it. */
function endsParagraph(l) {
  if (l === '') return true;
  const c = l[0];
  if (c === ' ' || c === '\t') return isBlank(l);
  if (c === '`') return fenceOpen(l) !== null;
  if (c === '#') return headingOf(l) !== null;
  if (c === '-' || c === '*') return isHR(l);
  return false;
}

/** The characters a backslash escapes. */
function isEscapable(c) {
  return (
    c === '\\' || c === '`' || c === '*' || c === '_' || c === '[' || c === ']' || c === '(' || c === ')' || c === '#' || c === '+' || c === '-' || c === '.' || c === '!' || c === '>'
  );
}

/** How many backslashes run immediately before position `j` in `s`. */
function backslashRun(s, j) {
  let n = 0;
  for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (backslashRun(s, j) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1.
 * The reference skips a `**` pair whole (both stars): an escaped star is skipped
 * with its backslash, and a star followed by another star is skipped with it. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (backslashRun(s, j) % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline-special character: \ ` * [ & < > " '. */
const INLINE_RE = /[\\`*\[&<>"']/g;
const TARGET_WS = /\s/;

/** The Markdown constructs (as opposed to plain escaping): \ ` * [. */
const MD_RE = /[\\`*[]/g;

/** A link target's href, as the reference resolves it. */
function linkOf(ctx, target) {
  const c0 = target.charCodeAt(0);
  let scheme = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  if (scheme) {
    for (let i = 1; i < target.length; i++) {
      const c = target.charCodeAt(i);
      if (c === 58) break;
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
        scheme = false;
        break;
      }
    }
    if (scheme && target.indexOf(':') === -1) scheme = false;
  }
  if (scheme || target[0] === '/' || target[0] === '#') return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  let path;
  if (rel === '') path = null;
  else {
    const key = ctx.dir + '\n' + rel;
    path = ctx.linkCache.get(key);
    if (path === undefined) {
      path = resolvePath(ctx.dir, rel);
      ctx.linkCache.set(key, path);
    }
  }
  if (path !== null) {
    const pg = ctx.bySource.get(path);
    if (pg !== undefined) return pg.url + frag;
    if (ctx.staticPaths.has(path)) return ctx.base + '/' + path + frag;
  }
  ctx.broken.add(`broken-link ${ctx.srcPath} -> ${target}`);
  return target;
}

/** `s` rendered inline; `ctx.link` resolves a link's target. Works on the range [a, b)
 * so emphasis, strong and link text render without copying the inner text first; a
 * range holding no Markdown construct at all is only escaped, in one native pass. */
function inlineStr(s, ctx, a = 0, b = s.length) {
  MD_RE.lastIndex = a;
  const fm = MD_RE.exec(s);
  if (fm === null || fm.index >= b) return esc(s.slice(a, b));
  const out = [];
  let i = a;
  while (i < b) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) {
      out.push(s.slice(i, b));
      break;
    }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') {
      out.push('&amp;');
      i = j + 1;
    } else if (c === '<') {
      out.push('&lt;');
      i = j + 1;
    } else if (c === '>') {
      out.push('&gt;');
      i = j + 1;
    } else if (c === '"') {
      out.push('&quot;');
      i = j + 1;
    } else if (c === "'") {
      out.push('&#39;');
      i = j + 1;
    } else if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && isEscapable(d)) {
        out.push(d === '>' ? '&gt;' : d);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k !== -1 && k < b && k > j + 2) {
          out.push('<strong>', inlineStr(s, ctx, j + 2, k), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k !== -1 && k < b && k > j + 1) {
          out.push('<em>', inlineStr(s, ctx, j + 1, k), '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && k < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= b ? '' : s.slice(k + 2, m2);
      if (target !== '' && !TARGET_WS.test(target)) {
        out.push('<a href="', esc(linkOf(ctx, target)), '">', inlineStr(s, ctx, j + 1, k), '</a>');
        i = m2 + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
  }
  return out.join('');
}

/**
 * `lines[start..]` rendered: its HTML, its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, start, ctx) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === '`') {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !(lines[i][0] === '`' && fenceClose(lines[i]))) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        const code = body.length === 0 ? '' : esc(body.join('\n') + '\n');
        blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, ctx.slugCache), ids);
        const html = inlineStr(hd.text, ctx);
        blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const mk = listMarker(line);
      if (mk !== null) {
        const isOrdered = mk.ordered;
        const items = [[trimLine(mk.text)]];
        i++;
        while (i < n) {
          const l2 = lines[i];
          const d0 = l2[0];
          if (d0 === '-' || d0 === '*' || (d0 >= '0' && d0 <= '9')) {
            const m2 = listMarker(l2);
            if (m2 !== null && m2.ordered === isOrdered) {
              items.push([trimLine(m2.text)]);
              i++;
              continue;
            }
          }
          if (isContinued(l2)) {
            items[items.length - 1].push(trimLine(l2));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && mk.start !== 1 ? `<ol start="${mk.start}">` : `<${tag}>`;
        let inner = '';
        for (let p = 0; p < items.length; p++) inner += `<li>${inlineStr(items[p].join('\n'), ctx)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>\n`);
        continue;
      }
    } else if (c0 === '>') {
      const q = [];
      while (i < n && lines[i][0] === '>') {
        const l2 = lines[i++];
        q.push(trimLine(l2[1] === ' ' ? l2.slice(2) : l2.slice(1)));
      }
      const kept = q.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), ctx)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const mk = listMarker(line);
      if (mk !== null) {
        const isOrdered = mk.ordered;
        const items = [[trimLine(mk.text)]];
        i++;
        while (i < n) {
          const l2 = lines[i];
          const d0 = l2[0];
          if (d0 === '-' || d0 === '*' || (d0 >= '0' && d0 <= '9')) {
            const m2 = listMarker(l2);
            if (m2 !== null && m2.ordered === isOrdered) {
              items.push([trimLine(m2.text)]);
              i++;
              continue;
            }
          }
          if (isContinued(l2)) {
            items[items.length - 1].push(trimLine(l2));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && mk.start !== 1 ? `<ol start="${mk.start}">` : `<${tag}>`;
        let inner = '';
        for (let p = 0; p < items.length; p++) inner += `<li>${inlineStr(items[p].join('\n'), ctx)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>\n`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), ctx);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isOnlyST(src, a, b) {
  for (let i = a; i < b; i++) if (src[i] !== ' ' && src[i] !== '\t') return false;
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isOnlyST(src, lineStart, open) && isOnlyST(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  markFlat(root.body);
  return root.body;
}

/** A body is flat when it holds only text, var and raw: such a body renders without
 * a recursive call (for-bodies resolve their loop variable straight from the loop). */
function markFlat(nodes) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      n.flat = n.body.every((b) => b.kind === 'text' || b.kind === 'var' || b.kind === 'raw');
      markFlat(n.body);
    } else if (n.kind === 'if') {
      n.then.flat = n.then.every((b) => b.kind === 'text' || b.kind === 'var' || b.kind === 'raw');
      if (n.else !== null) n.else.flat = n.else.every((b) => b.kind === 'text' || b.kind === 'var' || b.kind === 'raw');
      markFlat(n.then);
      if (n.else !== null) markFlat(n.else);
    }
  }
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), pushing text into `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    const k = n.kind;
    if (k === 'text') out.push(n.text);
    else if (k === 'var') out.push(esc(textOf(lookup(scope, n.path))));
    else if (k === 'raw') out.push(textOf(lookup(scope, n.path)));
    else if (k === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch === null) {
        // nothing
      } else if (branch.flat) {
        for (let bi = 0; bi < branch.length; bi++) {
          const bn = branch[bi];
          if (bn.kind === 'text') out.push(bn.text);
          else if (bn.kind === 'var') out.push(esc(textOf(lookup(scope, bn.path))));
          else out.push(textOf(lookup(scope, bn.path)));
        }
      } else renderNodes(branch, scope, ctx, depth, out);
    } else if (k === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars[n.name] = null;
        vars.loop = loop;
        const child = { vars, parent: scope };
        if (n.flat) {
          const body = n.body;
          const name = n.name;
          for (let kk = 0; kk < xs.length; kk++) {
            const item = xs[kk];
            vars[name] = item;
            loop.index = kk + 1;
            loop.first = kk === 0;
            loop.last = kk === xs.length - 1;
            for (let bi = 0; bi < body.length; bi++) {
              const bn = body[bi];
              if (bn.kind === 'text') out.push(bn.text);
              else {
                const p = bn.path;
                let v;
                if (p[0] === name) {
                  v = item;
                  for (let q = 1; q < p.length; q++) {
                    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[q])) { v = undefined; break; }
                    v = v[p[q]];
                  }
                } else if (p[0] === 'loop') {
                  v = loop;
                  for (let q = 1; q < p.length; q++) {
                    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[q])) { v = undefined; break; }
                    v = v[p[q]];
                  }
                } else v = lookup(child, p);
                if (bn.kind === 'var') out.push(esc(textOf(v)));
                else out.push(textOf(v));
              }
            }
          }
        } else {
          for (let kk = 0; kk < xs.length; kk++) {
            vars[n.name] = xs[kk];
            loop.index = kk + 1;
            loop.first = kk === 0;
            loop.last = kk === xs.length - 1;
            renderNodes(n.body, child, ctx, depth, out);
          }
        }
      }
    } else if (k === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------ the build

/** A page's link record as templates read it. */
function pageLinkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    if (file.path.endsWith('.md')) {
      const text = file.content.indexOf('\r') === -1 ? file.content : file.content.replace(/\r\n?/g, '\n');
      sources.push({ path: file.path, lines: text.split('\n'), text });
    } else statics.push({ path: file.path, content: file.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.lines);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    // The body's offset in the source text: its words are counted straight from the
    // slice (a join of the body lines would copy the whole body for every source).
    let bodyOff = 0;
    for (let li = 0; li < s.bodyStart; li++) bodyOff += s.lines[li].length + 1;
    s.bodyOffset = bodyOff;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url.
  const bySource = new Map();
  const taken = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const ctx = { templates, slugCache, bySource, staticPaths, broken, base, dir: '', srcPath: '', linkCache: new Map() };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    ctx.dir = dirOf(s.path);
    ctx.srcPath = s.path;
    const md = renderMarkdown(s.lines, s.bodyStart, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.text.slice(s.bodyOffset));
  }

  // 5. The posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags, grouped by their slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const sl = slugify(names[i], slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(names[i]);
      }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tagsArr = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(kept.map((s) => [s, cardOf(s)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagsArr.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One vars object and one root scope, reused by every render: each call sets the
  // keys it uses and clears the rest to undefined, which reads exactly like a
  // missing variable (lookup returns undefined, textOf "" , truthy false).
  const baseVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: baseVars, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    baseVars.page = vars.page;
    baseVars.posts = vars.posts;
    baseVars.pager = vars.pager;
    baseVars.tag = vars.tag;
    const out = [];
    renderNodes(nodes, rootScope, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    // The cached card becomes the page: templates only read named fields, so the
    // extra keys are invisible to every other render that shares this card.
    const page = cards.get(s);
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc;
    page.newer = pageLinkOf(s.newer ?? null);
    page.older = pageLinkOf(s.older ?? null);
    page.is_post = s.post;
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tagsArr.length; ti++) {
    const t = tagsArr[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagsArr.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
