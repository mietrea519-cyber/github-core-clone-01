[![Bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/mietrea519-cyber/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/mietrea519-cyber/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# Forge — a GitHub-compatible git forge in one Node process

A standalone git forge that speaks the four surfaces GitHub clients use,
implemented from scratch on the Node.js standard library — no git binary,
no dependencies, one in-memory store behind all of it.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  and `git-receive-pack`. Upload-pack speaks protocol **v2** (`ls-refs` and
  `fetch` commands, shallow `deepen`, sideband framing) with a v0 fallback;
  receive-pack is v0 with `report-status`, `side-band-64k` and `delete-refs`.
  Packfiles are written and read natively (zlib + SHA-1), including
  ofs-delta and ref-delta resolution, and every update must fast-forward.
- **REST v3** under `/api/v3` — repositories (create/read/update/delete,
  paginated lists with `Link` headers), contents (create/update/delete as
  real git commits), branches, commits, labels, issues with label
  validation, issue comments, and pull requests with three-way squash
  merges (conflicts answer 405).
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  github-mcp-server actually send: `viewer`, `repository` with issues and
  pull-request connections (cursor pagination, `orderBy`, `states`),
  `node(id:)` with inline fragments, `__type` introspection for Issue,
  PullRequest, Repository and SearchType, and the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations, with GitHub-style global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP: `server/discover`
  (2026-07-28), the `initialize` handshake, and six tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same store as REST, so an issue made
  over MCP reads back over `/api/v3` unchanged.

## How it is built

`main.ts` is the harness lifecycle (bind an ephemeral port, register with
the env, poll until done). `app.ts` is the forge itself:

- A content-addressed object store (blob/tree/commit, SHA-1) backs every
  repository; trees are flattened and rebuilt for the contents API and for
  merges, and commit ancestry drives fast-forward checks, merge bases and
  fetch negotiation.
- One bearer token (the env's `MAKEFUN_SHOP_TOKEN`) authenticates all four
  surfaces; a repository belongs to the token's login, and the same name
  under another owner is a 404, never a 403.

Verified locally with a real git client (clone, push, branch, non-fast-forward
refusal) and with scripted REST, GraphQL and MCP calls against the running
server.

## Design notes from the build

Three decisions shaped the implementation. First, there is exactly one
object store for the whole process: because git objects are content-addressed,
the contents API, a push and a GraphQL merge all write into the same map, and
no surface can disagree with another about what a commit contains. Second,
merges are tree-level three-way merges against the merge base — the same
flat-map diff decides REST mergeability, the GraphQL `mergeable` field and
the MCP merge tool, so the three surfaces never contradict each other.
Third, fetch negotiation reuses the ancestry walk that push validation uses:
the set of objects a client already has is just the closure of its `have`
commits, excluded from the pack.

An entry to the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty on make.fun, built by an AI agent paired with
[@mietrea](https://make.fun/u/mietrea).
