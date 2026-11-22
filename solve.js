// Fast drop-in for makefun-site 1.0.0: same output tree, built in one fused pass.
// Written from the spec (README) plus the reference behaviour; every routine below
// is my own structure: fused lex+render for Markdown, flat compiled templates
// rendered into arrays, cached slugs, and index-based front-matter scanning.

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

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

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
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
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

function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ws = code < 128 ? code === 32 || (code >= 9 && code <= 13) : /\s/.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
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
      raw = raw.replace(/[ \t]+$/, '');
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

function trimLine(line) { return line.replace(/^[ \t]+|[ \t]+$/g, ''); }

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering straight into `out` (no intermediate strings for nesting).
// A fresh native regex finds each special character; plain runs are sliced in
// bulk. (The regex is created per call so nested renders never share state.)
function inlineInto(s, link, out) {
  const re = /[\\`*\[&<>"']/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        if (i > start) out.push(s.slice(start, i));
        out.push(nx === '>' ? '&gt;' : nx);
        re.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          re.lastIndex = j + 2;
          start = j + 2;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), link, out);
        out.push('</em>');
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
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
  if (start < s.length) out.push(s.slice(start));
}

function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
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

function listInto(items, isOrd, startNo, link, parts) {
  const tag = isOrd ? 'ol' : 'ul';
  parts.push(isOrd && startNo !== 1 ? '<ol start="' + startNo + '">' : '<' + tag + '>', '\n');
  for (const it of items) {
    parts.push('<li>');
    inlineInto(it.join('\n'), link, parts);
    parts.push('</li>\n');
  }
  parts.push('</', tag, '>', '\n');
}

// Lex + render in one pass over the body's lines, writing straight into `parts`
// (the document's HTML fragments, joined once by the caller). Returns toc/excerpt.
function renderMd(body, link, slugCache, parts) {
  const lines = body.split('\n');
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
        const html = inlineStr(h.text, link);
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
          if (mm !== null) { items.push([trimLine(mm[1])]); i++; }
          else if (lines[i].charCodeAt(0) === 32 && CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        listInto(items, false, 1, link, parts);
        continue;
      }
    } else if (c0 === 62) {
      const raw = [];
      while (i < nL && lines[i].startsWith('>')) raw.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of raw) { const t = trimLine(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), link, parts);
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
          if (mm !== null) { items.push([trimLine(mm[2])]); i++; }
          else if (lines[i].charCodeAt(0) === 32 && CONTINUED_RE.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        listInto(items, true, startNo, link, parts);
        continue;
      }
    }
    const para = [trimLine(line)];
    i++;
    while (i < nL && !paraEnds(lines[i])) para.push(trimLine(lines[i++]));
    const text = para.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, link);
      excerpt = html;
      parts.push('<p>', html, '</p>', '\n');
    } else {
      parts.push('<p>');
      inlineInto(text, link, parts);
      parts.push('</p>', '\n');
    }
  }
  return { toc, excerpt: excerpt === null ? '' : excerpt };
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

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, cx, depth, out) {
  for (const n of nodes) {
    if (n.k === 0) out.push(n.t);
    else if (n.k === 1) {
      const s = textOf(lookup(scope, n.p));
      out.push(n.r ? s : esc(s));
    } else if (n.k === 3) {
      const branch = truthy(lookup(scope, n.p)) !== n.nt ? n.a : n.e;
      if (branch !== null) renderNodes(branch, scope, cx, depth, out);
    } else if (n.k === 2) {
      const xs = lookup(scope, n.p);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = {};
        vars[n.n] = xs[k];
        vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
        renderNodes(n.b, { v: vars, p: scope }, cx, depth, out);
      }
    } else if (n.k === 4) {
      const t = cx.t.get(n.n);
      if (t !== undefined && depth < 8) {
        if (cx.g.has(n.n)) {
          // Case-global template: its output depends only on site/tags/recent
          // and on the include depth (the depth-8 cut-off), so memoize it.
          const key = n.n + '\n' + (depth + 1);
          let s = cx.c.get(key);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, scope, cx, depth + 1, tmp);
            s = tmp.join('');
            cx.c.set(key, s);
          }
          out.push(s);
        } else renderNodes(t, scope, cx, depth + 1, out);
      }
    }
  }
}

// Root names a template may read from the scope chain, with `bound` names
// (loop variables, incl. `loop`) excluded: their values derive from the loop's
// path, which is itself counted. Includes recurse with the current bound set;
// a cycle yields a sentinel name, so cyclic templates are never "global".
function readsOfNodes(nodes, bound, visiting, templates) {
  const out = new Set();
  for (const n of nodes) {
    if (n.k === 1) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
    } else if (n.k === 3) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
      for (const x of readsOfNodes(n.a, bound, visiting, templates)) out.add(x);
      if (n.e !== null) for (const x of readsOfNodes(n.e, bound, visiting, templates)) out.add(x);
    } else if (n.k === 2) {
      if (!bound.has(n.p[0])) out.add(n.p[0]);
      const b2 = new Set(bound);
      b2.add(n.n);
      b2.add('loop');
      for (const x of readsOfNodes(n.b, b2, visiting, templates)) out.add(x);
    } else if (n.k === 4) {
      const sub = templates.get(n.n);
      if (sub !== undefined) {
        if (visiting.has(n.n)) out.add('\0cycle');
        else {
          visiting.add(n.n);
          for (const x of readsOfNodes(sub, bound, visiting, templates)) out.add(x);
          visiting.delete(n.n);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- build

export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // Templates that read only case-global names (site/tags/recent): their
  // output is the same on every render, so memoize them per (name, depth).
  const isGlobal = new Set();
  for (const [name, nodes] of templates) {
    const r = readsOfNodes(nodes, new Set(), new Set([name]), templates);
    let g = true;
    for (const x of r) {
      if (x !== 'site' && x !== 'tags' && x !== 'recent') { g = false; break; }
    }
    if (g) isGlobal.add(name);
  }
  const cx = { t: templates, g: isGlobal, c: new Map() };

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
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
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
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
    s.words = wordCount(s.body);
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
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
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
      return bySlug.get(slug) !== undefined ? bySlug.get(slug) : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Layouts.
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    const c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = c;
    return c;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const shared = { site, tags: allTags, recent };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (isGlobal.has(name)) {
      const key = name + '\n0';
      let s = cx.c.get(key);
      if (s === undefined) {
        const out = [];
        renderNodes(nodes, { v: { ...shared, ...vars }, p: null }, cx, 0, out);
        s = out.join('');
        cx.c.set(key, s);
      }
      return s;
    }
    const out = [];
    renderNodes(nodes, { v: { ...shared, ...vars }, p: null }, cx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: s.newer !== undefined && s.newer !== null ? { title: s.newer.data.title, url: s.newer.url, date: s.newer.data.date !== undefined ? s.newer.data.date : '', date_long: s.newer.data.date === undefined ? '' : longDate(s.newer.data.date) } : null,
      older: s.older !== undefined && s.older !== null ? { title: s.older.data.title, url: s.older.url, date: s.older.data.date !== undefined ? s.older.data.date : '', date_long: s.older.data.date === undefined ? '' : longDate(s.older.data.date) } : null,
      is_post: s.post,
    };
    // Pages (non-posts) have no newer/older neighbours: newer/older are only
    // set on posts by the collections step.
    if (!s.post) { page.newer = null; page.older = null; }
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
