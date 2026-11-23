// Fast drop-in for makefun-site 1.0.0: same output tree, built with compiled
// templates and a range-based Markdown renderer. Written from the spec
// (README) plus the reference behaviour; every routine below is my own
// structure: templates are compiled once per case into plain JavaScript
// functions (no node-tree walk, no per-iteration scope objects), Markdown
// inline rendering works on index ranges (no substring copies for nesting),
// word counting rides the line split, and run() returns the case answer
// already as JSON text so main.ts never re-walks the output tree.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
// ASCII whitespace flags for the branchless word counter (JS \s, ASCII half).
const WS = new Uint8Array(128);
WS[9] = 1; WS[10] = 1; WS[11] = 1; WS[12] = 1; WS[13] = 1; WS[32] = 1;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);
// A scope object with no prototype: plain property reads on it are exactly
// own-property lookups, which is what the template dialect's lookup does.
const nullObj = () => Object.create(null);

// ---------------------------------------------------------------- text helpers

function esc(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    if (i > start) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

function slugRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  let plain = text;
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    // Char-code loop: a code unit is a letter/digit exactly when its code
    // point is, and every other unit is a gap, so this matches the
    // code-point loop of the reference for ASCII text.
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const s = slugRaw(text);
  cache.set(text, s);
  return s;
}

function uniqSlug(slug, set, next) {
  if (!set.has(slug)) { set.add(slug); next.set(slug, 2); return slug; }
  let n = next.get(slug) || 2;
  let cand;
  while (set.has((cand = slug + '-' + n))) n++;
  set.add(cand);
  next.set(slug, n + 1);
  return cand;
}

function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// Words of a line: branchless over char codes. `p` is 1 when the previous
// character was whitespace (or at a line start, since '\n' is whitespace),
// so a word starts exactly where a non-space follows one.
function countWordsLine(line, words, p) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    let w;
    if (c < 128) w = WS[c];
    else w = (c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF) ? 1 : 0;
    words += p & (1 - w);
    p = w;
  }
  return words;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringVal(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nn = raw[i + 1];
        if ((nn !== '"' && nn !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nn;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function keyVal(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringVal(raw);
    return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  if (key === 'layout') return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  if (key === 'slug') return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  return { error: 'unknown key "' + key + '"' };
}

function trimRightWs(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

// Parse front matter by scanning lines in place (no split/join of the body).
// Returns { data, body } or { error }.
function parseFM(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl + 1;
  let lineNo = 2;
  let body = '';
  for (;;) {
    const e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    if (line === '---') {
      body = e === -1 ? '' : text.slice(e + 1);
      break;
    }
    if (e === -1) return { error: 'the front matter is not closed' };
    if (!BLANK_RE.test(line) && line[0] !== '#') {
      // key: [a-z_]+ ':' (' ' rest)?
      let j = 0;
      while (j < line.length && ((line[j] >= 'a' && line[j] <= 'z') || line[j] === '_')) j++;
      if (j === 0 || line[j] !== ':' || (j + 1 < line.length && line[j + 1] !== ' ')) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = line.slice(0, j);
      let raw = j + 1 < line.length ? line.slice(j + 2) : '';
      raw = trimRightWs(raw);
      if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = keyVal(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = e + 1;
    lineNo++;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

// A line with spaces/tabs at either end dropped (no regex).
function trimStr(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// The first index in [from, to) where `s` holds `what` outside a backslash
// escape, or -1. The range bound keeps a match from ever reading past `to`.
function findUnescaped(s, what, from, to) {
  for (let j = from; j <= to - what.length; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering of s[lo, hi) straight into `out`. Nested bold, emphasis
// and link text recurse on index ranges of the same string, so no substring
// is ever copied for nesting. `re` is one scratch regex per document; its
// lastIndex is reset explicitly after every recursive call.
function inlineRange(s, lo, hi, link, out, re) {
  let start = lo;
  re.lastIndex = lo;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    if (i >= hi) break;
    const c = m[0];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && i + 1 < hi && ESCAPABLE.has(nx)) {
        if (i > start) out.push(s.slice(start, i));
        out.push(nx === '>' ? '&gt;' : nx);
        re.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < hi) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2 && j + 2 <= hi) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out, re);
          out.push('</strong>');
          re.lastIndex = j + 2;
          start = j + 2;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1 && j < hi) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>');
        inlineRange(s, i + 1, j, link, out, re);
        out.push('</em>');
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let mm = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        const q = s.indexOf(')', k + 2);
        if (q !== -1 && q < hi) mm = q;
      }
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="', esc(link(target)), '">');
        inlineRange(s, i + 1, k, link, out, re);
        out.push('</a>');
        re.lastIndex = mm + 1;
        start = mm + 1;
      }
      continue;
    }
    if (i > start) out.push(s.slice(start, i));
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    re.lastIndex = i + 1;
    start = i + 1;
  }
  if (start < hi) out.push(s.slice(start, hi));
}

// A line that ends a paragraph: blank, fence, heading or thematic break.
// Dispatched on the first character: only those starters can match.
function paraEnds(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK_RE.test(line);
  if (c0 === 96) return FENCE_OPEN_RE.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR_RE.test(line);
  return false;
}

function listInto(items, isOrd, startNo, link, parts, re) {
  const tag = isOrd ? 'ol' : 'ul';
  parts.push(isOrd && startNo !== 1 ? '<ol start="' + startNo + '">' : '<' + tag + '>', '\n');
  for (const it of items) {
    const text = it.join('\n');
    parts.push('<li>');
    inlineRange(text, 0, text.length, link, parts, re);
    parts.push('</li>\n');
  }
  parts.push('</', tag, '>', '\n');
}

// Lex + render in one pass over the body's lines, writing straight into
// `parts` (the document's HTML fragments, joined once by the caller).
// Word counting rides the split lines: '\n' is whitespace, so counting each
// line with a fresh word state is exactly the body's word count.
function renderMd(body, link, slugCache, parts) {
  const lines = body.split('\n');
  let words = 0;
  for (const line of lines) words = countWordsLine(line, words, 1);
  const re = /[\\`*\[&<>"']/g;
  const toc = [];
  const ids = new Set();
  const next = new Map();
  let excerpt = null;
  let i = 0;
  const nL = lines.length;
  while (i < nL) {
    const line = lines[i];
    const c0 = line.length === 0 ? 0 : line.charCodeAt(0);
    if (c0 === 0 || c0 === 32 || c0 === 9) {
      if (BLANK_RE.test(line)) { i++; continue; }
    } else if (c0 === 96) {
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        parts.push('<pre><code');
        if (lang !== '') parts.push(' class="language-', lang, '"');
        parts.push('>');
        i++;
        while (i < nL && !FENCE_CLOSE_RE.test(lines[i])) { parts.push(esc(lines[i]), '\n'); i++; }
        i++;
        parts.push('</code></pre>', '\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqSlug(slugify(h.text, slugCache), ids, next);
        const tmp = [];
        inlineRange(h.text, 0, h.text.length, link, tmp, re);
        const html = tmp.join('');
        parts.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>', '\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR_RE.test(line)) { parts.push('<hr>', '\n'); i++; continue; }
      const bul = BULLET_RE.exec(line);
      if (bul !== null) {
        const items = [];
        while (i < nL) {
          const mm = BULLET_RE.exec(lines[i]);
          if (mm !== null) { items.push([trimStr(mm[1])]); i++; }
          else if (lines[i].charCodeAt(0) === 32 && CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimStr(lines[i])); i++; }
          else break;
        }
        listInto(items, false, 1, link, parts, re);
        continue;
      }
    } else if (c0 === 62) {
      const raw = [];
      while (i < nL && lines[i].startsWith('>')) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        raw.push(l);
      }
      const kept = [];
      for (const l of raw) { const t = trimStr(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        const text = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineRange(text, 0, text.length, link, parts, re);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ord = ORDERED_RE.exec(line);
      if (ord !== null) {
        const items = [];
        const startNo = Number(ord[1]);
        while (i < nL) {
          const mm = ORDERED_RE.exec(lines[i]);
          if (mm !== null) { items.push([trimStr(mm[2])]); i++; }
          else if (lines[i].charCodeAt(0) === 32 && CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimStr(lines[i])); i++; }
          else break;
        }
        listInto(items, true, startNo, link, parts, re);
        continue;
      }
    }
    const para = [trimStr(line)];
    i++;
    while (i < nL && !paraEnds(lines[i])) para.push(trimStr(lines[i++]));
    const text = para.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineRange(text, 0, text.length, link, tmp, re);
      const html = tmp.join('');
      excerpt = html;
      parts.push('<p>', html, '</p>', '\n');
    } else {
      parts.push('<p>');
      inlineRange(text, 0, text.length, link, parts, re);
      parts.push('</p>', '\n');
    }
  }
  return { toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

// Tokenize + parse a template source into a node tree. Node shapes:
// {k:0,t} text · {k:1,p,r} var · {k:2,n,p,b} for · {k:3,nt,p,a,e} if · {k:4,n} include
function compileTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { k: 9, kind: 'root', b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokens) {
    if (tok.t === 'text') body.push({ k: 0, t: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: 1, p: tok.path, r: tok.t === 'raw' ? 1 : 0 });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 2, kind: 'for', n: m[1], p: pathOf(name, m[2]), b: [] };
        body.push(node);
        stack.push(node);
        body = node.b;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 3, kind: 'if', nt: m[1] !== undefined, p: pathOf(name, m[2]), a: [], e: null };
        body.push(node);
        stack.push(node);
        body = node.a;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.e !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.e = [];
        body = top.e;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 2 : 3)) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 9 ? parent.b : parent.k === 2 ? parent.b : parent.e !== null ? parent.e : parent.a;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ k: 4, n: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.b;
}

// A value as text: a string itself, a number in JavaScript's digits, true
// or false, an array's items joined by ", ", anything else "".
function tv(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(tv).join(', ');
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false, "",
// 0 or an empty array.
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// A path's value as a JavaScript expression over the scope object S and the
// scratch variable _v. Every scope value is a null-prototype object, an
// array or a scalar, so a segment read is an own-property read exactly when
// the value so far is an object; anything else is undefined, as the
// dialect's lookup says.
function pathExpr(p) {
  let e = 'S.' + p[0];
  for (let k = 1; k < p.length; k++) {
    e = '(_v=' + e + ',_v==null||typeof _v!=="object"?void 0:_v.' + p[k] + ')';
  }
  return e;
}

// Generate the JavaScript body of one template's node tree. `o` is the
// output array, `S` the flat scope (loop variables are written into it and
// restored, so an include sees its caller's loop bindings, as the dialect
// requires), `D` the include depth, `F` the map of compiled templates.
function genNodes(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.k === 0) s += 'o.push(' + JSON.stringify(n.t) + ');';
    else if (n.k === 1) s += n.r ? 'o.push(tv(' + pathExpr(n.p) + '));' : 'o.push(esc(tv(' + pathExpr(n.p) + ')));';
    else if (n.k === 2) {
      s += '{const _xs=' + pathExpr(n.p) + ';if(Array.isArray(_xs)){const _sv=S.' + n.n + ',_sl=S.loop,_lp=Object.create(null);_lp.length=_xs.length;for(let _i=0;_i<_xs.length;_i++){_lp.index=_i+1;_lp.first=_i===0;_lp.last=_i===_xs.length-1;S.' + n.n + '=_xs[_i];S.loop=_lp;' + genNodes(n.b) + '}S.' + n.n + '=_sv;S.loop=_sl;}}';
    } else if (n.k === 3) {
      s += n.nt ? 'if(!tr(' + pathExpr(n.p) + ')){' : 'if(tr(' + pathExpr(n.p) + ')){';
      s += genNodes(n.a) + '}';
      if (n.e !== null) s += 'else{' + genNodes(n.e) + '}';
    } else if (n.k === 4) {
      s += 'if(D<8){const _f=F[' + JSON.stringify(n.n) + '];if(_f)_f(o,S,D+1,F);}';
    }
  }
  return s;
}

// Compile every parsed template into a function in one `new Function`
// call, and return them as a null-prototype map by name.
function buildTemplates(trees) {
  let src = '';
  for (const [name, nodes] of trees) {
    src += JSON.stringify(name) + ':function(o,S,D,F){var _v;' + genNodes(nodes) + '},';
  }
  const factory = new Function('esc', 'tv', 'tr', 'return {' + src + '}');
  return Object.assign(nullObj(), factory(esc, tv, tr));
}

// ---------------------------------------------------------------- build

export function run(input) {
  const slugCache = new Map();
  const report = [];
  const trees = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      trees.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const F = buildTemplates(trees);
  const base = input.site.base_url.replace(/\/+$/, '');
  // One flat scope for the whole case: site/tags/recent live on it, and each
  // render writes its own page/posts/pager/tag keys (all four, every time,
  // so no render ever sees another's leftovers).
  const S = nullObj();
  const outParts = [];
  const render = (name, setVars) => {
    const f = F[name];
    if (f === undefined) return null;
    S.page = setVars.page;
    S.posts = setVars.posts;
    S.pager = setVars.pager;
    S.tag = setVars.tag;
    f(outParts, S, 0, F);
    const s = outParts.join('');
    outParts.length = 0;
    return s;
  };

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter + refusal checks, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== null) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!trees.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // Permalinks.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let slot = takenByDir.get(dir);
    if (slot === undefined) {
      slot = { set: new Set(dir === '' ? RESERVED : []), next: new Map() };
      takenByDir.set(dir, slot);
    }
    const slug = uniqSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, slugCache), slot.set, slot.next);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown + links.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      let c0 = target.charCodeAt(0);
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let j = 1;
        for (; j < target.length; j++) {
          const ch = target[j];
          if (ch === ':') return target;
          if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '+' || ch === '.' || ch === '-')) break;
        }
      }
      if (target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const parts = [];
    const md = renderMd(s.body, link, slugCache, parts);
    s.html = parts.join('');
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags !== undefined ? s.data.tags : []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = nullObj();
        tag.name = name;
        tag.slug = slug;
        tag.url = base + '/tags/' + slug + '/';
        tag.posts = [];
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      const t = bySlug.get(slug);
      if (t !== undefined) return t;
      const o = nullObj();
      o.name = name;
      o.slug = slug;
      o.url = '';
      o.posts = [];
      return o;
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Layouts.
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    const c = nullObj();
    c.title = s.data.title;
    c.url = s.url;
    c.date = s.data.date !== undefined ? s.data.date : '';
    c.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    c.summary = s.data.summary !== undefined ? s.data.summary : '';
    c.excerpt = s.excerpt;
    c.reading_minutes = Math.max(1, Math.ceil(s.words / 200));
    c.tags = s.tagRefs.map((t) => {
      const o = nullObj();
      o.name = t.name;
      o.slug = t.slug;
      o.url = t.url;
      return o;
    });
    s._card = c;
    return c;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = nullObj();
  site.title = input.site.title;
  site.base_url = base;
  const allTags = tags.map((t) => {
    const o = nullObj();
    o.name = t.name;
    o.slug = t.slug;
    o.url = t.url;
    o.count = t.posts.length;
    return o;
  });
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  S.site = site;
  S.tags = allTags;
  S.recent = recent;
  const frags = [];
  const built = new Set();
  const noVars = { page: undefined, posts: undefined, pager: undefined, tag: undefined };
  for (const s of kept) {
    const card = cardOf(s);
    const page = nullObj();
    page.title = card.title;
    page.url = card.url;
    page.date = card.date;
    page.date_long = card.date_long;
    page.summary = card.summary;
    page.excerpt = card.excerpt;
    page.reading_minutes = card.reading_minutes;
    page.tags = card.tags;
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc.map((h) => {
      const o = nullObj();
      o.level = h.level;
      o.id = h.id;
      o.html = h.html;
      return o;
    });
    const nw = s.post && s.newer !== null ? s.newer : null;
    const ol = s.post && s.older !== null ? s.older : null;
    page.newer = nw === null ? null : (() => {
      const o = nullObj();
      o.title = nw.data.title;
      o.url = nw.url;
      o.date = nw.data.date !== undefined ? nw.data.date : '';
      o.date_long = nw.data.date === undefined ? '' : longDate(nw.data.date);
      return o;
    })();
    page.older = ol === null ? null : (() => {
      const o = nullObj();
      o.title = ol.data.title;
      o.url = ol.url;
      o.date = ol.data.date !== undefined ? ol.data.date : '';
      o.date_long = ol.data.date === undefined ? '' : longDate(ol.data.date);
      return o;
    })();
    page.is_post = s.post;
    const html = render(s.layout, { page, posts: undefined, pager: undefined, tag: undefined });
    built.add(s.outDir + '/index.html');
    frags.push(JSON.stringify(s.outDir + '/index.html') + ':' + JSON.stringify(html));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const pager = nullObj();
    pager.number = k;
    pager.total = pages;
    pager.url = indexUrl(k);
    pager.newer_url = k === 1 ? '' : indexUrl(k - 1);
    pager.older_url = k === pages ? '' : indexUrl(k + 1);
    const html = render('index', { page: undefined, posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)), pager, tag: undefined });
    if (html !== null) {
      built.add(k === 1 ? 'index.html' : 'page/' + k + '/index.html');
      frags.push(JSON.stringify(k === 1 ? 'index.html' : 'page/' + k + '/index.html') + ':' + JSON.stringify(html));
    }
  }
  for (const t of tags) {
    const tag = nullObj();
    tag.name = t.name;
    tag.slug = t.slug;
    tag.url = t.url;
    tag.count = t.posts.length;
    tag.posts = t.posts.map((p) => cards.get(p));
    const html = render('tag', { page: undefined, posts: undefined, pager: undefined, tag });
    if (html !== null) {
      built.add('tags/' + t.slug + '/index.html');
      frags.push(JSON.stringify('tags/' + t.slug + '/index.html') + ':' + JSON.stringify(html));
    }
  }
  const tagsHtml = render('tags', noVars);
  if (tagsHtml !== null) {
    built.add('tags/index.html');
    frags.push(JSON.stringify('tags/index.html') + ':' + JSON.stringify(tagsHtml));
  }
  for (const f of statics) {
    if (built.has(f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else frags.push(JSON.stringify(f.path) + ':' + JSON.stringify(f.content));
  }

  // Report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  frags.push(JSON.stringify('build-report.txt') + ':' + JSON.stringify(lines.join('\n') + '\n'));
  return '{' + frags.join(',') + '}';
}
