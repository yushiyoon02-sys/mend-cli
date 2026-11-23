// main.ts is mend, the CLI SPEC.md specifies (MIT). It does every section of SPEC.md: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's text split into lines at its own line break (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(s: Split): string {
  return s.lines.length === 0 ? '' : s.lines.join(s.br) + (s.final ? s.br : '');
}

/** A line an edit names: context lines are in both O and N (SPEC.md section 5). */
interface Part {
  text: string;
  ctx: boolean;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs in the file's lines at or after `from`, and where (section 5). */
function findOccurrences(fileLines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): Found | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= fileLines.length; i += 1) {
      if (eofOnly && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!eqTier(fileLines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The lines N writes in place of the matched lines: context as the file's own, tier 2 re-indented (section 5). */
function replacement(fileLines: string[], pos: number, o: Part[], n: Part[], tier: number): string[] {
  const matched = fileLines.slice(pos, pos + o.length);
  const ctxAt: number[] = [];
  o.forEach((p, i) => {
    if (p.ctx) ctxAt.push(i);
  });
  const pre = o.length > 0 ? leadWs(o[0]!.text) : '';
  const filePre = matched.length > 0 ? leadWs(matched[0]!) : '';
  let c = 0;
  return n.map((p) => {
    if (p.ctx) {
      const v = matched[ctxAt[c]!]!;
      c += 1;
      return v;
    }
    if (tier === 2 && !/^[ \t]*$/.test(p.text) && p.text.startsWith(pre)) return filePre + p.text.slice(pre.length);
    return p.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). */
interface UBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function backslashAfterLastCtxNew(body: UBody[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return body[i + 1]?.kind === 'bs';
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: UHunk | null = null;
  const fresh = (gitOld: string | null, gitNew: string | null): USection => {
    const s: USection = { gitOld, gitNew, pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const endBody = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
    hunk = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (hunk !== null) {
      const endsPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      if (!endsPair && (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))) {
        const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : line.startsWith('+') ? 'new' : 'bs';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1), empty: line === '' });
        continue;
      }
      endBody();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) cur = fresh(null, null);
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('+++ ')) cur.pairNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
  }
  endBody();
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
    if (oldPath === null && newPath === null) return;
    const creation = (oldPath === null || sec.newFile) && newPath !== null;
    const deletion = !creation && (newPath === null || sec.delFile);
    if (creation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === 'new') {
            plus.push(b.text);
            noFinal = h.body[idx + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath!;
    const to = newPath!;
    const move = from !== to;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (move && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(from);
    if (text === null) throw new Fail('missing', from);
    if (move && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const o: Part[] = [];
      const n: Part[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else if (b.kind === 'new') n.push({ text: b.text, ctx: false });
      }
      const bs = backslashAfterLastCtxNew(h.body);
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...n.map((p) => p.text));
        if (atEnd) f.final = !bs;
      } else {
        const found = findOccurrences(f.lines, o.map((p) => p.text), strict, 0, false);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        const runsToEnd = pos + o.length === f.lines.length;
        f.lines.splice(pos, o.length, ...replacement(f.lines, pos, o, n, found.tier));
        if (runsToEnd) f.final = !bs;
      }
      d += n.length - o.length;
    }
    const out = joinFile(f);
    if (move) {
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, out);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0; // first line index after the previous block's REPLACE line
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let mid = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (mid < 0 && lines[j]!.trimEnd() === '=======') mid = j;
      else if (mid >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let p: string | null = null;
    for (let j = i - 1; j >= after; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        p = t;
        break;
      }
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${i + 1}`);
    prevPath = p;
    const path = p;
    const oldLines = lines.slice(i + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      const f = splitFile(text);
      const found = findOccurrences(f.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const o: Part[] = oldLines.map((t) => ({ text: t, ctx: false }));
      const n: Part[] = newLines.map((t) => ({ text: t, ctx: false }));
      f.lines.splice(found.positions[0]!, o.length, ...replacement(f.lines, found.positions[0]!, o, n, found.tier));
      tree.now.set(path, joinFile(f));
    });
    after = end + 1;
    i = end;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  o: Part[];
  n: Part[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = lines[i]!;
    const kind = head.startsWith('*** Add File: ') ? 'add' : head.startsWith('*** Delete File: ') ? 'del' : head.startsWith('*** Update File: ') ? 'upd' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = head.slice(head.indexOf(': ') + 2).trim();
    const headLine = i + 1;
    i += 1;
    const body: Array<{ line: string; no: number }> = [];
    while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ')) {
      body.push({ line: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) content.push(b.line.slice(1));
        else if (b.line === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      if (rest.length > 0 && rest[0]!.line.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.line.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let closed = false;
      for (const b of rest) {
        if (b.line.startsWith('@@')) {
          const anchor = b.line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          chunks.push(chunk);
          closed = false;
        } else if (b.line.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, o: [], n: [], eof: true };
            chunks.push(chunk);
          } else {
            chunk.eof = true;
          }
          closed = true;
        } else if (b.line === '' || b.line.startsWith(' ') || b.line.startsWith('-') || b.line.startsWith('+')) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.no}`);
            chunk = { anchor: null, o: [], n: [], eof: false };
            chunks.push(chunk);
          } else if (closed) {
            throw new Exit2(`error: parse ${b.no}`);
          }
          const text = b.line === '' ? '' : b.line.slice(1);
          if (b.line === '' || b.line.startsWith(' ')) {
            chunk.o.push({ text, ctx: true });
            chunk.n.push({ text, ctx: true });
          } else if (b.line.startsWith('-')) chunk.o.push({ text, ctx: false });
          else chunk.n.push({ text, ctx: false });
        } else {
          throw new Exit2(`error: parse ${b.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (eqTier(f.lines[k]!, ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...ch.n.map((p) => p.text));
        cursor = at + ch.n.length;
      } else {
        const found = findOccurrences(f.lines, ch.o.map((p) => p.text), strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        f.lines.splice(pos, ch.o.length, ...replacement(f.lines, pos, ch.o, ch.n, found.tier));
        cursor = pos + ch.n.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const rows: Array<{ key: string; line: string }> = [];
  const claimed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (claimed.has(o) || claimed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      claimed.add(o);
      claimed.add(n);
    }
  }
  for (const p of changed) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
