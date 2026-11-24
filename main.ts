// mend: one CLI that applies AI-written edits in four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text
// files, exactly as SPEC.md in the kit describes. Node 22, standard library
// only, run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// Every change is written, or none is: a patch whose edits all succeed is
// applied whole; if any edit fails, each failure is reported and the tree is
// left untouched. Matching runs at three tiers (exact, trailing-whitespace,
// full indentation drift) unless --strict pins it to exact only.
//
// When MAKEFUN_ENV_URL is set the grader is driving: the last lines hand over
// to runner.ts, which reads the trial's checks from the env and runs this CLI
// on each one. Keep that hand-over.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fatal patch-level problem: exit 2 with this single line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1 collects these, one line per failed edit. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The patch text as lines: split at \n, one trailing \r removed per line. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is relative, slash-separated and has no empty, `.` or `..` segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

/** Split a file's text at its own line break (CRLF when its first LF follows a CR). */
function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBr: false };
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/** A created file: LF breaks, ending with a break unless the format says not. */
function joinCreated(lines: string[], finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBr ? '\n' : '');
}

/**
 * The tree as the edits leave it. `now` holds every path an edit touched
 * (null: deleted); anything else is read from disk, which is also the
 * remembered original, because nothing is written until all edits succeed.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  requireSafe(p: string): void {
    if (!isSafe(p)) throw new Fail('unsafe', p);
  }
  requireFile(p: string): string {
    this.requireSafe(p);
    const t = this.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  }
}

type Edit = (tree: Tree) => void;

/** One body item of a hunk or chunk: context, deletion or addition. */
interface Item {
  kind: 'c' | 'd' | 'a';
  text: string;
  oi: number; // index inside O for context/deletion items, -1 for additions
  noNl: boolean; // a `\ No newline` line follows this item
  rawEmpty: boolean; // the item came from a truly empty patch line
}

function oldLines(items: Item[]): string[] {
  return items.filter((i) => i.kind !== 'a').map((i) => i.text);
}
function newItems(items: Item[]): Item[] {
  return items.filter((i) => i.kind !== 'd');
}

/** Does file line `a` match patch line `b` at the given tier? */
function lineMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every start position where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineMatch(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (exact only under --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * Build the replacement lines for a match at `pos`: context lines are the
 * file's own matched lines; at tier 2 the other lines are re-indented from
 * the patch's first old line's indent to the file's first matched line's.
 */
function buildNew(lines: string[], pos: number, o: string[], items: Item[], tier: number): string[] {
  const fLead = pos < lines.length ? leadWs(lines[pos]!) : '';
  const pLead = o.length > 0 ? leadWs(o[0]!) : '';
  return newItems(items).map((it) => {
    if (it.kind === 'c') return lines[pos + it.oi]!;
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(pLead)) {
      return fLead + it.text.slice(pLead.length);
    }
    return it.text;
  });
}

/** Replace O with N as plain line lists (SEARCH/REPLACE: no context items). */
function plainItems(o: string[], n: string[]): Item[] {
  const items: Item[] = o.map((text, oi) => ({ kind: 'd' as const, text, oi, noNl: false, rawEmpty: false }));
  for (const text of n) items.push({ kind: 'a', text, oi: -1, noNl: false, rawEmpty: false });
  return items;
}

// ---------------------------------------------------------------- unified

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  startLine: number;
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** The path a ---/+++ line names: after the 4 chars, to the first tab, trimmed, a/ or b/ removed. */
function headerPath(raw: string): string {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const startsSection = (idx: number): boolean =>
    lines[idx]!.startsWith('diff --git ') || (lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ '));

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!startsSection(i)) {
      i += 1;
      continue;
    }
    const sec: Section = {
      startLine: i + 1,
      diffOld: null,
      diffNew: null,
      headOld: null,
      headNew: null,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      hunks: [],
    };
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      i += 1;
    } else {
      sec.headOld = headerPath(line);
      sec.headNew = headerPath(lines[i + 1]!);
      i += 2;
    }
    let inHeader = true;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!inHeader) break;
        if (sec.headOld === null) {
          sec.headOld = headerPath(l);
          sec.headNew = headerPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (inHeader && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        inHeader = false;
        i = readHunk(lines, i, sec);
        continue;
      }
      if (inHeader) {
        if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12).trim();
        else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10).trim();
        else if (l.startsWith('new file mode')) sec.isNew = true;
        else if (l.startsWith('deleted file mode')) sec.isDeleted = true;
      }
      i += 1;
    }
    sections.push(sec);
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Read one hunk starting at its @@ line; returns the index just past its body. */
function readHunk(lines: string[], start: number, sec: Section): number {
  const header = lines[start]!;
  const m = HUNK_RE.exec(header);
  if (m === null) throw new Exit2(`error: parse ${start + 1}`);
  const items: Item[] = [];
  let oi = 0;
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    const c = l.length === 0 ? '' : l[0]!;
    if (l === '') {
      items.push({ kind: 'c', text: '', oi: oi++, noNl: false, rawEmpty: true });
    } else if (c === ' ') {
      items.push({ kind: 'c', text: l.slice(1), oi: oi++, noNl: false, rawEmpty: false });
    } else if (c === '-') {
      items.push({ kind: 'd', text: l.slice(1), oi: oi++, noNl: false, rawEmpty: false });
    } else if (c === '+') {
      items.push({ kind: 'a', text: l.slice(1), oi: -1, noNl: false, rawEmpty: false });
    } else if (c === '\\') {
      const prev = items[items.length - 1];
      if (prev !== undefined) prev.noNl = true;
    } else break;
    i += 1;
  }
  while (items.length > 0 && items[items.length - 1]!.rawEmpty) items.pop();
  sec.hunks.push({ a: Number(m[1]), items });
  return i;
}

/** Apply a section's hunks in order to a file model, tracking the offset drift. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const lines = [...model.lines];
  let finalBr = model.finalBr;
  let drift = 0;
  for (const hunk of hunks) {
    const o = oldLines(hunk.items);
    const n = newItems(hunk.items);
    if (o.length === 0) {
      const at = Math.min(Math.max(hunk.a + drift, 0), lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n.map((it) => it.text));
      if (atEnd && n.length > 0) finalBr = !n[n.length - 1]!.noNl;
    } else {
      const found = findTier(lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + drift;
      let pos = found.at[0]!;
      for (const cand of found.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const reachesEnd = pos + o.length === lines.length;
      const built = buildNew(lines, pos, o, hunk.items, found.tier);
      lines.splice(pos, o.length, ...built);
      if (reachesEnd) {
        const last = n[n.length - 1];
        finalBr = last === undefined ? true : !last.noNl;
      }
    }
    drift += n.length - o.length;
  }
  return { lines, br: model.br, finalBr };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.headOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.headNew ?? sec.renameTo ?? sec.diffNew;
  const creation = sec.isNew || oldPath === '/dev/null';
  const deletion = sec.isDeleted || newPath === '/dev/null';
  return (tree) => {
    if (creation) {
      const p = newPath;
      if (p === null) throw new Exit2(`error: parse ${sec.startLine}`);
      tree.requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: Item[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'a') added.push(it);
      const last = added[added.length - 1];
      tree.now.set(p, joinCreated(added.map((it) => it.text), last === undefined ? true : !last.noNl));
      return;
    }
    if (deletion) {
      const p = oldPath;
      if (p === null) throw new Exit2(`error: parse ${sec.startLine}`);
      tree.requireSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
    tree.requireSafe(oldPath);
    tree.requireSafe(newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const out = applyHunks(splitFile(before), sec.hunks, strict, oldPath);
    if (oldPath === newPath) {
      tree.now.set(oldPath, joinFile(out));
    } else {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(out));
      tree.moves.push([oldPath, newPath]);
    }
  };
}

// ---------------------------------------------------------- search/replace

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let sep = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    let rep = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldL = lines.slice(searchAt + 1, sep);
    const newL = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldL, newL, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    tree.requireSafe(path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinCreated(newL, true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldL, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const built = buildNew(model.lines, pos, oldL, plainItems(oldL, newL), found.tier);
    const lines = [...model.lines];
    lines.splice(pos, oldL.length, ...built);
    tree.now.set(path, joinFile({ lines, br: model.br, finalBr: model.finalBr }));
  };
}

// -------------------------------------------------------------------- v4a

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  startLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: Chunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Raw {
    kind: V4aSection['kind'];
    path: string;
    startLine: number;
    body: Array<{ text: string; at: number }>;
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    let kind: V4aSection['kind'] | null = null;
    let p = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      p = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      p = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      p = l.slice(17).trim();
    }
    if (kind !== null) {
      cur = { kind, path: p, startLine: i + 1, body: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.body.push({ text: l, at: i + 1 });
  }
  return raws.map((raw) => v4aEdit(buildV4aSection(raw), strict));
}

function buildV4aSection(raw: { kind: V4aSection['kind']; path: string; startLine: number; body: Array<{ text: string; at: number }> }): V4aSection {
  const body = [...raw.body];
  // Blank lines at the end of a section are not part of it (SPEC.md section 8):
  // a blank line is empty or only whitespace, so a trailing ` ` context line goes too.
  while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
  const sec: V4aSection = { kind: raw.kind, path: raw.path, startLine: raw.startLine, moveTo: null, addLines: [], chunks: [] };
  if (raw.kind === 'add') {
    for (const b of body) {
      if (b.text.startsWith('+')) sec.addLines.push(b.text.slice(1));
      else if (b.text === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${b.at}`);
    }
    return sec;
  }
  if (raw.kind === 'del') {
    for (const b of body) {
      if (b.text !== '') throw new Exit2(`error: parse ${b.at}`);
    }
    return sec;
  }
  let idx = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
    sec.moveTo = body[0]!.text.slice(13).trim();
    idx = 1;
  }
  let chunk: Chunk | null = null;
  let afterEof = false;
  const pushChunk = (): void => {
    if (chunk !== null) sec.chunks.push(chunk);
    chunk = null;
  };
  for (; idx < body.length; idx += 1) {
    const b = body[idx]!;
    const l = b.text;
    if (l.startsWith('@@')) {
      pushChunk();
      const anchor = l.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      afterEof = false;
    } else if (l === '*** End of File') {
      if (chunk === null) chunk = { anchor: null, eof: false, items: [] };
      chunk.eof = true;
      pushChunk();
      afterEof = true;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (chunk === null) {
        if (afterEof || sec.chunks.length > 0) throw new Exit2(`error: parse ${b.at}`);
        chunk = { anchor: null, eof: false, items: [] };
      }
      const kind: Item['kind'] = l === '' || l[0] === ' ' ? 'c' : l[0] === '-' ? 'd' : 'a';
      chunk.items.push({ kind, text: l === '' ? '' : l.slice(1), oi: -1, noNl: false, rawEmpty: l === '' });
    } else {
      throw new Exit2(`error: parse ${b.at}`);
    }
  }
  pushChunk();
  let oi = 0;
  for (const ch of sec.chunks) {
    oi = 0;
    for (const it of ch.items) {
      if (it.kind !== 'a') {
        it.oi = oi;
        oi += 1;
      }
    }
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${raw.startLine}`);
  return sec;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    tree.requireSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinCreated(sec.addLines, true));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) tree.requireSafe(sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = splitFile(before);
    const lines = [...model.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineMatch(lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = oldLines(chunk.items);
      if (o.length === 0) {
        const adds = newItems(chunk.items).map((it) => it.text);
        const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
      } else {
        const found = findTier(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        const candidates = chunk.eof ? found.at.filter((p) => p + o.length === lines.length) : found.at;
        if (candidates.length === 0) throw new Fail('no-match', sec.path);
        const pos = candidates[0]!;
        const built = buildNew(lines, pos, o, chunk.items, found.tier);
        lines.splice(pos, o.length, ...built);
        cursor = pos + built.length;
      }
    }
    const text = joinFile({ lines, br: model.br, finalBr: model.finalBr });
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

// ------------------------------------------------------------------- json

function jsonEditOf(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      tree.requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = tree.requireFile(p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = tree.requireFile(p);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      const lines = [...model.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: model.br, finalBr: model.finalBr }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEditOf(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// -------------------------------------------------------------------- cli

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
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
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Exit2) return { code: 2, out: [e.line] };
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.push(p);
  }
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (used.has(oldP) || used.has(newP)) continue;
    if (!changed.includes(oldP) || !changed.includes(newP)) continue;
    if (tree.original(oldP) === null || tree.now.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.now.get(newP) === null) continue;
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    used.add(oldP);
    used.add(newP);
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: runner.ts reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
