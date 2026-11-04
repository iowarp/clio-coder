---
title: "MCP gateway: configuration, trust, and tool classification"
summary: "How Clio loads stdio MCP server declarations, binds project-declared servers to explicit trust records, classifies each MCP tool's action class, caches tool catalogs, and owns the lifetime of a launched server connection. Read this before changing MCP config, trust, or tool authority."
sources:
  - "src/domains/gateway/mcp/index.ts"
  - "src/domains/gateway/mcp/config.ts"
  - "src/domains/gateway/mcp/trust.ts"
  - "src/domains/gateway/mcp/action-classes.ts"
  - "src/domains/gateway/mcp/metadata-cache.ts"
  - "src/domains/gateway/mcp/connection-lifecycle.ts"
  - "src/domains/gateway/mcp/client.ts"
  - "src/domains/gateway/mcp/protocol.ts"
symbols:
  - "loadMcpServerConfig"
  - "parseMcpConfigText"
  - "resolveMcpServers"
  - "trustMcpServer"
  - "untrustMcpServer"
  - "mcpToolActionClass"
  - "mcpToolConfirmationRule"
  - "mcpToolOwner"
  - "readMcpServerCatalog"
  - "writeMcpServerCatalog"
  - "createMcpConnection"
  - "createMcpStdioClient"
tests:
  - "tests/contracts/mcp-config-trust.test.ts"
  - "tests/contracts/gateway-mcp.test.ts"
  - "tests/contracts/mcp-metadata-cache.test.ts"
invariants:
  - "A project-scope or plugin-scope MCP server launches only when its trust record matches the exact declaration digest, and its entry-script hashes when it has any; a missing, mismatched, or unreadable-entry record leaves it untrusted or stale."
  - "User-scope declarations are trusted by authorship and carry no trust record."
  - "An untrusted or stale declaration classifies every tool as unknown, regardless of its per-tool classes or server hints."
  - "A client-scope server, which has no trust record, classifies every tool as unknown."
  - "A tool's action class from server readOnlyHint is used only when the caller is not under a read-only ceiling; under that ceiling it is unknown."
  - "A cached tool catalog is a hit only for the same project root, scope, declaration path, server id, digest, and resolved cwd, and only within the 24-hour TTL; any other case is a miss."
  - "A config file over 256 KiB, or with more than 32 servers, contributes no servers; a malformed file fails closed."
validate:
  - "pnpm exec vitest run tests/contracts/mcp-config-trust.test.ts tests/contracts/gateway-mcp.test.ts tests/contracts/mcp-metadata-cache.test.ts"
---

# MCP gateway: configuration, trust, and tool classification

The `src/domains/gateway/mcp` module is the local stdio side of Clio's Model Context Protocol support. Read it when you need to know which MCP servers Clio will launch, what authority their tools carry, how a launched server is kept alive and torn down, or where a declaration's trust is decided. It is a library with no network listener: it parses config, records operator trust decisions, classifies tools, and drives one child process per server.

`src/domains/gateway/mcp/index.ts` is the public surface. It re-exports the symbols from the sibling files: classification (`src/domains/gateway/mcp/action-classes.ts`), the client and its option and result types (`src/domains/gateway/mcp/client.ts`), config loading (`src/domains/gateway/mcp/config.ts`), the metadata cache (`src/domains/gateway/mcp/metadata-cache.ts`), protocol framing (`src/domains/gateway/mcp/protocol.ts`), and trust (`src/domains/gateway/mcp/trust.ts`). The connection lifecycle helper `createMcpConnection` in `src/domains/gateway/mcp/connection-lifecycle.ts` is not re-exported from the index; its only consumer loads it with a dynamic import (see below).

## Configuration sources and load order

`loadMcpServerConfig` in `src/domains/gateway/mcp/config.ts` is the single loader. It reads the user file and the project file, then the plugin servers.

- The user file path comes from `mcpConfigPaths` and is named by `MCP_USER_CONFIG_FILENAME`. The project file is `MCP_PROJECT_CONFIG_RELATIVE_PATH` under the project root from `mcpProjectRoot`.
- Each file is read with `loadFile`, which calls `parseMcpConfigText`. That function applies a strict schema: a byte cap (`MCP_CONFIG_CAPS.fileBytes`, 256 KiB), YAML parsing with unique keys and no aliases, a required `version` equal to `MCP_CONFIG_VERSION`, a required `servers` array, and a server cap (`MCP_CONFIG_CAPS.servers`, 32). Any violation returns a single diagnostic and no servers from that file.
- A user declaration wins an id collision against a project declaration. The project entry is dropped with a diagnostic naming the user file. Plugin servers are added last; a plugin server that collides with an earlier id is dropped with a diagnostic naming the plugin.

Each declaration (`McpServerDeclaration`) carries an `id`, a `scope` (`user`, `project`, or `plugin`), the source `path`, `command`, `args`, a resolved `cwd` and `cwdRoot`, `env`, `timeoutMs`, `actionClass`, `actionClassExplicit`, `toolActionClasses`, a `digest`, and optional `network`, `entryScripts`, and `digestWithoutEntryScript` fields. `digest` is computed by `mcpServerDigest` over the launch-relevant fields and, for project servers, over the entry-script hashes. The `digestWithoutEntryScript` field exists so trust records written before entry binding can be recognized and reported as stale rather than silently mismatched.

Entry-script detection (`projectEntryScripts`) binds files a project server runs from inside the project, such as `node ./tools/x.mjs`. Per the module header in `src/domains/gateway/mcp/trust.ts`, imports of those files are not covered by the binding.

## Trust

`src/domains/gateway/mcp/trust.ts` decides whether a declaration may launch. The state lives in `mcp-trust.json` under the Clio config directory (`mcpTrustPath`), at version 1 with a record cap (`MCP_TRUST_CAPS.records`, 256) and a file byte cap (1 MiB).

`resolveMcpServers` loads the config and the trust state, then gives each declaration a `trust` status through `trustStatusFor`:

- A `user` declaration is `trusted` with its own `actionClass` and no record is needed.
- Any other scope with an entry script that cannot be read is `untrusted`, with a reason that names the file.
- With no record for `(canonical project root, id)`, the status is `untrusted` and the reason names the command `clio-coder mcp trust <id>`.
- A record whose digest differs from the declaration is `stale`. Three reasons are distinguished: a record from before entry binding (it matches `digestWithoutEntryScript`), a changed entry-script hash, or a changed declaration.
- A matching record is `trusted` with the record's `actionClass` and, if granted, `network`.

`trustMcpServer` writes a record for one declaration. It refuses user-scope ids, unknown ids, unreadable entry scripts, and an unusable trust file. It stores the canonical project root (`canonicalProjectRoot`), the digest, the chosen action class (default `unknown`), an optional `network` grant, and per-entry SHA-256 hashes. Writes go through `safeResourceWrite` with mode `0600`, and records are sorted by project root and id. `untrustMcpServer` removes the record for that project root and id, whether or not the server is still declared.

`readMcpTrustState` never rewrites the file. A missing file is an empty state. An oversized, corrupt, or over-populated file is an empty state with a diagnostic, and `trustMcpServer` and `untrustMcpServer` refuse to write over it until the operator repairs it.

The focused test `requires an explicit record for a project server and binds it to the declaration digest` in `tests/contracts/mcp-config-trust.test.ts` exercises this flow. It starts with a project server `files` that is `untrusted` and whose reason matches `clio-coder mcp trust files`. After `trustMcpServer` with action class `read`, it checks the record fields, file mode `0o600`, and no leftover temp files. Editing the project config to change `--stdio` to `--stdio-v2` makes the status `stale` with a reason matching `changed (command, args, env, cwd, or timeout) since it was trusted`. Re-trusting without an action class records `unknown`, and `untrustMcpServer` then reports `removed: true` and then `removed: false`. Other cases in the same file cover entry-script edits, symlink repointing, the pre-entry-binding stale message, oversized trust files, and per-project record separation.

## Tool action classification

`src/domains/gateway/mcp/action-classes.ts` gives each MCP tool one action class (`read`, `execute`, `destructive`, or `unknown`) through `mcpToolActionClass`. The function checks trust first:

1. If `server.trust.status` is not `trusted`, the result is `unknown`.
2. If the scope is `client`, the result is `unknown`. Client-scope servers exist only for a hosted ACP session and cannot be trusted by record.
3. A per-tool entry in `toolActionClasses` wins.
4. Only a `user`-scope server with id `slurm` gets built-in Slurm defaults: names in `SLURM_CONFIRM_TOOLS` are `execute`, names in `SLURM_READ_TOOLS` are `read`. A project or plugin server named `slurm` gets none of these.
5. For `project` or `plugin` scope, or when the declaration set `actionClass` explicitly, or when the trust record carries a non-`unknown` class, the trust-recorded class applies.
6. Otherwise, server annotation hints are advisory. `readOnlyHint: true` yields `read` unless the caller passed `{ readOnly: true }`, in which case it yields `unknown`. `destructiveHint: true` yields `destructive`. Anything else is `unknown`.

`mcpToolConfirmationRule` returns `slurm-allocation` for the Slurm confirm names under a server with id `slurm`, and null otherwise. `mcpToolOwner` maps a composed `mcp_<id>__<tool>` name to the longest declared server id prefix, so an id containing `__` is not mis-routed.

The test `classifies an MCP tool trust first, for every caller, through one function` in `tests/contracts/gateway-mcp.test.ts` covers these branches. Untrusted and stale declarations with a `readOnlyHint` annotation classify `tail` and `get_job_output` as `unknown`. A trusted project declaration with `tail` mapped to `read` classifies `read`. A user-scope declaration with no per-tool map classifies `get_job_output` as `read` through the Slurm defaults, while the same name on a trusted project declaration classifies `unknown`. `mcpToolOwner([{ id: "a" }, { id: "a__b" }], "mcp_a__b__tool")` returns the `a__b` declaration with tool `tool`. A separate test in `tests/contracts/mcp-config-trust.test.ts` (`gives a plugin server named slurm none of the Slurm read defaults`) confirms that a trusted plugin server named `slurm` classifies `get_queue_info` as `unknown`.

Callers of `mcpToolActionClass` include `src/cli/mcp.ts`, `src/domains/dispatch/worker-mcp.ts`, and `src/tools/gateway/mcp-capabilities.ts`. The gateway caller at line 590 passes `{ readOnly: true }` under a read-only ceiling; the worker and CLI callers pass the tool's live annotations or `null`.

## Metadata cache

`src/domains/gateway/mcp/metadata-cache.ts` persists one tool catalog per declared server. The file name is a hash of `(projectRoot, scope, declarationPath, serverId)` (`mcpCatalogPath`), so two checkouts or two sessions refreshing different servers do not overwrite each other. The digest and cwd are checked from the file body, so a re-declared server replaces its own catalog.

`readMcpServerCatalog` returns a catalog only when every identity field matches, the body decodes under the caps (`MCP_METADATA_CACHE_CAPS`), the `observedAt` is not in the future, and the age is under `MCP_METADATA_CACHE_TTL_MS` (24 hours). Any other condition returns `null`, and there is no degraded hit. `writeMcpServerCatalog` returns `false` rather than throwing, and it drops any tool the decoder would reject on read-back. A dropped tool marks the catalog `truncated`.

The metadata-cache tests in `tests/contracts/mcp-metadata-cache.test.ts` cover these rules. Among them: `never persists environment values, launch vectors, or trust decisions`, `misses when the declaration digest or resolved cwd changed`, `expires against an injected clock and refuses a future-dated file`, `marks a catalog incomplete when a tool is too large to persist`, and `reports a failed write instead of throwing`. The shared trust-state file is not the cache, and the cache stores no trust decision.

Upstream callers are `src/tools/gateway/mcp-capabilities.ts` (which reads the catalog only for `trusted` declarations at the lookup near line 556 and writes after a live listing near line 567), `src/domains/dispatch/worker-mcp.ts`, and `src/cli/mcp.ts`.

## Connection lifecycle

`src/domains/gateway/mcp/connection-lifecycle.ts` exports `createMcpConnection`, which wraps one client for discovery and retention. It takes `acquire`, `onAcquired`, and an `AbortSignal`, and returns an `McpConnection` with a `ready` promise and a `close()`.

The internal flow runs in one async task. It checks the lifetime signal, calls `acquire()` to create the client, records it through `onAcquired` before any I/O, runs `client.initialize` and `client.listTools` under the lifetime signal, and resolves `ready` with the client and listing. It then waits on an internal `released` promise, so the server stays alive for later calls. `close()` aborts the lifetime and releases the wait. After that, the task calls `client.close()` and resolves with its teardown outcome. If discovery failed, `ready` rejects only after that close completes.

The caller in `src/tools/gateway/mcp-capabilities.ts` (`startConnection`, around line 680) dynamically imports this module and reserves ownership before the import, so a close that arrives first can fence acquisition. It passes `sandboxNetwork: true` to the client only when the admitted worker attestation grants `network` for that server id.

`src/domains/gateway/mcp/client.ts` supplies the child process. `createMcpStdioClient` validates the initial cwd against the workspace root through `containedCwd` and throws an `McpError` of kind `spawn` on a bad path. Its defaults are set near the top of the file: initialize timeout, request timeout, stderr tail size, outbound byte cap, kill grace, and teardown bound. `src/domains/gateway/mcp/protocol.ts` provides JSON-RPC line framing (`createLineFramer`, `parseJsonRpcLine`, `encodeJsonRpcMessage`) with a per-line cap (`DEFAULT_MAX_LINE_BYTES`) and the protocol version `MCP_PROTOCOL_VERSION`. This page does not inspect the client's request-dispatch and teardown branches in full, so their details are not described here beyond the option names.

No focused test in the searched contracts directory exercises `createMcpConnection` directly. The search covered `tests/contracts` for `createMcpConnection`, and the only matches were in `src`.

## Things to watch when editing

- Trust must be decided before any per-tool class is read. `mcpToolActionClass` returns `unknown` for untrusted and stale declarations before it reads `toolActionClasses` or hints. Reordering those checks changes what an unreviewed project file can authorize.
- The digest covers the launch fields. Adding a launch-relevant field to `McpServerDeclaration` without including it in `mcpServerDigest` would let a change to it leave an existing trust record valid.
- The file name of the trust state is separate from the cache. The trust file is under the config directory, the catalog under the cache directory, and the catalog stores no trust decision.
- `parseMcpConfigText` fails closed on any schema violation for the whole file. A single bad server removes all servers from that file.
- `readMcpTrustState` never writes. Callers that need to change the trust file go through `trustMcpServer` or `untrustMcpServer`, and both refuse to write over an unusable file.
- The Slurm defaults apply only to the operator's own `user`-scope declaration with id `slurm`. Changing that condition widens or narrows which Slurm tool names are auto-classified.

Related pages: [Tools](../tools.md), [Tools gateway](../tools/gateway.md), [Domains safety](safety.md), [Domains dispatch](dispatch.md), and [Tests contracts](../tests/contracts.md).
