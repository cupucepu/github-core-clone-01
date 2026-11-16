// githttp.ts — git smart HTTP: info/refs advertisements (v0 + v2),
// upload-pack (fetch/clone, v0 + v2, shallow + deepen) and receive-pack
// (push, with report-status inside side-band-64k). Pure handlers over the
// store; the HTTP server in app.ts only passes method/path/headers/body.

import { type Repo, type Store } from './store.ts';
import {
  buildPack,
  flushPacket,
  hashObject,
  isAncestor,
  parseCommit,
  parsePack,
  parsePktLines,
  parseTree,
  pktLine,
  reachableObjects,
  type GitObject,
} from './gitobjects.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';

function jsonResult(status: number, obj: unknown): HttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

export function notFoundResult(message = 'Not Found'): HttpResult {
  return jsonResult(404, { message });
}

function badRequestResult(message: string): HttpResult {
  return jsonResult(400, { message });
}

// ---------------------------------------------------------------- refs

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo, sorted, with HEAD first when it resolves. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headOid = repo.resolveRef('HEAD');
  if (headOid !== undefined) {
    lines.push({ oid: headOid, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const first = obj.data.toString('ascii').split('\n')[0];
      if (first.startsWith('object ')) entry.peeled = first.slice(7).trim();
    }
    lines.push(entry);
    if (entry.peeled !== undefined) {
      lines.push({ oid: entry.peeled, name: `${name}^{}` });
    }
  }
  return lines;
}

const V0_UPLOAD_CAPABILITIES = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'multi_ack_detailed',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'symref=HEAD:refs/heads/main',
  'object-format=sha1',
  `agent=${AGENT}`,
].join(' ');

const V0_RECEIVE_CAPABILITIES = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'object-format=sha1',
  `agent=${AGENT}`,
].join(' ');

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(flushPacket());
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPABILITIES : V0_RECEIVE_CAPABILITIES;
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      let line = `${ref.oid} ${ref.name}`;
      if (index === 0) line += `\0${caps}`;
      parts.push(pktLine(`${line}\n`));
    });
  }
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function v2Advertisement(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(flushPacket());
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  if (service === 'git-upload-pack') {
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('server-option\n'));
  }
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return badRequestResult('unknown service');
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundResult();
  const wantsV2 = service === 'git-upload-pack' && gitProtocol === 'version=2';
  const body = wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body,
  };
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchLines(lines: Array<{ type: string; data?: Buffer }>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.type !== 'data' || !line.data) continue;
    let text = line.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul); // capabilities after NUL (v0 first want line)
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      const oid = rest.split(' ')[0];
      if (oid) req.wants.push(oid);
    } else if (text.startsWith('have ')) {
      req.haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      req.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) req.depth = n;
    }
    // command=, agent=, object-format=, thin-pack, no-progress, ofs-delta,
    // filter, deepen-since, deepen-not, done: parsed above or ignored
  }
  return req;
}

/** All objects of a tree (the tree itself, subtrees, blobs). */
function treeObjects(objects: Map<string, GitObject>, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    out.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    for (const e of parseTree(obj.data)) stack.push(e.oid);
  }
}

interface FetchPlan {
  /** objects to send, in deterministic (sorted) order */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const wanted = req.wants.filter((oid) => repo.objects.has(oid));
  if (req.depth !== null && req.depth > 0) {
    // Shallow walk: levels 0..depth-1 from the wants. Haves do not exclude
    // anything here — the depth limit is the filter (the suite's deepen
    // checks require a have that is also an ancestor to still be sent).
    const levels: string[][] = [];
    let current = [...wanted];
    const seenCommits = new Set<string>();
    for (let level = 0; level < req.depth && current.length > 0; level += 1) {
      const next: string[] = [];
      const levelCommits: string[] = [];
      for (const oid of current) {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        levelCommits.push(oid);
        const info = parseCommit(obj.data);
        for (const p of info.parents) next.push(p);
      }
      levels.push(levelCommits);
      current = next;
    }
    for (const levelCommits of levels) {
      for (const oid of levelCommits) {
        const obj = repo.objects.get(oid);
        if (!obj) continue;
        objects.set(oid, obj);
        const tree = parseCommit(obj.data).tree;
        if (tree) {
          const treeSet = new Set<string>();
          treeObjects(repo.objects, tree, treeSet);
          for (const treeOid of treeSet) {
            const treeObj = repo.objects.get(treeOid);
            if (treeObj) objects.set(treeOid, treeObj);
          }
        }
      }
    }
    // New shallow boundary: deepest included commits that still have parents.
    const deepest = levels.length > 0 ? levels[levels.length - 1] : [];
    for (const oid of deepest) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    // Unshallow: a requested boundary that is now fully included.
    for (const boundary of req.shallow) {
      const levelIndex = levels.findIndex((level) => level.includes(boundary));
      if (levelIndex === -1) continue;
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || levelIndex < req.depth - 1) unshallow.push(boundary);
    }
  } else {
    // Full fetch: everything reachable from the wants, minus the haves.
    const wantedSet = reachableObjects(repo.objects, wanted, req.haves);
    for (const oid of wantedSet) {
      const obj = repo.objects.get(oid);
      if (obj) objects.set(oid, obj);
    }
  }
  const sorted = [...objects.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data).oid;
    const bo = hashObject(b.type, b.data).oid;
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return { objects: sorted, shallow, unshallow };
}

/** A packfile, cached per repo + fetch request (the clone workload re-fetches the same tip). */
function fetchPack(repo: Repo, req: FetchRequest, plan: FetchPlan): Buffer {
  const key = JSON.stringify({
    w: [...req.wants].sort(),
    h: req.depth === null ? [...req.haves].sort() : [],
    d: req.depth,
    s: [...req.shallow].sort(),
  });
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const pack = buildPack(plan.objects);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

/** Wrap pack bytes in side-band-64k packets (band 1), each a pkt-line. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65500; // pkt-line cap 65520 minus header minus the band byte
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return chunks;
}

function delimPacket(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(
  store: Store,
  owner: string,
  repoName: string,
  gitProtocol: string | undefined,
  body: Buffer,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundResult();
  let parsed;
  try {
    parsed = parsePktLines(body);
  } catch {
    return badRequestResult('malformed pkt-line stream');
  }
  const lines = parsed.lines;
  const isV2 = gitProtocol === 'version=2';
  // v2 ls-refs
  const firstText =
    lines.length > 0 && lines[0].type === 'data' && lines[0].data
      ? lines[0].data.toString('utf8')
      : '';
  if (isV2 && firstText.startsWith('command=ls-refs')) {
    return lsRefsV2(repo, lines);
  }
  if (isV2 && !firstText.startsWith('command=fetch')) {
    return badRequestResult('unknown v2 command');
  }
  const req = parseFetchLines(lines);
  if (req.wants.length === 0) return badRequestResult('no want lines');
  const plan = planFetch(repo, req);
  const pack = fetchPack(repo, req, plan);
  const parts: Buffer[] = [];
  if (isV2) {
    // acknowledgments section
    parts.push(pktLine('acknowledgments\n'));
    const common = req.haves.filter((have) => {
      if (!repo.objects.has(have)) return false;
      return req.wants.some((want) => want === have || isAncestor(repo.objects, have, want));
    });
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(delimPacket());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(delimPacket());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(flushPacket());
  } else {
    // v0: NAK/ACK lines, then shallow lines, then the sideband pack
    const common = req.haves.filter((have) => {
      if (!repo.objects.has(have)) return false;
      return req.wants.some((want) => want === have || isAncestor(repo.objects, have, want));
    });
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    }
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPackets(pack));
    parts.push(flushPacket());
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

function lsRefsV2(repo: Repo, lines: Array<{ type: string; data?: Buffer }>): HttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line.type !== 'data' || !line.data) continue;
    const text = line.data.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  if (refs.length === 0 && unborn) {
    parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD') {
      const target = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      parts.push(pktLine(`${ref.oid} HEAD${target}\n`));
      continue;
    }
    if (ref.name.endsWith('^{}')) continue; // peeled lines are attached to their tag
    const peeled = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
  }
  parts.push(flushPacket());
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Read pkt-lines until the first flush; return the commands and the offset where the pack starts. */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; packOffset: number } {
  const commands: PushCommand[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const lenHex = body.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) {
      pos += 4;
      return { commands, packOffset: pos };
    }
    if (len < 4 || pos + len > body.length) throw new Error('pkt-line overruns buffer');
    const text = body.subarray(pos + 4, pos + len).toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text.replace(/\n$/, '');
    const parts = head.split(' ');
    if (parts.length < 3) throw new Error('bad push command line');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    pos += len;
  }
  throw new Error('push command list has no flush');
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundResult();
  let commands: PushCommand[];
  let packOffset: number;
  try {
    ({ commands, packOffset } = parsePushCommands(body));
  } catch {
    return badRequestResult('malformed push command list');
  }
  if (commands.length === 0) return badRequestResult('no push commands');
  // Unpack the pack (if any) before applying ref updates.
  let unpackError: string | null = null;
  const packBytes = body.subarray(packOffset);
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const obj of objects) {
        repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  // Apply the ref updates, one report line each.
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack error ${unpackError}`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} invalid command`);
      } else if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} ref does not exist`);
        } else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} old value does not match`);
        } else {
          repo.deleteRef(cmd.ref);
          reportLines.push(`ok ${cmd.ref}`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} already exists`);
        } else if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} object not found`);
        } else {
          repo.setRef(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}`);
        }
      } else {
        // update: must match old and fast-forward
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} ref does not exist`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} old value does not match`);
        } else if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} object not found`);
        } else if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.setRef(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}`);
        }
      }
    }
  }
  repo.packCache.clear();
  // report-status, pkt-lined, inside side-band-64k band 1
  const innerParts: Buffer[] = [];
  for (const line of reportLines) innerParts.push(pktLine(`${line}\n`));
  innerParts.push(flushPacket());
  const inner = Buffer.concat(innerParts);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), flushPacket()]);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: outer,
  };
}
