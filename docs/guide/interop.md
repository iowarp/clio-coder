# Coding agent interoperability

> **Visual blueprint:** See the [visual reference](../html/interop_blueprint.html) in the source checkout.

Clio can discover resources held by Claude Code, Codex, Antigravity CLI,
GitHub Copilot CLI, and OpenCode, then adopt safe text resources into the
library after approval. Inspection and adoption use zero model tokens.
Gemini, Cursor, and the shared Agent Skills convention retain their existing
presence detection; this inventory does not extend their capabilities.

## Inspect installed hosts

```bash
clio-coder interop inspect
clio-coder interop inspect --json
```

Inspection reports binary presence, a bounded version probe (or unknown),
connection and ACP adapter state, and resource counts derived from the disk
inventory. User and current-project resources are distinguished. JSON omits
native source paths and declaration values, including MCP credentials.
A cache directory establishes available content; installation and activation
remain unknown unless a host's installation registry establishes them.
Malformed, unreadable, symbolic-link, oversized, or unsupported configurations
produce an unknown inventory diagnostic instead of an invented zero.

The scanner reads these configuration layouts, honoring the named host home
variable when present. An explicit fixture home ignores process host overrides.
It never traverses session history or starts a conversational agent.

| Host | User root | Project roots | Inventory and evidence commands |
| --- | --- | --- | --- |
| Claude Code | `~/.claude` (`CLAUDE_CONFIG_DIR`) | `.claude` | Skills, agents, commands, output styles, hooks, MCP (including `~/.claude.json` and project-root `.mcp.json`); installed plugin paths, versions and marketplace from `plugins/installed_plugins.json`. Evidence: `claude --version`, `claude plugin list --json`. |
| Codex | `~/.codex` (`CODEX_HOME`), shared `~/.agents` | `.codex`, `.agents` | Skills, TOML agents, legacy prompts, hooks, MCP, plugin cache and plugin configuration. Evidence: `codex --version`, `codex plugin list --json`. |
| Antigravity CLI | `~/.gemini/config` (`ANTIGRAVITY_HOME`) | `.agents` | Skills, agents, commands, plugins, import manifest, hooks, MCP. Evidence: `agy --version`, `agy plugin list`. Imported commands may already be converted into skills. |
| GitHub Copilot CLI | `~/.copilot` (`COPILOT_HOME`) | `.github`, `.copilot` | Skills, agents, commands, hooks, MCP, plugin directories and local directory marketplaces in `settings.json`. Remote marketplace source paths remain unknown when no local installation is found. Evidence: `copilot --help`, `copilot plugin --help`, `copilot plugin list`. |
| OpenCode | `~/.config/opencode` (`OPENCODE_CONFIG_DIR`, or `XDG_CONFIG_HOME/opencode`) | `.opencode` | Skills, singular/plural agent and command directories, MCP declarations and `opencode.json` at the project root, JavaScript/TypeScript plugins and tools. Evidence: `opencode --version`, `opencode agent list`. JSONC that cannot be parsed as JSON is reported unknown. |

The listing commands above were checked in disposable profiles; runtime inspection
uses the disk inventory and bounded version probes in disposable profiles, so
CLI alias or log side effects cannot change the operator's home or project. Listing status itself remains
unknown. In particular, Clio does not invoke OpenCode's agent listing against an
operator profile because host startup can import executable modules.

## Review and adopt

```bash
clio-coder interop adopt claude-code --dry-run
clio-coder interop adopt codex --kind skill --project
clio-coder interop adopt claude-code --kind plugin --user --yes
clio-coder interop adopt copilot --kind prompt --user
```

The host names are `claude-code`, `codex`, `antigravity`, `copilot`, and
`opencode`; `claude` and `agy` are accepted aliases. `--kind` selects `skill`,
`agent`, `prompt`, or `plugin`. The destination defaults to user scope;
`--project` chooses the current project's library. Destination scope does not
filter source scope: every matching discovered user and project resource is
reviewed in the plan.

The plan lists each source, destination, digest, and reason for installing or
skipping it. Its SHA-256 identifies the reviewed projection; the library engine
also records its standard full-tree integrity pin when publishing the package. `--dry-run` prints the plan and writes nothing. Otherwise Clio asks
for approval in a terminal. Without a terminal, the plan remains unexecuted
unless `--yes` was supplied. Declining installs nothing. Installation rechecks
the source against the reviewed content; a changed source requires a new plan.
Each package publishes atomically through the library engine; a multi-package
plan may report successful packages alongside failures.

| Resource | Adoption behavior |
| --- | --- |
| Skill | Text-only skill directory, with required name and description, packaged through the library engine. Executable, non-text, or symbolic-link companions cause a skip. Foreign audit stamps are not retained. |
| Prompt or command | Markdown body becomes a Clio prompt. Host execution settings and frontmatter are omitted; the description is retained. |
| Agent or subagent | Markdown persona or TOML `developer_instructions` becomes a Clio recipe limited to read, grep, find, and ls. Host tools, model, permissions, hooks, and skill bindings are omitted and the plan says so. |
| Plugin | Requires a valid portable root `plugin.json`. Clio adopts a data-only projection of its skills, prompts, agents, and text references. Host extension metadata, hooks, MCP, scripts, tools, fleets, and non-text files are omitted. Dependencies on removed components cause a skip. Package `requires` declarations are preserved; required packages must already be installed, active, and valid in the destination scope. Missing requirements are named in the plan, checked again after approval, and never imported automatically. |
| Hook, MCP server, executable module, output style | Listed as not adoptable, with a reason. Nothing is registered or executed. |

A Claude plugin carrying only `.claude-plugin/plugin.json` is not adoptable as a
whole plugin. The generated WTF-P Claude bundle now carries a portable root
manifest naming `wtfp` and its native Clio resources, so an installed
`wtfp@wtfp` can be adopted as the `wtfp` library plugin. Its executable host
integration is excluded. Instructions that reference omitted scripts do not
make those scripts available; adoption does not promise full workflow parity.

Installed packages retain `{kind: "interop", host, source}` provenance and
`trust: "foreign"`, with the original absolute source path. Skill and prompt
loading keeps the existing `integrations.projectResources.trustProjectImports`
opt-in, including when a project resource is adopted to user scope. Approval to
copy a resource does not grant that trust. Same plugin id/version or matching
installed package content is skipped; identifier collisions are not replaced.
Library integrity checks, drift detection, disable, and removal apply normally.
To refresh a foreign source, remove the old library package and review a new adoption plan; no host files are ever
moved, removed, or modified.

## Terminal flow

Open `/interop` to inspect inventory or connect an external delegation peer.
Inventory detail folds behind Enter and wraps in the scrolling detail pane.
Select a host, press `p` for a project destination or `u` for user, and press `k`
to cycle the kind filter. Press `i` to review the full adoption plan, then `y`
to approve it or `b` to return without installing. Escape closes the overlay.
Connection remains a separate action: `a` connects a proposed peer and `d`
declines it. `/agents connect` opens the same review surface.
