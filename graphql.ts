// graphql.ts — a small GraphQL executor for the exact documents gh and
// github-mcp-server send: viewer/repository/node lookups, issue + pull-request
// connections (with cursor pagination), the create/close/merge/comment
// mutations, __type introspection and batching. No dependency beyond the
// store. Unknown fields answer HTTP 200 with an errors array naming them.

import { type Issue, type Pull, type Repo, type Store, VIEWER, globalId, parseGlobalId } from './store.ts';
import { diffFiles, mergeTrees, pullMergeable } from './rest.ts';
import { buildTreeFromFiles, mergeBase } from './gitobjects.ts';

// ---------------------------------------------------------------- parsing

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string;
  selections: Selection[];
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'punct'; value: string }
  | { type: 'variable'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (ch === '$') {
      let value = '';
      i += 1;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: 'variable', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let value = '';
      if (ch === '-') {
        value += '-';
        i += 1;
      }
      while (i < input.length && /[0-9.]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: 'int', value: Number(value) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: 'name', value });
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  private skipVariableDefinitions(): void {
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.type === 'punct' && token.value === '(') depth += 1;
        if (token.type === 'punct' && token.value === ')') depth -= 1;
      }
    }
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name = '';
    const first = this.peek();
    if (first?.type === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const nameToken = this.peek();
      if (nameToken?.type === 'name') {
        name = nameToken.value;
        this.next();
      }
    }
    this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.type === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.next();
    if (token.type === 'punct' && token.value === '...') {
      const onToken = this.next();
      if (onToken.type !== 'name' || onToken.value !== 'on') {
        throw new Error('only inline fragments are supported');
      }
      const typeToken = this.next();
      if (typeToken.type !== 'name') throw new Error('inline fragment needs a type name');
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition: typeToken.value, selections };
    }
    if (token.type !== 'name') throw new Error('expected a field name in selection set');
    let alias = token.value;
    let name = token.value;
    const colon = this.peek();
    if (colon?.type === 'punct' && colon.value === ':') {
      this.next();
      const nameToken = this.next();
      if (nameToken.type !== 'name') throw new Error('expected a field name after :');
      name = nameToken.value;
    }
    const args: Record<string, Value> = {};
    const paren = this.peek();
    if (paren?.type === 'punct' && paren.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next?.type === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.next();
        if (argName.type !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args[argName.value] = this.parseValue();
      }
    }
    let selections: Selection[] = [];
    const brace = this.peek();
    if (brace?.type === 'punct' && brace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.type === 'variable') return { $variable: token.value } as unknown as Value;
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return token.value;
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value } as unknown as Value;
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (true) {
        const next = this.peek();
        if (next?.type === 'punct' && next.value === ']') {
          this.next();
          return values;
        }
        values.push(this.parseValue());
      }
    }
    if (token.type === 'punct' && token.value === '{') {
      const obj: Record<string, Value> = {};
      while (true) {
        const next = this.peek();
        if (next?.type === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const key = this.next();
        if (key.type !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        obj[key.value] = this.parseValue();
      }
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Replace $variable / $enum markers with real values. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.$variable === 'string') return variables[record.$variable] ?? null;
    if (typeof record.$enum === 'string') return record.$enum;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) out[key] = resolveValue(v as Value, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
  return value;
}

// ---------------------------------------------------------------- schema

interface TypeField {
  name: string;
  type: string;
}

const SCHEMA: Record<string, TypeField[]> = {
  Query: [
    { name: 'viewer', type: 'User' },
    { name: 'repository', type: 'Repository' },
    { name: 'node', type: 'Node' },
    { name: '__type', type: '__Type' },
  ],
  User: [
    { name: 'id', type: 'ID' },
    { name: 'login', type: 'String' },
    { name: 'name', type: 'String' },
    { name: 'email', type: 'String' },
  ],
  Repository: [
    { name: 'id', type: 'ID' },
    { name: 'databaseId', type: 'Int' },
    { name: 'name', type: 'String' },
    { name: 'nameWithOwner', type: 'String' },
    { name: 'owner', type: 'User' },
    { name: 'defaultBranchRef', type: 'Ref' },
    { name: 'viewerPermission', type: 'RepositoryPermission' },
    { name: 'hasIssuesEnabled', type: 'Boolean' },
    { name: 'issue', type: 'Issue' },
    { name: 'issues', type: 'IssueConnection' },
    { name: 'pullRequests', type: 'PullRequestConnection' },
    { name: 'pullRequest', type: 'PullRequest' },
  ],
  Issue: [
    { name: 'id', type: 'ID' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'state', type: 'IssueState' },
    { name: 'body', type: 'String' },
  ],
  IssueConnection: [
    { name: 'nodes', type: '[Issue]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  PageInfo: [
    { name: 'hasNextPage', type: 'Boolean' },
    { name: 'hasPreviousPage', type: 'Boolean' },
    { name: 'startCursor', type: 'String' },
    { name: 'endCursor', type: 'String' },
  ],
  PullRequest: [
    { name: 'id', type: 'ID' },
    { name: 'number', type: 'Int' },
    { name: 'title', type: 'String' },
    { name: 'state', type: 'PullRequestState' },
    { name: 'body', type: 'String' },
    { name: 'headRefName', type: 'String' },
    { name: 'baseRefName', type: 'String' },
    { name: 'mergeable', type: 'MergeableState' },
    { name: 'merged', type: 'Boolean' },
    { name: 'files', type: 'PullRequestFileConnection' },
  ],
  PullRequestConnection: [
    { name: 'nodes', type: '[PullRequest]' },
    { name: 'pageInfo', type: 'PageInfo' },
    { name: 'totalCount', type: 'Int' },
  ],
  PullRequestFileConnection: [
    { name: 'nodes', type: '[PullRequestFile]' },
    { name: 'pageInfo', type: 'PageInfo' },
  ],
  PullRequestFile: [{ name: 'path', type: 'String' }],
  Ref: [{ name: 'name', type: 'String' }],
  IssueComment: [
    { name: 'id', type: 'ID' },
    { name: 'body', type: 'String' },
  ],
  IssueCommentEdge: [
    { name: 'node', type: 'IssueComment' },
    { name: 'cursor', type: 'String' },
  ],
  __Type: [
    { name: 'name', type: 'String' },
    { name: 'kind', type: 'String' },
    { name: 'fields', type: '[__Field]' },
    { name: 'enumValues', type: '[__EnumValue]' },
  ],
  __Field: [{ name: 'name', type: 'String' }],
  __EnumValue: [{ name: 'name', type: 'String' }],
  Mutation: [
    { name: 'createIssue', type: 'CreateIssuePayload' },
    { name: 'closeIssue', type: 'CloseIssuePayload' },
    { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
    { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
    { name: 'addComment', type: 'AddCommentPayload' },
  ],
  CreateIssuePayload: [{ name: 'issue', type: 'Issue' }],
  CloseIssuePayload: [{ name: 'issue', type: 'Issue' }],
  CreatePullRequestPayload: [{ name: 'pullRequest', type: 'PullRequest' }],
  MergePullRequestPayload: [{ name: 'pullRequest', type: 'PullRequest' }],
  AddCommentPayload: [{ name: 'commentEdge', type: 'IssueCommentEdge' }],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------- values

type GqlObject = { __typename: string; [key: string]: unknown };

function repoValue(repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: repo.globalId,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: repo.fullName,
  };
}

function issueValue(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('Issue', repo, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullValue(repo: Repo, pull: Pull): GqlObject {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: globalId('PullRequest', repo, pull.number),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    merged: pull.merged,
  };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number(decoded.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { createdSeq: number }>(
  ordered: T[],
  first: number | null,
  after: string | null,
  direction: 'ASC' | 'DESC',
): { nodes: T[]; pageInfo: GqlObject } {
  let startIndex = 0;
  if (after !== null) {
    const seq = seqFromCursor(after);
    if (seq !== null) {
      const index = ordered.findIndex((item) => item.createdSeq === seq);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const limit = first ?? ordered.length;
  const page = ordered.slice(startIndex, startIndex + limit);
  const hasNextPage = startIndex + page.length < ordered.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].createdSeq) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0].createdSeq) : null;
  void direction;
  return {
    nodes: page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor,
      endCursor,
    },
  };
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
}

class GraphQLError extends Error {}

function typeOf(value: GqlObject | null): string {
  return value === null ? 'Null' : value.__typename;
}

function resolveRootField(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
  if (field.name === 'viewer') {
    return { __typename: 'User', id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url'), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
  }
  if (field.name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    const repo = ctx.store.getRepo(owner, name);
    return repo ? repoValue(repo) : null;
  }
  if (field.name === 'node') {
    const id = typeof args.id === 'string' ? args.id : '';
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = ctx.store.listRepos().find((r) => r.databaseId === parsed.repoDbId);
      return repo ? repoValue(repo) : null;
    }
    return null;
  }
  if (field.name === '__type') {
    const name = typeof args.name === 'string' ? args.name : '';
    return introspectionType(name);
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Query"`);
}

function introspectionType(name: string): GqlObject | null {
  if (SCHEMA[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      _fields: SCHEMA[name].map((f) => ({ __typename: '__Field', name: f.name })),
      _enumValues: [],
    };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      _fields: [],
      _enumValues: ENUM_VALUES[name].map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

function resolveField(ctx: Ctx, parent: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  const typeName = parent.__typename;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
  const schemaFields = SCHEMA[typeName];
  if (schemaFields !== undefined && !schemaFields.some((f) => f.name === field.name)) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}"`);
  }
  if (typeName === 'Repository') {
    const repo = parent._repo as Repo;
    if (field.name === 'owner') {
      return { __typename: 'User', id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64url'), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'defaultBranchRef') {
      const tip = repo.resolveRef('HEAD');
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issueByNumber(number);
      return issue ? issueValue(repo, issue) : null;
    }
    if (field.name === 'issues') {
      return issuesConnection(repo, args);
    }
    if (field.name === 'pullRequests') {
      return pullRequestsConnection(repo, args);
    }
    if (field.name === 'pullRequest') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pullByNumber(number);
      return pull ? pullValue(repo, pull) : null;
    }
    return parent[field.name] ?? null;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    return parent[field.name] ?? null;
  }
  if (typeName === 'PullRequest') {
    const repo = parent._repo as Repo;
    const pull = parent._pull as Pull;
    if (field.name === 'mergeable') return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    if (field.name === 'files') {
      const base = mergeBase(repo.objects, pull.headShaAtCreate, pull.baseShaAtCreate);
      const diffs = diffFiles(repo, base, pull.headShaAtCreate);
      const first = typeof args.first === 'number' ? args.first : diffs.length;
      const nodes = diffs.slice(0, first).map((d) => ({ __typename: 'PullRequestFile', path: d.filename }));
      return {
        __typename: 'PullRequestFileConnection',
        nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    return parent[field.name] ?? null;
  }
  if (typeName === '__Type') {
    if (field.name === 'fields') return parent._fields ?? [];
    if (field.name === 'enumValues') return parent._enumValues ?? [];
    return parent[field.name] ?? null;
  }
  return parent[field.name] ?? null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  const { nodes, pageInfo } = pageInfoFor(list, first, after, direction);
  return {
    __typename: 'IssueConnection',
    nodes: nodes.map((issue) => issueValue(repo, issue)),
    pageInfo,
    totalCount: list.length,
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  const { nodes, pageInfo } = pageInfoFor(list, first, after, 'DESC');
  return {
    __typename: 'PullRequestConnection',
    nodes: nodes.map((pull) => pullValue(repo, pull)),
    pageInfo,
    totalCount: list.length,
  };
}

function executeMutation(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const repo = repoByGlobalId(ctx, typeof input.repositoryId === 'string' ? input.repositoryId : '');
    if (!repo) throw new GraphQLError('repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    const issue: Issue = {
      number: repo.nextNumber(),
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      createdSeq: repo.nextSeq(),
      comments: [],
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const parsed = parseGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
    if (!parsed || parsed.kind !== 'Issue' || parsed.number === null) throw new GraphQLError('issue not found');
    const repo = ctx.store.listRepos().find((r) => r.databaseId === parsed.repoDbId);
    const issue = repo?.issueByNumber(parsed.number);
    if (!repo || !issue) throw new GraphQLError('issue not found');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repo = repoByGlobalId(ctx, typeof input.repositoryId === 'string' ? input.repositoryId : '');
    if (!repo) throw new GraphQLError('repository not found');
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headSha = repo.resolveRef(`refs/heads/${head}`);
    const baseSha = repo.resolveRef(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) throw new GraphQLError('head or base branch does not exist');
    const pull: Pull = {
      number: repo.nextNumber(),
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const parsed = parseGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
    if (!parsed || parsed.kind !== 'PullRequest' || parsed.number === null) throw new GraphQLError('pull request not found');
    const repo = ctx.store.listRepos().find((r) => r.databaseId === parsed.repoDbId);
    const pull = repo?.pullByNumber(parsed.number);
    if (!repo || !pull) throw new GraphQLError('pull request not found');
    if (pull.merged) throw new GraphQLError('Pull Request is already merged');
    const headSha = repo.resolveRef(`refs/heads/${pull.head.ref}`);
    const baseSha = repo.resolveRef(`refs/heads/${pull.base.ref}`);
    if (headSha === undefined || baseSha === undefined) throw new GraphQLError('branch not found');
    const base = mergeBase(repo.objects, headSha, baseSha);
    if (base === null) throw new GraphQLError('no merge base');
    const { files, conflict } = mergeTrees(repo, baseSha, headSha, base);
    if (conflict !== null) throw new GraphQLError(`merge conflict in ${conflict}`);
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const commitOid = repo.createCommit(treeOid, [baseSha], `Merge pull request #${pull.number} from ${pull.head.ref}`);
    repo.setRef(`refs/heads/${pull.base.ref}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date().toISOString();
    pull.merge_commit_sha = commitOid;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) };
  }
  if (field.name === 'addComment') {
    const parsed = parseGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
    if (!parsed || parsed.number === null) throw new GraphQLError('subject not found');
    const repo = ctx.store.listRepos().find((r) => r.databaseId === parsed.repoDbId);
    const item = repo?.itemByNumber(parsed.number);
    if (!repo || !item) throw new GraphQLError('subject not found');
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: repo.nextCommentId(), body, createdSeq: repo.nextSeq() };
    item.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: globalId('IssueComment', repo, comment.id), body },
        cursor: cursorFor(comment.createdSeq),
      },
    };
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation"`);
}

function repoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return ctx.store.listRepos().find((r) => r.databaseId === parsed.repoDbId) ?? null;
}

function executeSelections(
  ctx: Ctx,
  selections: Selection[],
  parent: GqlObject,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (parent.__typename === selection.typeCondition) {
        Object.assign(out, executeSelections(ctx, selection.selections, parent, variables));
      }
      continue;
    }
    const value = resolveField(ctx, parent, selection, variables);
    out[selection.alias] = projectValue(ctx, value, selection, variables);
  }
  return out;
}

function projectValue(ctx: Ctx, value: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(ctx, v, field, variables));
  if (typeof value === 'object' && field.selections.length > 0) {
    return executeSelections(ctx, field.selections, value as GqlObject, variables);
  }
  return value;
}

function executeOperation(
  ctx: Ctx,
  operation: Operation,
  variables: Record<string, unknown>,
): { data: unknown; errors?: Array<{ message: string }> } {
  try {
    if (operation.kind === 'mutation') {
      const data: Record<string, unknown> = {};
      for (const selection of operation.selections) {
        if (selection.kind === 'fragment') continue;
        const payload = executeMutation(ctx, selection, variables) as GqlObject;
        data[selection.alias] = projectValue(ctx, payload, selection, variables);
      }
      return { data };
    }
    const data: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if (selection.kind === 'fragment') continue;
      const value = resolveRootField(ctx, selection, variables);
      data[selection.alias] = projectValue(ctx, value, selection, variables);
    }
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- handler

export interface GraphQLResult {
  status: number;
  body: Buffer;
}

export function handleGraphQL(ctx: Ctx, authorized: boolean, body: Buffer | null): GraphQLResult {
  if (!authorized) {
    return { status: 401, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body === null ? '' : body.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Problems parsing JSON' }), 'utf8') };
  }
  const operations: Array<{ query?: unknown; variables?: unknown }> = Array.isArray(parsed)
    ? (parsed as Array<{ query?: unknown; variables?: unknown }>)
    : [parsed as { query?: unknown; variables?: unknown }];
  const results: unknown[] = [];
  for (const entry of operations) {
    if (typeof entry.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    try {
      const operation = new Parser(tokenize(entry.query)).parseOperation();
      results.push(executeOperation(ctx, operation, variables));
    } catch (err) {
      results.push({
        data: null,
        errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }],
      });
    }
  }
  const payload = Array.isArray(parsed) ? results : results[0];
  return { status: 200, body: Buffer.from(JSON.stringify(payload), 'utf8') };
}
