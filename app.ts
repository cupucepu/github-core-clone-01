// app.ts — the HTTP server: one store, four surfaces. Reads each request's
// body, routes it (healthz, git smart HTTP, REST v3, GraphQL, MCP), and
// answers with the right content type. Every reply carries a
// non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

/** Monotonic request ids: the suite only requires a non-empty X-GitHub-Request-Id. */
let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${process.hrtime.bigint().toString(16)}`;
}

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();

function isAuthorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true; // local practice: any token accepted
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json', Buffer.from(JSON.stringify(value), 'utf8'));
}

export function createApp(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const authorized = isAuthorized(req);

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch !== null) {
        if (!authorized) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const service = gitMatch[3];
        const gitProtocol = req.headers['git-protocol'];
        if (method === 'GET' && service === 'info/refs') {
          const result = infoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', gitProtocol);
          send(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && service === 'git-upload-pack') {
          const body = await readBody(req);
          const result = uploadPack(store, owner, repoName, gitProtocol, body);
          send(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && service === 'git-receive-pack') {
          const body = await readBody(req);
          const result = receivePack(store, owner, repoName, body);
          send(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL
      if (method === 'POST' && pathname === '/api/graphql') {
        const body = await readBody(req);
        const result = handleGraphQL({ store }, authorized, body);
        send(res, result.status, 'application/json', result.body);
        return;
      }

      // MCP
      if (method === 'POST' && pathname === '/mcp') {
        const body = await readBody(req);
        const result = handleMcp({ store, baseUrl, authorized }, body);
        send(res, result.status, 'application/json', result.body);
        return;
      }

      // REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const body = method === 'GET' || method === 'DELETE' ? null : await readBody(req);
        const result = handleRest({ store, baseUrl, authorized }, method, pathname, url.searchParams, body);
        send(res, result.status, result.headers['content-type'] ?? 'application/json', result.body, result.headers);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // Never let one bad request kill the server.
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}
