// store.ts — the forge's in-memory store. One process, one store: repositories
// (with their git objects + refs) and the REST/GraphQL/MCP resources that
// read and write the same data, so every surface sees the same state.

import { hashObject, parseCommit, type GitObject } from './gitobjects.ts';

/** The viewer: the token's login. Deterministic from the suite's constant seed. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  createdSeq: number;
  comments: Comment[];
}

export class Repo {
  readonly databaseId: number;
  readonly name: string;
  readonly owner: string = VIEWER.login;
  description: string = '';
  privateRepo: boolean = false;
  defaultBranch: string = 'main';
  /** git objects by oid */
  readonly objects = new Map<string, GitObject>();
  /** refs by full name, e.g. refs/heads/main -> oid */
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels: Label[] = [];
  numberCounter: number = 1; // issues and PRs share one counter, GitHub-correct
  commentCounter: number = 1;
  seq: number = 1; // monotonic creation order within this repo
  /** cache of generated packfiles, keyed by the fetch request that made them */
  readonly packCache = new Map<string, Buffer>();

  constructor(databaseId: number, name: string) {
    this.databaseId = databaseId;
    this.name = name;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get globalId(): string {
    return Buffer.from(`Repository:${this.databaseId}`, 'utf8').toString('base64url');
  }

  resolveRef(ref: string): string | undefined {
    if (ref === 'HEAD') return this.refs.get(`refs/heads/${this.defaultBranch}`);
    if (ref.startsWith('refs/')) return this.refs.get(ref);
    return this.refs.get(`refs/heads/${ref}`);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.packCache.clear();
  }

  deleteRef(ref: string): boolean {
    const deleted = this.refs.delete(ref);
    if (deleted) this.packCache.clear();
    return deleted;
  }

  storeObject(type: GitObject['type'], data: Buffer): string {
    const { oid } = hashObject(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit object for `tree` with `parents` and return its oid. */
  createCommit(tree: string, parents: string[], message: string): string {
    const now = Math.floor(Date.now() / 1000);
    const identity = `${VIEWER.login} <${VIEWER.email}> ${now} +0000`;
    const lines: string[] = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${identity}`, `committer ${identity}`, '', message);
    const data = Buffer.from(lines.join('\n'), 'utf8');
    return this.storeObject('commit', data);
  }

  treeOfCommit(commitOid: string): string | null {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  issueByNumber(number: number): Issue | undefined {
    return this.issues.find((i) => i.number === number);
  }

  pullByNumber(number: number): Pull | undefined {
    return this.pulls.find((p) => p.number === number);
  }

  /** Find an issue or a PR by shared number. */
  itemByNumber(number: number): Issue | Pull | undefined {
    return this.issueByNumber(number) ?? this.pullByNumber(number);
  }

  nextNumber(): number {
    const n = this.numberCounter;
    this.numberCounter += 1;
    return n;
  }

  nextCommentId(): number {
    const n = this.commentCounter;
    this.commentCounter += 1;
    return n;
  }

  nextSeq(): number {
    const n = this.seq;
    this.seq += 1;
    return n;
  }
}

export class Store {
  private reposByName = new Map<string, Repo>();
  private nextRepoId = 1;

  /** A repo exists only under the viewer's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.reposByName.get(name);
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()];
  }

  createRepo(name: string, opts: { description?: string; privateRepo?: boolean }): Repo | null {
    if (this.reposByName.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name);
    this.nextRepoId += 1;
    repo.description = opts.description ?? '';
    repo.privateRepo = opts.privateRepo ?? false;
    this.reposByName.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.reposByName.delete(name);
  }
}

/** The opaque global id for an issue, PR or comment. Stable across reads. */
export function globalId(kind: 'Issue' | 'PullRequest' | 'IssueComment', repo: Repo, number: number): string {
  return Buffer.from(`${kind}:${repo.databaseId}:${number}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its parts, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; repoDbId: number; number: number | null } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length === 2 && parts[0] === 'Repository') {
      const repoDbId = Number(parts[1]);
      if (!Number.isInteger(repoDbId)) return null;
      return { kind: parts[0], repoDbId, number: null };
    }
    if (parts.length !== 3) return null;
    const repoDbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(repoDbId) || !Number.isInteger(number)) return null;
    return { kind: parts[0], repoDbId, number };
  } catch {
    return null;
  }
}
