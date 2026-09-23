# Configuration reference

This page is a map to the implemented configuration surface. Source defines the complete key, flag, and argument contracts; use the linked files when exact schemas or defaults matter. For setup choices, see [Configuration and targets](configuration-and-targets.md). For `CLIO_*` variables, see the [environment variable reference](environment-variables.md).

## Settings

Settings use one strict version-2 schema. Unknown keys and invalid values are errors; omitted keys take compiled defaults. Objects merge by key, while arrays and scalar values replace the lower layer.

| Precedence, low to high | Use |
| --- | --- |
| Compiled defaults | Baseline values in [`src/core/defaults.ts`](../../src/core/defaults.ts). |
| User `settings.yaml` | Personal defaults under the resolved Clio config directory. |
| `.clio-coder/settings.yaml` | Shared project defaults. Credential-bearing keys are ignored. |
| `.clio-coder/settings.local.yaml` | Untracked project overrides. Credential-bearing keys are ignored. |
| Session controls | `/settings`, `/model`, and `/thinking` change the active session where supported. |
| CLI options | Run-specific values such as `--target`, `--model`, and turn constraints. |

The schema, validation, migration paths, and user settings path are in [`src/core/config.ts`](../../src/core/config.ts). Layering and project-file merge behavior are in [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts). Settings control groups are defined in [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) and [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts).

| Need to inspect | Source of truth |
| --- | --- |
| Setting names, types, defaults, enums | [`src/core/defaults.ts`](../../src/core/defaults.ts) and [`src/core/config.ts`](../../src/core/config.ts) |
| Project settings precedence and secret filtering | [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts) |
| Settings UI sections and editable controls | [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts), [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) |
| Target and provider settings | [`src/domains/providers/`](../../src/domains/providers/) |
| CLI flags and accepted values | [`src/cli/args.ts`](../../src/cli/args.ts), then `clio-coder <command> --help` |
| Environment variables | [Environment variable reference](environment-variables.md) and their cited read sites |
| Built-in tool arguments | [`src/tools/`](../../src/tools/) and [Tool usage](tool-usage.md) |
| Agent recipe frontmatter | [`src/domains/agents/recipe-schema.ts`](../../src/domains/agents/recipe-schema.ts) |
| Prompt fragment metadata | [`src/domains/prompts/`](../../src/domains/prompts/) |
| Local model tags and knowledge | [`src/domains/providers/models/local-models/`](../../src/domains/providers/models/local-models/) |

## Project files

Project configuration lives under `.clio-coder/`. The owning loader or validator is authoritative for each file's schema.

| File | Purpose / owner |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Shared and local settings layers; `src/core/settings-layers.ts` |
| `safety.yaml` | Project command and path policy; `src/domains/safety/project-policy.ts` |
| `mcp.yaml` | Project MCP declarations; [trust rules below](#local-stdio-mcp-configuration-and-trust), `src/domains/gateway/mcp/config.ts` |
| `verifiers.yaml` | Declared verification checks; `src/tools/verify/catalog.ts` |
| `hooks.yaml`, `hooks.local.yaml` | Project and local middleware hooks; `src/domains/middleware/hooks-io.ts` |
| `profile.yaml` | Project operator profile; `src/domains/context/operator-profile.ts` |
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

CLI help is generated from the registered command surface. Run `clio-coder --help` or `clio-coder <command> --help` for the installed version; the parser lives in [`src/cli/`](../../src/cli/), with headless run options in [`src/cli/args.ts`](../../src/cli/args.ts).

Tool schemas are registered in [`src/tools/`](../../src/tools/). Use [Tool usage](tool-usage.md) for operational behavior and source for exact argument types. Runtime-discovered MCP and extension schemas are supplied by those integrations rather than a static settings catalog.
