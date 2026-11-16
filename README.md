# dsh-codemap

[![npm](https://img.shields.io/npm/v/dsh-codemap.svg)](https://www.npmjs.com/package/dsh-codemap)

Project-scoped code graph tools for DeepSeek Harness, backed by the `codemap`
CLI. It registers nine Host tools once and decides the repository per call, so
a new workspace needs no configuration: open a session inside an indexed
repository and the tools work.

## Install

```sh
# from npm (recommended)
dsh plugin --profile <profile> add dsh-codemap

# or straight from this repository
dsh plugin --profile <profile> add github:vip-pan/dsh-codemap
```

The desktop app's plugin manager or plugin market can also install the bundle;
the profile gains one row (`codemap`) and no client UI.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_code` | Hybrid full-text + semantic code search. |
| `find_symbol` | Exact/prefix/suffix symbol lookup, batchable. |
| `get_symbol_detail` | Location, signature, docs, optional body. |
| `get_call_chain` | Upstream callers and downstream callees. |
| `get_type_hierarchy` | Parent and child types of a class/interface. |
| `get_dependencies` | Reverse dependencies, plus asset file references. |
| `get_graph_stats` | File/symbol/call/import counts. |
| `query_cypher` | Read-only Cypher for counting and aggregation. |
| `search_knowledge` | Business rules and architecture docs from the code index. |

## How it works

Each tool call resolves the calling session's working directory (including a
directory the session `cd`ed into) upwards to its repository root — the nearest
`.codemaker/` directory, else the nearest `.git/`, else the directory itself.
The plugin then starts `codemap serve -r <root>` for that root on first use,
proxies the MCP request over stdio, and shares the process with every other
session in the same repository. Processes idle for ten minutes are stopped.

Because resolution happens per call, subagents and sessions in different
repositories never share an index.

## Requirements

This plugin does not ship `codemap`; it is only an MCP client for the
`codemap serve` server that the CLI provides. Install the CLI separately, for
example with its installer:

```sh
curl -fsSL https://codemaker.nie.netease.com/codemap-package/codemap/install.sh | sh
```

- The `codemap` CLI, resolved from `CODEMAP_BIN`, `~/.local/codemap/codemap`,
  or `PATH`.
- A repository codemap has indexed (`.codemaker/codemap/graph.db`) — for
  example by running `codemap setup` or `codemap build` once in it. The codemap
  daemon owns index maintenance and file watching; a first-time index of a
  large repository takes time.

## Configuration (environment variables)

- `CODEMAP_BIN` — path to the codemap executable.
- `CODEMAP_IDLE_MS` — idle milliseconds before a repository process is
  recycled (default `600000`).
- `CODEMAP_INIT_TIMEOUT_MS` — MCP initialize timeout (default `30000`).
- `CODEMAP_CALL_TIMEOUT_MS` — per-tool-call timeout (default `180000`).

## Limitations

- Read-only: the tools query the graph and never edit source files.
- A call without an agent session (for example directly in a CLI harness
  without an agent) fails instead of guessing a repository.
- `search_knowledge` returns results only when the repository has
  `.codemaker/codeindex/kb-config.json`.
- The plugin speaks the MCP tools that `codemap serve` exposes, so it is tied
  to codemap's tool contract rather than to a generic graph protocol.

## Development

```sh
node tools/test-plugin.mjs      # offline: registration, render, agent requirement
node tools/test-broker.mjs      # offline: repository-root discovery

# end-to-end, needs an indexed repository:
CODEMAP_TEST_REPO=/path/to/indexed/repo node tools/test-plugin.mjs
CODEMAP_TEST_REPO=/path/to/indexed/repo CODEMAP_TEST_SYMBOL=SomeSymbol node tools/test-broker.mjs
```

## Releasing

Releases are published by GitHub Actions through npm trusted publishing
(OIDC), so no tokens are stored in the repository:

```sh
npm version patch --no-git-tag-version   # or edit package.json
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

The `Publish Package` workflow verifies the tool contract, then runs
`npm publish --provenance` against the npm registry.

## License

MIT

