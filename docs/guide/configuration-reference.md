# Configuration reference

This page is a map to the implemented configuration surface. Source defines the complete key, flag, and argument contracts; use the linked files when exact schemas or defaults matter. For setup choices, see [Configuration and targets](configuration-and-targets.md). For `CLIO_*` variables, see the [environment variable reference](environment-variables.md).

## Settings keys

Settings use one strict version-2 schema. Unknown keys and invalid values are errors; omitted keys take compiled defaults. Objects merge by key, while arrays and scalar values replace the lower layer.

The table lists the leaves in `DEFAULT_SETTINGS`. Types, accepted values, optional schema fields, validation, and change timing live in [`src/core/defaults.ts`](../../src/core/defaults.ts) and [`src/core/config.ts`](../../src/core/config.ts).

### Chat settings

Default chat settings control interactive conversation routing, reasoning effort, token output budgets, and prefix prewarming:
- `chat.target`: default chat target id (`null`).
- `chat.model`: default chat model id (`null`).
- `chat.thinkingLevel`: default reasoning effort for the chat model (`"low"`; clamped to supported provider levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- `chat.prewarm`: whether prompt-prefix prewarming runs on session start (`false`). When enabled, prewarming runs against local-native servers or verified LiteLLM → LM Studio deployments to prefill prompt prefixes before the first turn. Dispatched workers and headless runs do not prewarm.
- `chat.maxOutputTokens`: per-turn output token limit (`0`, meaning model cap).
- `chat.retry.*`: retry backoff (`baseDelayMs: 2000`, `maxDelayMs: 60000`), attempt limit (`maxRetries: 3`), and stream stall timeouts (`streamStallMs: 180000`, `firstTokenStallMs: 600000`).

| Key | Default |
| --- | --- |
| `version` | `2` |
| `targets` | `[]` |
| `chat.target` | `null` |
| `chat.model` | `null` |
| `chat.thinkingLevel` | `"low"` |
| `chat.modelPicker.cycleSet` | `[]` |
| `chat.modelPicker.favorites` | `[]` |
| `chat.modelPicker.recentLimit` | `12` |
| `chat.maxOutputTokens` | `0` |
| `chat.prewarm` | `false` |
| `chat.retry.enabled` | `true` |
| `chat.retry.maxRetries` | `3` |
| `chat.retry.baseDelayMs` | `2000` |
| `chat.retry.maxDelayMs` | `60000` |
| `chat.retry.streamStallMs` | `180000` |
| `chat.retry.firstTokenStallMs` | `600000` |
| `fleet.default.target` | `null` |
| `fleet.default.model` | `null` |
| `fleet.default.thinkingLevel` | `"off"` |
| `fleet.profiles` | `{}` |
| `fleet.rosters` | `{}` |
| `fleet.agentProfiles` | `{}` |
| `fleet.decisionProfiles` | `{}` |
| `fleet.speculativeDispatch` | `false` |
| `fleet.nodes` | `[]` |
| `fleet.adaptiveRouting.roles` | `[]` |
| `fleet.adaptiveRouting.postures` | `[]` |
| `fleet.adaptiveRouting.agentRoles` | `[]` |
| `fleet.permissions.mode` | `"deny"` |
| `fleet.permissions.escalation.timeoutMs` | `120000` |
| `fleet.permissions.escalation.fallback` | `"deny"` |
| `fleet.concurrency` | `"auto"` |
| `fleet.worktrees.root` | `"disk"` |
| `fleet.retry.maxRetries` | `2` |
| `fleet.retry.routeCooldownMs` | `15000` |
| `fleet.retry.breakerThreshold` | `1` |
| `fleet.limits.toolCallsPerRun` | `150` |
| `fleet.limits.internalRunTimeoutMs` | `900000` |
| `fleet.history.maxRuns` | `1000` |
| `fleet.history.journal` | `true` |
| `context.toolResultMaxBytes` | `65536` |
| `context.workingSet.enabled` | `true` |
| `context.workingSet.policy` | `"structural-v1"` |
| `context.workingSet.target` | `0.6` |
| `context.workingSet.protectLastTurns` | `6` |
| `context.workingSet.minEvictableTokens` | `200` |
| `context.compaction.auto` | `true` |
| `context.compaction.threshold` | `0.8` |
| `context.memory.enabled` | `true` |
| `context.memory.target` | `null` |
| `context.memory.model` | `null` |
| `context.memory.cadenceToolCalls` | `10` |
| `context.memory.trajectorySteps` | `8` |
| `context.memory.maxOutputTokens` | `2000` |
| `context.memory.timeoutMs` | `60000` |
| `safety.autonomy` | `"auto-edit"` |
| `safety.limits.sessionCostUsd` | `5` |
| `safety.limits.chatToolCallsPerTurn` | `60` |
| `safety.limits.readBytesPerCall` | `51200` |
| `safety.limits.observationBytesPerTurn` | `196608` |
| `safety.review.enabled` | `false` |
| `interface.demo` | `true` |
| `interface.terminalProgress` | `false` |
| `interface.outputDetail` | `"standard"` |
| `interface.mode` | `"regular"` |
| `interface.fullscreenScrollbar` | `"auto"` |
| `interface.smoothStreaming` | `"auto"` |
| `interface.desktopNotifications` | `false` |
| `interface.panes.enabled` | `"off"` |
| `interface.panes.notifications` | `"failures"` |
| `interface.panes.layout` | `"off"` |
| `interface.panes.workers.ratio` | `0.34` |
| `interface.panes.files.enabled` | `false` |
| `interface.panes.files.mode` | `"companion"` |
| `interface.panes.files.profile` | `"managed"` |
| `interface.panes.files.followCwd` | `true` |
| `interface.panes.files.ratio` | `0.3` |
| `interface.keybindings` | `{}` |
| `integrations.projectResources.trustProjectImports` | `false` |
| `integrations.externalAgents.entries` | `[]` |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `0` |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` |
| `integrations.externalAgents.defaults.toolGovernance` | `"clio-coder-policy"` |
| `integrations.runtimePlugins` | `[]` |
| `integrations.library.catalog` | `null` |
| `integrations.library.remote` | `null` |
| `integrations.library.confirmedRemote` | `null` |
| `integrations.library.sync` | `false` |
| `integrations.git.commitAttribution` | `true` |

| Precedence, low to high | Use |
| --- | --- |
| Compiled defaults | Baseline values in [`src/core/defaults.ts`](../../src/core/defaults.ts). |
| User `settings.yaml` | Personal defaults under the resolved Clio config directory. |
| .clio-coder/settings.yaml | Shared project defaults. Credential-bearing keys are ignored. |
| .clio-coder/settings.local.yaml | Untracked project overrides. Credential-bearing keys are ignored. |
| Session controls | `/settings`, `/model`, and `/thinking` change the active session where supported. |
| CLI options | Run-specific values such as `--target`, `--model`, and turn constraints. |

The schema, validation, migration paths, and user settings path are in [`src/core/config.ts`](../../src/core/config.ts). Layering and project-file merge behavior are in [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts). Settings control groups are defined in [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) and [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts).

| Need to inspect | Source of truth |
| --- | --- |
| Setting names, types, defaults, enums | [`src/core/defaults.ts`](../../src/core/defaults.ts) and [`src/core/config.ts`](../../src/core/config.ts) |
| Project settings precedence and secret filtering | [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts) |
| Settings UI sections and editable controls | [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts), [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) |
| Target and provider settings | [`src/domains/providers/`](../../src/domains/providers/registry.ts) |
| CLI flags and accepted values | [`src/cli/args.ts`](../../src/cli/args.ts), then `clio-coder <command> --help` |
| Environment variables | [Environment variable reference](environment-variables.md) and their cited read sites |
| Built-in tool arguments | [`src/tools/`](../../src/tools/registry.ts) and [Tool usage](tool-usage.md) |
| Agent recipe frontmatter | [`src/domains/agents/recipe-schema.ts`](../../src/domains/agents/recipe-schema.ts) |
| Prompt fragment metadata | [`src/domains/prompts/`](../../src/domains/prompts/compiler.ts) |
| Local model tags and knowledge | [`src/domains/providers/models/local-models/`](../../src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml) |

## Project files

Project configuration lives under `.clio-coder/`. The owning loader or validator is authoritative for each file's schema.

| File | Purpose / owner |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Shared and local settings layers; [settings-layers.ts](../../src/core/settings-layers.ts) |
| `safety.yaml` | Project command and path policy; [project-policy.ts](../../src/domains/safety/project-policy.ts) |
| `mcp.yaml` | Project MCP declarations; [trust rules below](#local-stdio-mcp-configuration-and-trust), [config.ts](../../src/domains/gateway/mcp/config.ts) |
| `verifiers.yaml` | Declared verification checks; [catalog.ts](../../src/tools/verify/catalog.ts) |
| `hooks.yaml`, `hooks.local.yaml` | Project and local middleware hooks; [hooks-io.ts](../../src/domains/middleware/hooks-io.ts) |
| `profile.yaml` | Project operator profile; [operator-profile.ts](../../src/domains/context/operator-profile.ts) |
| `agents/`, `fleets/` | Agent recipes and fleet definitions; `src/domains/agents/` |
| `prompts/`, `rules/`, `skills/` | Prompt fragments, rules, and skills; `src/domains/prompts/`, `src/domains/middleware/`, `src/domains/resources/` |

## Local stdio MCP configuration and trust

User MCP declarations are stored at `<config>/mcp.yaml`; project declarations are stored at `.clio-coder/mcp.yaml`. The declaration contract is implemented in [`src/domains/gateway/mcp/config.ts`](../../src/domains/gateway/mcp/config.ts).

| Declaration | Launch rule |
| --- | --- |
| User scope | Trusted by file ownership; actions still pass through tool policy. |
| Project scope | Does not launch until an operator trusts the declaration with `clio-coder mcp trust <id>` or `/mcp trust <id>`. |
| Trust record | User-owned `<config>/mcp-trust.json`, bound to project root, server id, and declaration digest. |
| Changed declaration | Editing command, args, cwd, environment, or timeout makes trust stale; review and trust it again. |
| Trust boundary | Trust enables launch; it is not operating-system isolation. Server annotations do not grant authority. |

Trust and declaration loading are implemented in [`src/domains/gateway/mcp/trust.ts`](../../src/domains/gateway/mcp/trust.ts). The model-facing discovery and call contract is in [gateway tool usage](tool-usage.md#gateway-discover-and-call-secondary-capabilities).

## Exact CLI and tool contracts

CLI help is generated from the registered command surface. Run `clio-coder --help` or `clio-coder <command> --help` for the installed version; the parser lives in [`src/cli/`](../../src/cli/index.ts), with headless run options in [`src/cli/args.ts`](../../src/cli/args.ts).

Tool schemas are registered in [`src/tools/`](../../src/tools/registry.ts). Use [Tool usage](tool-usage.md) for operational behavior and source for exact argument types. Runtime-discovered MCP and extension schemas are supplied by those integrations rather than a static settings catalog.

## CLI flags

### `context`

| Flag | Controls |
|---|---|
| `--all` | For `context reset`, also remove the local CLIO-CODER.md after a second confirmation; override files stay human-owned. |
| `--budgets` | For `context replay`, comma-separated positive-integer token budgets each policy is replayed against. |
| `--depth` | For `context wiki`, generation depth: `auto`, `simple`, `medium`, or `detailed`. |
| `--help` | Print the command's usage and exit. |
| `--json` | For `context index`, emit JSON; for `context replay`, `--json <path>` writes the stable JSON report to that path instead. |
| `--md` | For `context replay`, path to write the Markdown report to instead of printing it. |
| `--min-evictable-tokens` | For `context replay`, non-negative integer tool-result size in tokens below which results are never evicted. |
| `--model` | For `context wiki`, wire model id for the documenter model instead of the configured one; pair with `--target`. |
| `--no-filter` | For `context replay`, include every readable transcript instead of only the filtered active-path sessions. |
| `--policies` | For `context replay`, comma-separated policy ids from none, random, age-horizon, structural-v1, oracle. |
| `--protect-last-turns` | For `context replay`, integer (at least 1) count of recent user turns whose observations are never evicted. |
| `--seed` | For `context replay`, integer seed for the deterministic random policy. |
| `--session` | For `context working-set`, the session id or path whose working-set fold and path index are printed (required). |

## Tool arguments

### `context`

| Argument | Class | Controls |
|---|---|---|
| `context.include_tree` | policy | scope=skills: list files under the skill base_dir. |
| `context.limit` | policy | scope=settings: max controls (default/max 12); scope=recall discovery: max refs (default 8, max 12). |
| `context.name` | task | scope=skills: skill name to load; omit to list. |
| `context.query` | task | scope=settings: path, section alias, or search terms; scope=recall discovery: path, tool, or ref terms; omit to list. |
| `context.ref` | task | scope=recall: ref of the evicted item, as named in its marker. |
| `context.scope` | policy | workspace, settings, skills, or recall. |
| `context.offset` | policy | Zero-based settings or recall discovery offset; follow nextOffset. |

