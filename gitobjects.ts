// gitobjects.ts — the git object model: SHA-1 objects, trees, commits,
// packfiles (read/write, plain + OFS/REF deltas) and the pkt-line codec.
// No dependency on the store or the HTTP layer: pure functions over Buffers.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Hash an object the way git does: "<type> <len>\0<data>". Returns oid + raw bytes. */
export function hashObject(type: ObjectType, data: Buffer): { oid: string; raw: Buffer } {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  const raw = Buffer.concat([header, data]);
  return { oid: sha1Hex(raw), raw };
}

/** Split a stored object's raw bytes into type + payload. */
export function parseObject(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('ascii');
  const space = header.indexOf(' ');
  const type = header.slice(0, space) as ObjectType;
  return { type, data: Buffer.from(raw.subarray(nul + 1)) };
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  let currentKey = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ') && currentKey === 'gpgsig') continue; // continuation of a signature
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    currentKey = key;
    if (key === 'tree') info.tree = value;
    else if (key === 'parent') info.parents.push(value);
    else if (key === 'author') info.author = value;
    else if (key === 'committer') info.committer = value;
  }
  return info;
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** The identity line git writes for commits the forge creates itself. */
export function forgeIdentity(nowSeconds: number): string {
  return `adaiversen <adaiversen@example.invalid> ${nowSeconds} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. '100644' or '40000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // git sorts directory entries as if their name had a trailing '/'
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(objects, entry.oid, path, out);
    } else {
      out.set(path, entry);
    }
  }
}

/** Build (and store) a tree for a flat path -> {mode, content} map. Returns the root tree oid. */
export function buildTreeFromFiles(
  objects: Map<string, GitObject>,
  files: Map<string, { mode: string; content: Buffer }>,
): string {
  // Group files by directory, bottom-up.
  interface DirNode {
    files: Map<string, { mode: string; content: Buffer }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const storeTree = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) {
      const { oid } = hashObject('blob', file.content);
      objects.set(oid, { type: 'blob', data: file.content });
      entries.push({ mode: file.mode, name, oid });
    }
    for (const [name, child] of node.dirs) {
      const oid = storeTree(child);
      entries.push({ mode: '40000', name, oid });
    }
    const data = buildTree(entries);
    const { oid } = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return storeTree(root);
}

/** The blob oid for a file at `path` in the tree `treeOid`, or null. */
export function blobAtPath(objects: Map<string, GitObject>, treeOid: string, path: string): TreeEntry | null {
  const flat = new Map<string, TreeEntry>();
  flattenTree(objects, treeOid, '', flat);
  return flat.get(path) ?? null;
}

// ---------------------------------------------------------------- deltas

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while (buf[offset] & 0x80) {
    value |= (buf[pos] & 0x7f) << shift;
    shift += 7;
    offset = pos;
    pos += 1;
  }
  return { value, next: pos };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const srcSize = readVarint(delta, 0);
  if (srcSize.value !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint(delta, srcSize.next);
  let pos = dstSize.next;
  const chunks: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      // copy from base: offset/size are little-endian bit fields
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== dstSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks, outLen);
}

// ---------------------------------------------------------------- packfiles

/** Fallback for inflateAt: find the exact length of the zlib stream starting at `start` by probing. */
function zlibStreamLength(buf: Buffer, start: number): number {
  let lo = 1;
  let hi = buf.length - start;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Inflate one zlib stream starting at `start`; returns its bytes and the offset just past the
 * stream. One inflate tells us both: with {info:true} Node reports engine.bytesWritten, the
 * compressed bytes the stream consumed, so there is no need to probe for the stream's length.
 * The old binary search re-inflated every object ~log2(n) times and threw on every short
 * probe — exception throws are the slow part, and pack parsing was the push workload's main
 * cost. Falls back to the probe when bytesWritten is unavailable, so behaviour is unchanged
 * on a runtime that does not report it.
 */
function inflateAt(buf: Buffer, start: number): { data: Buffer; next: number } {
  const view = buf.subarray(start);
  try {
    const result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const written = result.engine?.bytesWritten;
    if (written && written > 0) return { data: result.buffer, next: start + written };
  } catch {
    // fall through to the probe below
  }
  const streamLen = zlibStreamLength(buf, start);
  return { data: inflateSync(buf.subarray(start, start + streamLen)), next: start + streamLen };
}

const PACK_TYPE_NAMES: Record<number, ObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/**
 * Parse a packfile into objects. Supports plain objects and OFS/REF deltas.
 * Returns the objects in pack order, each with its oid.
 */
export function parsePack(buf: Buffer): Array<GitObject & { oid: string }> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: Array<GitObject & { oid: string }> = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const objStart = pos;
    // varint header: first byte holds type (bits 4-6) + size low 4 bits
    let byte = buf[pos];
    pos += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeNum === 6) {
      // OFS_DELTA: offset is a variable-length encoding
      byte = buf[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = objStart - offset;
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data: inflated, next } = inflateAt(buf, pos);
    pos = next;
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    let obj: GitObject;
    if (typeNum === 6 || typeNum === 7) {
      const base = baseOffset >= 0 ? byOffset.get(baseOffset) : baseOid !== null ? byOid.get(baseOid) : undefined;
      if (!base) throw new Error('delta base not found in pack');
      const data = applyDelta(base.data, inflated);
      obj = { type: base.type, data };
    } else {
      const type = PACK_TYPE_NAMES[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      obj = { type, data: Buffer.from(inflated) };
    }
    const { oid } = hashObject(obj.type, obj.data);
    objects.push({ ...obj, oid });
    byOffset.set(objStart, obj);
    byOid.set(oid, obj);
  }
  return objects;
}

/** Serialize objects as a plain (no-delta) packfile, level-1 deflate for speed. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    // varint header: type in bits 4-6, size in low bits
    let size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

export const FLUSH_PACKET = Buffer.from('0000', 'ascii');

/** Encode one pkt-line. `data` may be a string or raw bytes. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function flushPacket(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export interface PktLine {
  type: 'data';
  data: Buffer;
}

export interface PktFlush {
  type: 'flush';
}

export interface PktDelim {
  type: 'delim';
}

/** Parse pkt-lines from the start of a buffer. Returns lines + the offset after the last one. */
export function parsePktLines(buf: Buffer): { lines: Array<PktLine | PktFlush | PktDelim>; offset: number } {
  const lines: Array<PktLine | PktFlush | PktDelim> = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length ${lenHex}`);
    if (len === 0) {
      lines.push({ type: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ type: 'delim' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line overruns buffer');
    lines.push({ type: 'data', data: Buffer.from(buf.subarray(pos + 4, pos + len)) });
    pos += len;
  }
  return { lines, offset: pos };
}

// ---------------------------------------------------------------- graph

/** All object ids reachable from `tips`, excluding anything reachable from `excludeTips`. */
export function reachableObjects(
  objects: Map<string, GitObject>,
  tips: string[],
  excludeTips: string[],
): Set<string> {
  const excluded = new Set<string>();
  const walk = (start: string[], seen: Set<string>, visit: (oid: string, obj: GitObject) => void): void => {
    const stack = [...start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = objects.get(oid);
      if (!obj) continue;
      visit(oid, obj);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        if (info.tree) stack.push(info.tree);
        for (const p of info.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        // tag object: first line is "object <oid>"
        const first = obj.data.toString('ascii').split('\n')[0];
        if (first.startsWith('object ')) stack.push(first.slice(7).trim());
      }
    }
  };
  walk(excludeTips, excluded, () => undefined);
  const found = new Set<string>();
  walk(tips, found, () => undefined);
  for (const oid of excluded) found.delete(oid);
  return found;
}

/** The merge-base of two commits: the newest common ancestor (by BFS from both). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = new Map<string, number>(); // oid -> distance
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift() as [string, number];
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, dist);
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queueA.push([p, dist + 1]);
    }
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Infinity;
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distA = ancestorsA.get(oid);
    if (distA !== undefined) {
      const score = distA + dist;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queueB.push([p, dist + 1]);
    }
  }
  return best;
}

/** Does `ancestor` appear in the history of `tip` (including equality)? */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
  }
  return false;
}
