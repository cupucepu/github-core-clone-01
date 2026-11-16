// mcp.ts — Model Context Protocol over streamable HTTP (JSON-RPC 2.0):
// the modern 2026-07-28 era (`server/discover`, no handshake, no session)
// plus the legacy `initialize` + `notifications/initialized` fallback,
// `tools/list` and `tools/call` for the six forge tools. Every tool acts on
// the same store as REST, so MCP and REST see the same objects.

import { type Issue, type Pull, type Repo, type Store, VIEWER } from './store.ts';
import { buildTreeFromFiles, mergeBase } from './gitobjects.ts';
import { mergeTrees } from './rest.ts';

export interface McpContext {
  store: Store;
  baseUrl: string;
  authorized: boolean;
}

export interface McpResult {
  status: number;
  body: Buffer;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8') };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error }), 'utf8') };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    private: repo.privateRepo,
    description: repo.description,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
  };
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
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
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
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: string } {
  const headSha = repo.resolveRef(`refs/heads/${pull.head.ref}`);
  const baseSha = repo.resolveRef(`refs/heads/${pull.base.ref}`);
  if (headSha === undefined || baseSha === undefined) return { error: 'branch not found' };
  const base = mergeBase(repo.objects, headSha, baseSha);
  if (base === null) return { error: 'no merge base' };
  const { files, conflict } = mergeTrees(repo, baseSha, headSha, base);
  if (conflict !== null) return { error: `merge conflict in ${conflict}` };
  const treeOid = buildTreeFromFiles(repo.objects, files);
  const commitOid = repo.createCommit(treeOid, [baseSha], `Merge pull request #${pull.number} from ${pull.head.ref}`);
  repo.setRef(`refs/heads/${pull.base.ref}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = new Date().toISOString();
  pull.merge_commit_sha = commitOid;
  return { sha: commitOid };
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const { store, baseUrl } = ctx;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = TOOLS.find((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
  if (!tool) return toolError(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (tool.name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name.trim() : '';
    if (repoNameArg === '') return toolError('name is required');
    const repo = store.createRepo(repoNameArg, {
      description: typeof args.description === 'string' ? args.description : undefined,
      privateRepo: args.private === true,
    });
    if (repo === null) return toolError(`repository ${repoNameArg} already exists`);
    return toolResult(repoJson(repo, baseUrl));
  }
  const repo = store.getRepo(owner, repoName);
  if (tool.name === 'get_repo') {
    if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
    return toolResult(repoJson(repo, baseUrl));
  }
  if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
  if (tool.name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const issue: Issue = {
      number: repo.nextNumber(),
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      createdSeq: repo.nextSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue, baseUrl));
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return toolResult(list.map((issue) => issueJson(repo, issue, baseUrl)));
  }
  if (tool.name === 'create_pull_request') {
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    const headSha = repo.resolveRef(`refs/heads/${head}`);
    const baseSha = repo.resolveRef(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
    const pull: Pull = {
      number: repo.nextNumber(),
      title: typeof args.title === 'string' ? args.title : '',
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolResult(pullJson(repo, pull, baseUrl));
  }
  if (tool.name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pullByNumber(number);
    if (!pull) return toolError(`pull request #${number} not found`);
    if (pull.merged) return toolError('pull request is already merged');
    const merged = squashMerge(repo, pull);
    if ('error' in merged) return toolError(merged.error);
    return toolResult({ sha: merged.sha, merged: true, message: `Squashed ${pull.number} into ${pull.base.ref}` });
  }
  return toolError(`unknown tool ${name}`);
}

export function handleMcp(ctx: McpContext, body: Buffer | null): McpResult {
  if (!ctx.authorized) {
    return { status: 401, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
  }
  let request: unknown;
  try {
    request = JSON.parse(body === null ? '' : body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), 'utf8'),
    };
  }
  const req = request as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  // A notification (no id) gets no JSON-RPC answer.
  if (req.id === undefined) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (method === 'server/discover') {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const requested = typeof meta.protocolVersion === 'string' ? meta.protocolVersion : (typeof params.protocolVersion === 'string' ? params.protocolVersion : null);
    if (requested !== null && !SUPPORTED_VERSIONS.includes(requested)) {
      return rpcError(id, -32022, `Unsupported protocol version ${requested}`, { supported: SUPPORTED_VERSIONS });
    }
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const known = TOOLS.some((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
    if (!known) return rpcError(id, -32601, `Method not found: unknown tool ${name}`);
    const result = callTool(ctx, name, args);
    return rpcResult(id, result);
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
