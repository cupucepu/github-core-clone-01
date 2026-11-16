// rest.ts — the REST v3 API: repositories, branches, commits, contents,
// labels, issues, comments, pull requests and merges, plus the API root,
// /meta and the protocol surface (JSON bodies, request ids, error shapes).
// All state lives in the store, shared with git/GraphQL/MCP.

import { type Issue, type Pull, type Repo, type Store, VIEWER } from './store.ts';
import {
  buildTreeFromFiles,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './gitobjects.ts';

export interface RestContext {
  store: Store;
  /** origin of this request, e.g. http://127.0.0.1:PORT (for Link headers + URLs) */
  baseUrl: string;
  authorized: boolean;
}

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ZERO_OID = '0'.repeat(40);

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResult {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: userNodeId() },
    private: repo.privateRepo,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoNow(),
    updated_at: isoNow(),
    pushed_at: isoNow(),
    git_url: `git://${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.privateRepo ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function userNodeId(): string {
  return Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url');
}

function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: Buffer.from(`Issue:${repo.databaseId}:${issue.number}`, 'utf8').toString('base64url'),
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: isoNow(),
    updated_at: isoNow(),
    closed_at: issue.state === 'closed' ? isoNow() : null,
    author_association: 'OWNER',
  };
}

function labelJson(_repo: Repo, name: string): Record<string, unknown> {
  return {
    id: 0,
    node_id: Buffer.from(`Label:${name}`, 'utf8').toString('base64url'),
    url: '',
    name,
    color: 'ffffff',
    default: false,
    description: null,
  };
}

function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: Buffer.from(`PullRequest:${repo.databaseId}:${pull.number}`, 'utf8').toString('base64url'),
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: { login: VIEWER.login, id: VIEWER.id },
      repo: repoJson(repo, baseUrl),
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: { login: VIEWER.login, id: VIEWER.id },
      repo: repoJson(repo, baseUrl),
    },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    mergeable_state: pull.merged ? 'merged' : pullMergeable(repo, pull) ? 'clean' : 'dirty',
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    closed_at: pull.state === 'closed' ? isoNow() : null,
    comments: pull.comments.length,
  };
}

// ---------------------------------------------------------------- git helpers

/** The flat file map of a commit: path -> {mode, content}. */
function filesOfCommit(repo: Repo, commitOid: string): Map<string, { mode: string; content: Buffer }> {
  const files = new Map<string, { mode: string; content: Buffer }>();
  const treeOid = repo.treeOfCommit(commitOid);
  if (!treeOid) return files;
  const flat = new Map<string, TreeEntry>();
  flattenTree(repo.objects, treeOid, '', flat);
  for (const [path, entry] of flat) {
    const obj = repo.objects.get(entry.oid);
    if (obj && obj.type === 'blob') files.set(path, { mode: entry.mode, content: obj.data });
  }
  return files;
}

/** Commit a new file map on `branch` (or create the branch). Returns the commit oid. */
function commitFiles(repo: Repo, branch: string, files: Map<string, { mode: string; content: Buffer }>, message: string): string {
  const treeOid = buildTreeFromFiles(repo.objects, files);
  const parent = repo.resolveRef(`refs/heads/${branch}`);
  const parents = parent ? [parent] : [];
  const commitOid = repo.createCommit(treeOid, parents, message);
  repo.setRef(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

function walkCommits(repo: Repo, start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  // Depth-first from the tip: children come before their parents (newest first).
  return out;
}

/** Line counts for a blob's content (for the pull-files change counts). */
function lineCount(content: Buffer): number {
  const text = content.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffFiles(
  repo: Repo,
  baseCommit: string | null,
  headCommit: string,
): FileDiff[] {
  const baseFiles = baseCommit ? filesOfCommit(repo, baseCommit) : new Map();
  const headFiles = filesOfCommit(repo, headCommit);
  const diffs: FileDiff[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && !head) {
      const deletions = lineCount(base.content);
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!base && head) {
      const additions = lineCount(head.content);
      diffs.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base && head && !base.content.equals(head.content)) {
      // line-level diff is overkill for the suite; count added/removed lines
      // by comparing the two contents' line sets approximately.
      const baseLines = base.content.toString('utf8').split('\n');
      const headLines = head.content.toString('utf8').split('\n');
      const baseSet = new Map<string, number>();
      for (const line of baseLines) baseSet.set(line, (baseSet.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of headLines) {
        const remaining = baseSet.get(line) ?? 0;
        if (remaining > 0) baseSet.set(line, remaining - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const remaining of baseSet.values()) deletions += remaining;
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/** Three-way file merge: head's changes onto base, against their merge-base. */
export function mergeTrees(
  repo: Repo,
  baseCommit: string,
  headCommit: string,
  mergeBaseCommit: string,
): { files: Map<string, { mode: string; content: Buffer }>; conflict: string | null } {
  const baseFiles = filesOfCommit(repo, baseCommit);
  const headFiles = filesOfCommit(repo, headCommit);
  const ancestorFiles = filesOfCommit(repo, mergeBaseCommit);
  const merged = new Map<string, { mode: string; content: Buffer }>();
  let conflict: string | null = null;
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    const ancestor = ancestorFiles.get(path);
    const baseChanged = !sameFile(base, ancestor);
    const headChanged = !sameFile(head, ancestor);
    if (!baseChanged && !headChanged) {
      if (ancestor) merged.set(path, ancestor);
    } else if (headChanged && !baseChanged) {
      if (head) merged.set(path, head);
    } else if (baseChanged && !headChanged) {
      if (base) merged.set(path, base);
    } else {
      // both changed
      if (sameFile(base, head)) {
        if (base) merged.set(path, base);
      } else {
        conflict = path;
      }
    }
  }
  return { files: merged, conflict };
}

function sameFile(
  a: { mode: string; content: Buffer } | undefined,
  b: { mode: string; content: Buffer } | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode && a.content.equals(b.content);
}

/** Is the pull mergeable right now (no conflict between head and base)? */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const headSha = repo.resolveRef(`refs/heads/${pull.head.ref}`);
  const baseSha = repo.resolveRef(`refs/heads/${pull.base.ref}`);
  if (!headSha || !baseSha) return false;
  const base = mergeBase(repo.objects, headSha, baseSha);
  if (base === null) return headSha === baseSha;
  const { conflict } = mergeTrees(repo, baseSha, headSha, base);
  return conflict === null;
}

// ---------------------------------------------------------------- routing

interface RouteMatch {
  owner: string;
  repoName: string;
  rest: string[];
}

function matchRepoPath(pathname: string): RouteMatch | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  // /api/v3/repos/{owner}/{repo}/...
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos') {
    return {
      owner: decodeURIComponent(parts[3]),
      repoName: decodeURIComponent(parts[4]),
      rest: parts.slice(5).map((p) => decodeURIComponent(p)),
    };
  }
  return null;
}

/** Parse a JSON body; returns null when the body is empty, throws on malformed JSON. */
function parseJsonBody(body: Buffer | null): Record<string, unknown> | null {
  if (body === null || body.length === 0) return null;
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function handleRest(
  ctx: RestContext,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: Buffer | null,
): RestResult {
  const { store, baseUrl } = ctx;
  // API root and meta are public; everything else needs the token.
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    return json(200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: `${baseUrl}/settings/applications`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      code_search_url: `${baseUrl}/api/v3/search/code?q={query}`,
      commit_search_url: `${baseUrl}/api/v3/search/commits?q={query}`,
      emails_url: `${baseUrl}/api/v3/user/emails`,
      emojis_url: `${baseUrl}/api/v3/emojis`,
      events_url: `${baseUrl}/api/v3/events`,
      feeds_url: `${baseUrl}/api/v3/feeds`,
      followers_url: `${baseUrl}/api/v3/user/followers`,
      following_url: `${baseUrl}/api/v3/user/following{/other_user}`,
      gists_url: `${baseUrl}/api/v3/gists{/gist_id}`,
      hub_url: `${baseUrl}/api/v3/hub`,
      issue_search_url: `${baseUrl}/api/v3/search/issues?q={query}`,
      issues_url: `${baseUrl}/api/v3/issues`,
      keys_url: `${baseUrl}/api/v3/user/keys`,
      label_search_url: `${baseUrl}/api/v3/search/labels?repository_id={repository_id}&q={query}`,
      notifications_url: `${baseUrl}/api/v3/notifications`,
      organization_url: `${baseUrl}/api/v3/orgs/{org}`,
      organization_repositories_url: `${baseUrl}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${baseUrl}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${baseUrl}/api/v3/gists/public`,
      rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${baseUrl}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${baseUrl}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${baseUrl}/api/v3/gists/starred`,
      topic_search_url: `${baseUrl}/api/v3/search/topics?q={query}`,
      user_url: `${baseUrl}/api/v3/users/{user}`,
      user_organizations_url: `${baseUrl}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
      user_search_url: `${baseUrl}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && pathname === '/api/v3/meta') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (!ctx.authorized) {
    return err(401, 'Requires authentication');
  }
  let parsedBody: Record<string, unknown> | null = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    try {
      parsedBody = parseJsonBody(body);
    } catch {
      return err(400, 'Problems parsing JSON');
    }
  }
  const b = parsedBody ?? {};

  // GET /user
  if (method === 'GET' && pathname === '/api/v3/user') {
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: userNodeId(),
      avatar_url: '',
      gravatar_id: '',
      url: `${baseUrl}/api/v3/users/${VIEWER.login}`,
      html_url: `${baseUrl}/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
      name: VIEWER.name,
      company: null,
      blog: '',
      location: null,
      email: VIEWER.email,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: store.listRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: isoNow(),
      updated_at: isoNow(),
    });
  }

  // POST /user/repos + GET /user/repos
  if (pathname === '/api/v3/user/repos') {
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') return err(400, 'name is required');
      const repo = store.createRepo(name, {
        description: typeof b.description === 'string' ? b.description : undefined,
        privateRepo: b.private === true,
      });
      if (repo === null) return err(422, 'already exists');
      return json(201, repoJson(repo, baseUrl));
    }
    if (method === 'GET') {
      const perPage = queryInt(query, 'per_page', 30);
      const page = queryInt(query, 'page', 1);
      const all = store.listRepos();
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const links: string[] = [];
      if (page < totalPages) {
        links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      }
      if (totalPages > 1) {
        links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}>; rel="last"`);
        links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
      }
      if (links.length > 0) headers.link = links.join(', ');
      return json(200, slice.map((repo) => repoJson(repo, baseUrl)), headers);
    }
  }

  // /repos/{owner}/{repo}/...
  const match = matchRepoPath(pathname);
  if (match !== null) {
    const repo = store.getRepo(match.owner, match.repoName);
    if (!repo) return err(404, 'Not Found');
    return handleRepoRoute(ctx, repo, method, match.rest, query, b);
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(
  ctx: RestContext,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestResult {
  const { baseUrl } = ctx;
  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo, baseUrl));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateRepo = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      return json(200, repoJson(repo, baseUrl));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.name);
      return { status: 204, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(0) };
    }
    return err(404, 'Not Found');
  }
  const head = rest[0];

  // branches
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(name), url: '' },
          protected: false,
        }));
      return json(200, branches);
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = repo.resolveRef(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Branch not found');
      return json(200, { name: branch, commit: { sha, url: '' }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // commits
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const refParam = query.get('sha');
      const start = refParam ? repo.resolveRef(refParam) ?? (repo.objects.has(refParam) ? refParam : undefined) : repo.resolveRef('HEAD');
      if (start === undefined) return json(200, []);
      const commits = walkCommits(repo, start).map((oid) => {
        const info = parseCommit(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
        return {
          sha: oid,
          node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64url'),
          commit: {
            message: info.message,
            author: { name: VIEWER.login, email: VIEWER.email, date: isoNow() },
            committer: { name: VIEWER.login, email: VIEWER.email, date: isoNow() },
            tree: { sha: info.tree },
          },
          parents: info.parents.map((p) => ({ sha: p })),
          url: '',
        };
      });
      return json(200, commits);
    }
    return err(404, 'Not Found');
  }

  // git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.setRef(ref, sha);
      return json(201, {
        ref,
        node_id: Buffer.from(`Ref:${repo.databaseId}:${ref}`, 'utf8').toString('base64url'),
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
      });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return json(200, {
        ref,
        node_id: Buffer.from(`Ref:${repo.databaseId}:${ref}`, 'utf8').toString('base64url'),
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
      });
    }
    return err(404, 'Not Found');
  }

  // contents
  if (head === 'contents') {
    return handleContents(ctx, repo, method, rest.slice(1).join('/'), query, body);
  }

  // labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ffffff';
      if (name === '') return err(400, 'name is required');
      if (repo.labels.some((l) => l.name === name)) return err(422, 'already exists');
      repo.labels.push({ name, color });
      return json(201, { ...labelJson(repo, name), color, id: repo.labels.length });
    }
    return err(404, 'Not Found');
  }

  // issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, method, rest.slice(1), query, body);
  }

  // pulls
  if (head === 'pulls') {
    return handlePulls(ctx, repo, method, rest.slice(1), query, body);
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContents(
  ctx: RestContext,
  repo: Repo,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestResult {
  const { baseUrl } = ctx;
  const refParam = query.get('ref') ?? (typeof body.branch === 'string' ? body.branch : undefined);
  const branch = refParam ?? repo.defaultBranch;
  const tip = repo.resolveRef(`refs/heads/${branch}`) ?? (repo.objects.has(branch) ? branch : undefined);

  if (method === 'GET') {
    if (tip === undefined) return err(404, 'Not Found');
    const treeOid = repo.treeOfCommit(tip);
    if (treeOid === null) return err(404, 'Not Found');
    if (path === '') {
      // root directory
      const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)).map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.name}`,
      }));
      return json(200, entries);
    }
    const flat = new Map<string, TreeEntry>();
    flattenTree(repo.objects, treeOid, '', flat);
    const file = flat.get(path);
    if (file) {
      const obj = repo.objects.get(file.oid);
      if (!obj) return err(404, 'Not Found');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: path.split('/').pop(),
        path,
        content: obj.data.toString('base64'),
        sha: file.oid,
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    // directory?
    const prefix = `${path}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({
          type: 'file',
          name: rest,
          path: filePath,
          sha: entry.oid,
          size: repo.objects.get(entry.oid)?.data.length ?? 0,
          url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          // the dir's tree oid: walk the tree for the subdir
          const dirPath = `${path}/${dirName}`;
          const dirTree = findTreeOid(repo, treeOid, dirPath);
          entries.push({
            type: 'dir',
            name: dirName,
            path: dirPath,
            sha: dirTree ?? ZERO_OID,
            size: 0,
            url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${dirPath}`,
          });
        }
      }
    }
    if (entries.length === 0) return err(404, 'Not Found');
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, entries);
  }

  if (method === 'PUT') {
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (contentB64 === '') return err(400, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    } catch {
      return err(400, 'content is not valid base64');
    }
    const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
    const files = tip ? filesOfCommit(repo, tip) : new Map<string, { mode: string; content: Buffer }>();
    const existing = files.get(path);
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (sha === undefined) return err(422, 'sha wasn\'t supplied');
      const { oid } = hashObject('blob', existing.content);
      if (sha.toLowerCase() !== oid.toLowerCase()) return err(409, 'sha does not match');
    } else if (sha !== undefined) {
      return err(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    }
    files.set(path, { mode: '100644', content });
    const commitOid = commitFiles(repo, branch, files, message);
    const { oid: blobOid } = hashObject('blob', content);
    const status = existing ? 200 : 201;
    return json(status, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        type: 'file',
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: commitOid, message, url: '' },
    });
  }

  if (method === 'DELETE') {
    if (tip === undefined) return err(404, 'Not Found');
    const files = filesOfCommit(repo, tip);
    const existing = files.get(path);
    if (!existing) return err(404, 'Not Found');
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (sha !== undefined) {
      const { oid } = hashObject('blob', existing.content);
      if (sha.toLowerCase() !== oid.toLowerCase()) return err(409, 'sha does not match');
    }
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    files.delete(path);
    const commitOid = commitFiles(repo, branch, files, message);
    return json(200, {
      content: null,
      commit: { sha: commitOid, message, url: '' },
    });
  }

  return err(404, 'Not Found');
}

/** The tree oid for a directory path inside a tree, or null. */
function findTreeOid(repo: Repo, rootTreeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/');
  let current = rootTreeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- issues

function handleIssues(
  ctx: RestContext,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestResult {
  const { baseUrl } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return err(400, 'title is required');
      const labels: string[] = Array.isArray(body.labels)
        ? body.labels.filter((l): l is string => typeof l === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.some((l) => l.name === label)) return err(422, `Label does not exist: ${label}`);
      }
      const issue: Issue = {
        number: repo.nextNumber(),
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        createdSeq: repo.nextSeq(),
        comments: [],
      };
      repo.issues.push(issue);
      return json(201, issueJson(repo, issue, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const perPage = queryInt(query, 'per_page', 30);
      const page = queryInt(query, 'page', 1);
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((i) => issueJson(repo, i, baseUrl)));
    }
    return err(404, 'Not Found');
  }
  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issueByNumber(number);
  if (rest.length === 1) {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') return json(200, issueJson(repo, issue, baseUrl));
    if (method === 'PATCH') {
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return json(200, issueJson(repo, issue, baseUrl));
    }
    return err(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (!issue) return err(404, 'Not Found');
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return err(400, 'body is required');
      const comment = { id: repo.nextCommentId(), body: text, createdSeq: repo.nextSeq() };
      issue.comments.push(comment);
      return json(201, {
        id: comment.id,
        node_id: Buffer.from(`IssueComment:${repo.databaseId}:${comment.id}`, 'utf8').toString('base64url'),
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        body: text,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        created_at: isoNow(),
        updated_at: isoNow(),
      });
    }
    if (method === 'GET') {
      return json(200, issue.comments.map((c) => ({
        id: c.id,
        node_id: Buffer.from(`IssueComment:${repo.databaseId}:${c.id}`, 'utf8').toString('base64url'),
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
        body: c.body,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        created_at: isoNow(),
        updated_at: isoNow(),
      })));
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(
  ctx: RestContext,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestResult {
  const { baseUrl } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') return err(400, 'title, head and base are required');
      const headSha = repo.resolveRef(`refs/heads/${head}`);
      const baseSha = repo.resolveRef(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      if (head === base) return err(422, 'head and base must differ');
      const pull: Pull = {
        number: repo.nextNumber(),
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        createdSeq: repo.nextSeq(),
        comments: [],
      };
      repo.pulls.push(pull);
      return json(201, pullJson(repo, pull, baseUrl));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const perPage = queryInt(query, 'per_page', 30);
      const page = queryInt(query, 'page', 1);
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((p) => pullJson(repo, p, baseUrl)));
    }
    return err(404, 'Not Found');
  }
  const number = parseInt(rest[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pullByNumber(number);
  if (rest.length === 1) {
    if (!pull) return err(404, 'Not Found');
    if (method === 'GET') return json(200, pullJson(repo, pull, baseUrl));
    return err(404, 'Not Found');
  }
  if (rest[1] === 'files' && method === 'GET') {
    if (!pull) return err(404, 'Not Found');
    const base = mergeBase(repo.objects, pull.headShaAtCreate, pull.baseShaAtCreate);
    const diffs = diffFiles(repo, base, pull.headShaAtCreate);
    return json(200, diffs.map((d) => ({
      sha: '',
      filename: d.filename,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    })));
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return err(404, 'Not Found');
    if (pull.merged) return err(405, 'Pull Request is already merged');
    if (pull.state !== 'open') return err(405, 'Pull Request is not open');
    const headSha = repo.resolveRef(`refs/heads/${pull.head.ref}`);
    const baseSha = repo.resolveRef(`refs/heads/${pull.base.ref}`);
    if (headSha === undefined || baseSha === undefined) return err(404, 'Branch not found');
    const base = mergeBase(repo.objects, headSha, baseSha);
    if (base === null) return err(405, 'No merge base');
    const { files, conflict } = mergeTrees(repo, baseSha, headSha, base);
    if (conflict !== null) return err(405, `Merge conflict in ${conflict}`);
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const commitOid = repo.createCommit(treeOid, [baseSha], message);
    repo.setRef(`refs/heads/${pull.base.ref}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = isoNow();
    pull.merge_commit_sha = commitOid;
    return json(200, {
      sha: commitOid,
      merged: true,
      message: mergeMethod === 'squash' ? `Squashed ${pull.number} into ${pull.base.ref}` : message,
    });
  }
  return err(404, 'Not Found');
}
