# forge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cupucepu/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cupucepu/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01). One process, no dependencies beyond the Node 22 standard library, no git
binary, no database: the whole forge lives in memory and serves four
surfaces from one store.

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` set → the trial lifecycle (bind, register, poll `/done`,
exit 0). Unset → the server just serves on its ephemeral port (local
practice). `MAKEFUN_SHOP_TOKEN` set → every API call must carry that Bearer
token; unset → any token is accepted (local practice only).

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | the lifecycle: bind, register, poll `/done` |
| `app.ts` | the HTTP server and routing |
| `store.ts` | the in-memory store: repos, git objects + refs, issues, PRs, labels, comments |
| `gitobjects.ts` | the git object model: SHA-1 objects, trees, commits, packfiles (plain + deltas), pkt-lines, reachability, merge-base |
| `githttp.ts` | git smart HTTP: info/refs (v0 + v2), upload-pack (fetch/clone, shallow + deepen), receive-pack (push, report-status in side-band-64k) |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests, squash merges |
| `graphql.ts` | GraphQL v4: a small parser + executor for the documents `gh` and `github-mcp-server` send |
| `mcp.ts` | MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (six tools) |

## Notes

- The viewer is the token's login (`adaiversen`, the scenario's viewer).
  Every surface derives it from the same constant, so REST, GraphQL and MCP
  agree about who the token owner is.
- Fetch packs are cached per repo + request: the clone workload re-fetches
  the same tip, so the pack is built once and served from the cache.
- Packs are written plain (no deltas) with level-1 deflate: fast to build,
  and the client verifies the checksum.
- Shallow fetches walk the wanted commits to the requested depth; the
  haves only drive the ACK/NAK negotiation there. Full fetches send the
  wants minus the haves.
- A push is refused per ref when it is not a fast-forward
  (`ng <ref> non-fast-forward`), when the old value does not match, or when
  the ref already exists; a mixed push applies the fast-forward refs.

## Local practice

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts &
node --experimental-strip-types ../kit/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:<PORT> --token test-token --perf
```

## Licence

MIT.
