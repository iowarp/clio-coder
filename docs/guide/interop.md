# Coding agent interoperability

`detectInteropAgents` in [detect.ts](../../src/domains/interop/detect.ts) discovers local agents. The [library architecture](../architecture/library.md) explains package trust.

Clio can delegate a task to an installed coding agent, discover resources held
by Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, and OpenCode, and
adopt safe text resources into its library after approval. The canonical
`library/` sources this repository ships are also installable by Claude Code
and loadable by Codex without a converted copy. Inspection and adoption use
zero model tokens. Gemini, Cursor, and the shared Agent Skills convention
retain their existing presence detection; this inventory does not extend their
capabilities.

## Delegate work to an installed coding agent

Depending on the peer, Clio can run a named task through an Agent Client
Protocol (ACP) connection or a managed headless CLI target, or open an
interactive Herdr pane. Clio remains the main conversation and records a run
and receipt for ACP and headless dispatch. A pane is an interactive handoff
and has no managed result or receipt. External peers
are selected explicitly; Clio does not silently switch agents or modes.

| Peer | ACP connection | Headless target runtime | Pane ID |
| --- | --- | --- | --- |
| Claude Code | `npx -y @zed-industries/claude-code-acp@0.16.2` | `claude-code` | `claude-code` |
| Codex | `npx -y @agentclientprotocol/codex-acp@1.10.0` | `codex-cli` | `codex` |
| OpenCode | Native `opencode acp --cwd .` | `opencode-cli` | `opencode` |
| Antigravity CLI | No verified ACP recipe | `antigravity-code` | `antigravity` |
| Pi CLI | No verified ACP recipe | `pi-cli` | `pi` |

The recipes live in [registry.ts](../../src/domains/interop/registry.ts). Antigravity
CLI and Pi have no built-in ACP connection. An operator-configured ACP peer entry
can use a compatible adapter. A pinned bridge counts as verified only when that
package at the pinned version sits in the project's `node_modules`; otherwise
inspection reports the adapter as `unknown` and `npx` may fetch it at first
launch. OpenCode has no adapter package, so its binary is the whole recipe.

Clio starts an external `pi` with `--print --mode json --no-session --no-extensions --no-approve`.
Pi 0.99 and later also disable their built-in providers under `--no-extensions`, so
for those versions Clio adds `-e builtin:llama.cpp`, detected once per binary from
`pi --version`. A failed or unrecognized probe keeps the base flags and never
blocks the run.

Clio serves an ACP frontend of her own through `clio-coder acp`. The wire
contract, workspace pinning, MCP server pass-through, and the rules for attended
clients live in the [ACP architecture](../architecture/acp.md); a frontend that
advertises neither attended opt-in keeps the unattended behavior, where
`ask_user` is absent and a worker ask is not forwarded
([attended clients](../architecture/acp.md#attended-clients)).

Install and authenticate the peer's own CLI first. Run
`clio-coder interop inspect --json` or open `/interop` to see the installed binary, configured
target, ACP adapter, and available commands. `clio-coder configure --interop`
can add an ACP peer recipe; a headless mode needs a Clio target using the runtime
in the table. For example, these entries in `~/.config/clio-coder/settings.yaml`
make an installed OpenCode available in both managed modes:

```yaml
targets:
  - id: opencode-local
    runtime: opencode-cli
    defaultModel: opencode-cli-default # use OpenCode's selected model
integrations:
  externalAgents:
    entries:
      - id: opencode
        command: opencode
        args: [acp]
        toolGovernance: clio-coder-policy
```

Keep the rest of your settings when adding these entries. If OpenCode's provider
uses an environment credential such as `apiKey: "{env:LAB_GATEWAY_KEY}"` in its
user `opencode.json` or `opencode.jsonc`, the headless connector passes that
named variable to OpenCode when it is set. For ACP, add
`env: { LAB_GATEWAY_KEY: "{env:LAB_GATEWAY_KEY}" }` to that peer entry. Clio
resolves the reference at launch; the key value does not enter settings or the
receipt. Unrelated environment secrets stay out of headless CLI children by
default.

```text
/run --target opencode-local --worktree coder Fix the parser test and report the checks.
/delegate opencode Review the proposed parser change and its edge cases.
/peer --cwd /path/to/project codex Investigate the failing build.
```

`/run --worktree` preserves the peer's Git task branch for review and records
its path, branch, and changed files in the receipt. Without it, a headless peer
works in the current checkout and edits may appear immediately. A task worktree
separates Git changes but does not confine the peer's own filesystem, shell, or
network tools. Clio can mediate ACP permission requests a peer reports, but a
peer may write without requesting permission; receipts mark this enforcement
limit. OpenCode's headless path supports writable runs and refuses read-only
dispatched runs. Use the existing Git workflow to inspect and merge a
preserved branch, and use `/share` when the main agent should read a managed
result.

Clio-managed peer dispatches run at default permissions, even when the main
session uses yolo. Use `/run --read-only` for a headless target or
`/delegate --read-only` for an ACP peer to deny writes on that run. Headless
Codex uses `--sandbox read-only` or `workspace-write`; Claude Code uses
`--permission-mode plan` with a read-only `--tools` list, or `acceptEdits`;
Antigravity uses `--mode plan --sandbox` or `--mode accept-edits`; Pi limits
read-only runs to `--tools read,grep,find,ls`. OpenCode refuses a read-only
headless run before launch. ACP policy mediation denies non-read
permission requests and outside reads on a read-only delegation without
waiting for an operator. A peer configured with
`toolGovernance: agent-managed` is an explicit operator opt-in to peer-owned
tools, needs `trustedUnmediated: true` in user settings, and cannot accept a
read-only delegation. Delegation and pane handoff are also refused when the
session carries context restricted by an information-flow rule, because the
peer's own model requests are not admitted by Clio; see
[information flow](information-flow.md).

### Peer modes and their status

`interop inspect` and `/interop` list each peer's modes with a status, a reason,
and the next setup action. The `acp` row appears for a peer with a built-in
recipe or an operator-configured ACP entry, the `headless` row for a peer with a
managed runtime, and the `pane` row for a peer that has both a binary name and a
managed runtime. Statuses are `ready`, `experimental`, and `unavailable`. A
configured ACP or headless mode is never better than `experimental`, because
authentication, permission behavior, and the selected model are only proven by a
live task and its receipt. `ready` belongs to a pane, and only when `/interop`
sees a live Herdr pane host. `interop inspect` cannot observe a pane host, so it
reports a pane with an installed binary as `experimental`. A mode is
`unavailable` when the CLI is missing, no target uses the runtime, no ACP entry is
configured, or the pane host is known to be absent.

Connecting a detected peer (`a` in `/interop`, or `clio-coder configure --interop`)
appends an entry to `integrations.externalAgents.entries` with the registry id,
command and args, `connectTimeoutMs`, `turnTimeoutMs`, and
`toolGovernance: clio-coder-policy`. `projectContext` is omitted so it keeps its
default `none`, and the peer receives task text, never the project projection.
Without a terminal, `configure --interop` prints the proposals and writes
nothing. The operator's answer is stored in `interop.json` under the state
directory and suppresses a repeat proposal only while the binary, version, and
recipe are unchanged.

### Claude Agent SDK runtime

The `claude-sdk` target runtime runs Claude through the Claude Agent SDK
`query()` inside a Clio worker. It is a dispatch target, not an interop peer,
and it is separate from the `claude-code` runtime above, which spawns
`claude -p`. Neither the `claude-code` runtime nor the ACP bridge loads the SDK
package from Clio's package root.

The Claude Agent SDK package (`@anthropic-ai/claude-agent-sdk`, pinned 0.3.186,
about 224 MB) is an optional dependency that the Clio installers skip unless
`--include-claude-sdk` (`-IncludeClaudeSdk` on Windows) is passed. A plain npm,
pnpm, or bun install fetches it unless optional dependencies were omitted. Boot,
`doctor`, and every other runtime work without it, because the module loads only
when a `claude-sdk` run starts. On an install without it, the first dispatch to a
`claude-sdk` target, and `clio-coder configure` when it adds one, asks once
whether to install the package into Clio's own package root, defaulting to
`Not now`. The run or command instead fails with `CLAUDE_AGENT_SDK_UNAVAILABLE`
and prints the package-manager command to run when nobody can answer (a headless
run), when Clio was not installed by the installer scripts, or when the operator
declines. A decline holds until Clio restarts. [Installation and lifecycle](installation-and-lifecycle.md)
holds the flags, the exact commands, and the decision rules.

[sdk-runtime.ts](../../src/engine/claude/sdk-runtime.ts) mediates every SDK tool
call through Clio's shared admission evaluator, through both the `canUseTool`
callback and a `PreToolUse` hook. The run uses `permissionMode: "default"`, reads
no user Claude settings (`settingSources: []`), and persists no Claude session.
A call cannot be parked for a later decision, so an escalation posture collapses
to a deny. The runtime ends at its first execute-class refusal: the worker exits
3 with outcome `permission_required`. The native worker runtime instead returns
each refused execute call to the model as a tool result and ends on the third
(`WORKER_REFUSAL_LIMIT` in `src/engine/worker-refusals.ts`); the SDK runtime has
no such grace. `onPermission: "fail"` ends either runtime at the first refusal
that needed an approval, whatever its action class. See
[worker dispatch mechanics](../architecture/worker-dispatch-mechanics.md) for the
refusal table and the exit code.

## Outbound: Use this library from Claude Code

The repository is a standard Claude Code marketplace. `.claude-plugin/marketplace.json`
is generated by `pnpm run library:pin` from the pinned packages in
`library/registry.yaml`, so it cannot describe a package the repository does not
actually contain.

```bash
claude plugin marketplace add iowarp/clio-coder
claude plugin install tdd@clio-coder
claude plugin install materio@clio-coder
```

A local checkout or the installed npm package works the same way, because every
entry's source is a relative path inside the repository:

```bash
claude plugin marketplace add ./path/to/clio-coder
claude plugin marketplace add "$(npm root -g)/@iowarp/clio-coder"
```

The marketplace publishes 35 entries: the 34 curated skill packages and the
`materio` bundle. What each entry becomes on the Claude Code side:

| Source layout | What Claude Code loads |
| --- | --- |
| `library/skills/<category>/<name>/` with a root `SKILL.md` | One skill, named by the `SKILL.md` frontmatter, with its `references/` companions |
| `library/plugins/materio/` with a `skills/` directory | Materio's six portable skills and nothing else |

Nothing is converted and no recipe body is duplicated. The packages carry their
portable Agent Plugins `plugin.json`, which Claude Code does not read; the
marketplace entry supplies the name, description, version, category and license
it shows. `claude plugin validate . --strict` passes on the generated file, so no
entry needs `strict: false` and no package needs a second `.claude-plugin/plugin.json`.

Materio's Clio-native agents, prompts and fleets sit at declared resource paths
that no peer host scans. They travel with the installed bytes and are never
presented as Claude-native components. `claude plugin details materio` reports
`Skills (6)` and `Agents (0)`.

### Not every library package is published

A library package is published only when a host would load a real skill surface
from it, and only when it carries nothing that host default-scans into a native
component. Claude Code scans a plugin root for `agents/`, `commands/`, `hooks/`,
`output-styles/` and `.mcp.json` without being asked, so a package that keeps
Clio agent recipes in a top-level `agents/` directory would have them shown as
native Claude agents. The generator excludes packages with those conflicting roots, and
`pnpm run library:pin` prints the reason.

Those packages remain valid first-class library packages, and agent-, prompt- and
fleet-only packages are normal contributions. They simply have no peer-host
projection. An author who wants one package to serve both audiences declares its
Clio resource roots at paths no host scans, for example `"agents": "native/agents"`,
and keeps a `skills/` directory or root `SKILL.md` for the portable surface.

## Outbound: Use this library from Codex

Codex scans `.agents/skills` at the repository root, in the working directory and
in `$HOME`, recurses into subdirectories, and follows symlinks. The checkout does
not ship those links, so create them yourself. Linking the canonical trees into
your user skills root gives Codex all 34 curated skills and Materio's 6 portable
skills under their canonical names in every repository, with no install step and
no copied `SKILL.md`:

```bash
mkdir -p ~/.agents/skills
ln -s /path/to/clio-coder/library/skills ~/.agents/skills/clio-coder
ln -s /path/to/clio-coder/library/plugins/materio/skills ~/.agents/skills/materio
```

Symbolic links need OS permission on Windows. If you cannot create them, install
individual skills using the following route.

To install individual skills instead, use Codex's own installer, which accepts a
GitHub repository path:

```text
$skill-installer install tdd from iowarp/clio-coder/library/skills/coding/tdd
```

Disable one without deleting it through `[[skills.config]]` in `~/.codex/config.toml`.

There is deliberately no Codex plugin marketplace here. Portable Codex plugins
discover only a root `skills/` directory, the standalone packages carry a root
`SKILL.md`, and a `.codex-plugin` overlay cannot override that while the portable
root `plugin.json` is present. Publishing one would claim a compatibility that
does not exist.

## Inspect installed hosts

```bash
clio-coder interop inspect
clio-coder interop inspect --json
```

Inspection reports binary presence, a bounded version probe (or unknown),
connection and ACP adapter state, peer modes, and resource counts derived from
the disk inventory. User and current-project resources are distinguished. A
presence probe that cannot answer reports `unknown`, never `absent`. The JSON
form is `{version: 1, generatedAt, detectedAt, knownKinds, agents}`; each agent
carries `presence`, `version`, `acp`, `adapter`, `headless`, `paneEligible`,
`modes`, `configured`, `decision`, `proposed`, `needsNetworkInstall`, and an
`inventory` of counts and items with an `adoption` word (`review required` or
`not adoptable`). JSON omits native source paths and declaration values,
including MCP credentials. Any other argument exits 2.
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
| GitHub Copilot CLI | `~/.copilot` (`COPILOT_HOME`) | `.github`, `.copilot` | Skills, agents, commands, hooks, MCP, plugin directories and local directory marketplaces in `settings.json`. Remote marketplace source paths remain unknown when no local installation is found. Evidence: `copilot plugin list`. |
| OpenCode | `~/.config/opencode` (`OPENCODE_CONFIG_DIR`, or `XDG_CONFIG_HOME/opencode`) | `.opencode` | Skills, singular/plural agent and command directories, MCP declarations and `opencode.json` at the project root, JavaScript/TypeScript plugins and tools. Evidence: `opencode --version`, `opencode agent list`. JSONC that cannot be parsed as JSON is reported unknown. |

The evidence commands in the last column are the host's own listing commands,
recorded for an operator to run. Inspection never runs them: a host's startup can
import executable modules, and OpenCode's agent listing in particular is not
invoked against an operator profile. The only process Inspection starts is
`<binary> --version`, inside a scratch directory with scratch home and
`XDG_*` directories, a 2-second limit, and 4 KiB of output, so alias or log side
effects cannot change the operator's home or project. The `listing` field is
therefore always `unknown`.

## Inbound: Review and adopt foreign resources

### Adopt resources from an installed host

```bash
clio-coder interop adopt claude-code --dry-run
clio-coder interop adopt codex --kind skill --project
clio-coder interop adopt claude-code --kind plugin --user --yes
clio-coder interop adopt copilot --kind prompt --user
```

The host names are `claude-code`, `codex`, `antigravity`, `copilot`, and
`opencode`; `claude` and `agy` are accepted aliases. `--kind` selects `skill`,
`agent`, `prompt`, or `plugin`. The destination defaults to user scope;
`--project` chooses the current project's library, and naming both scopes is
refused. Destination scope does not filter source scope: every matching
discovered user and project resource is reviewed in the plan. An invalid host,
kind, or option exits 2, and an unknown inventory exits 1.

The plan lists each source, destination, digest, and reason for installing or
skipping it. Its SHA-256 identifies the reviewed projection; the library engine
also records its standard full-tree integrity pin when publishing the package.
`--dry-run` prints the plan and writes nothing. Otherwise Clio asks
for approval in a terminal. Without a terminal, the plan remains unexecuted
unless `--yes` was supplied. Declining installs nothing. Installation rechecks
the source against the reviewed content; a changed source requires a new plan.
Each package publishes atomically through the library engine; a multi-package
plan may report successful packages alongside failures, and any diagnostic exits 1.

| Resource | Adoption behavior |
| --- | --- |
| Skill | Text-only skill directory, with required name and description, packaged through the library engine. Executable, non-text, or symbolic-link companions cause a skip. Foreign audit stamps are not retained. |
| Prompt or command | Markdown body becomes a Clio prompt. Host execution settings and other frontmatter are omitted; the description and argument hint are retained. |
| Agent or subagent | Markdown persona or TOML `developer_instructions` becomes a Clio recipe limited to read, grep, find, and ls. Host tools, model, permissions, hooks, and skill bindings are omitted and the plan says so. |
| Plugin | Accepts a valid portable root `plugin.json`, or a supported `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` package. Clio adopts a data-only projection of its skills, prompts, agents, and text references. Host extension metadata, hooks, MCP, scripts, tools, fleets, and non-text files are omitted. Dependencies on removed components cause a skip. Package `requires` declarations are preserved; required packages must already be installed, active, and valid in the destination scope. Missing requirements are named in the plan, checked again after approval, and never imported automatically. |
| Hook, MCP server, executable module, output style | Listed as not adoptable, with a reason. Nothing is registered or executed. |

A source tree is read to at most 12 directory levels, 2048 files, and 16 MiB of text; a larger tree is refused.

Claude-only and Codex-only plugin manifests use the same reviewed conversion as
`library import`. Supported Claude commands become prompts, and Claude agent
bindings are retained when their required skills convert in the same package.
Unsupported companions and host features are listed in the plan. A portable
package is refused when retained recipes require omitted files; for example,
the WTF-P bundle requires action JSON files outside the supported text
projection. Use ordinary `library install` for a reviewed portable package whose
complete recipe assets are required, or import supported individual resources.

Installed packages retain `{kind: "interop", host, source}` provenance and
`trust: "foreign"`, with the original absolute source path. Skill and prompt
loading keeps the existing `integrations.projectResources.trustProjectImports`
opt-in, including when a project resource is adopted to user scope. Approval to
copy a resource does not grant that trust. Adoption also never approves
workspace trust: a `--project` adoption writes `.clio-coder/plugins/state.json`,
including the workspace's first, and the adopted package stays unloaded until
`clio-coder config trust plugins` approves the project's plugin state. A
`--user` adoption needs no workspace approval. Same plugin id/version or matching
installed package content is skipped; identifier collisions are not replaced.
Library integrity checks, drift detection, disable, and removal apply normally.
To refresh a foreign source, remove the old library package and review a new adoption plan; no host files are ever
moved, removed, or modified.

## Inbound: Install or import an explicit foreign package (Claude Code, Codex)

Adoption above starts from what an installed host already has. To install or import an explicit Claude Code plugin or Codex package from a local directory or a GitHub repository tree, use `clio-coder library import`:

```bash
clio-coder library import ./vendor/some-plugin --dry-run
clio-coder library import https://github.com/owner/repo/tree/main/plugins/thing --project
clio-coder library import ./vendor/some-plugin --format claude --yes
```

In an active session, `/library import <path-or-url>` stages and reviews that exact foreign package in the Library. When installing a Claude Code plugin or Codex package, Clio parses the vendor manifest (e.g. `.claude-plugin/plugin.json`) and presents an interactive review before any managed installation or workspace mutation occurs (staging writes temporary inspection files prior to acceptance). The review details four facets:
1. **Source and provenance**: the verified package source path or repository tree URL, the format (`claude-code` or `codex`), and the transport.
2. **Projected declarative resources**: text skills (with markdown instructions), commands (converted into prompts), and basic agent personas become native library recipes.
3. **Foreign trust tier**: the package is marked `trust: "foreign"`. Foreign package skills and prompts remain untrusted and withheld from model turns, at project scope and at user scope alike, until `integrations.projectResources.trustProjectImports` (`skills.trustProjectCompatRoots`) is enabled. Bound agent recipes require all referenced skills to be trusted.
4. **Unsupported and omitted components**: every executable foreign mechanism is omitted and listed in the review plan. That covers MCP servers (`.mcp.json`), lifecycle hooks (`hooks/`), shell scripts (`scripts/`), and daemon runners. They are never registered as harness tools or executed.

Cancelling the review cleans up temporary staging files without modifying managed package state or workspace files. The Library's `o` key is the separate route into the local-agent discovery surface below, which starts from what an installed host already has rather than from a source you name.

Detection is deterministic. A root `plugin.json` always takes precedence; an
invalid root is refused before any vendor fallback. With no root manifest, `.claude-plugin/plugin.json`
selects the Claude Code format and `.codex-plugin/plugin.json` selects Codex. When
both hidden manifests are present the import is ambiguous and `--format` is
required. A directory with none of the three is not importable.

Publication, content validation and the project-import trust gate are reported
separately. An enabled trust gate is a prerequisite for runtime admission, not
a claim that every recipe is available.

The same review contract as adoption applies: `--dry-run` prints the projected
plan and writes nothing, the plan names every converted resource, every
unsupported host feature and every omitted file, and the source directory is
never modified. Imported packages install with `trust: "foreign"` and keep
`{kind: "import", source, transport, format}` provenance, so they stay visibly
foreign in the library after installation. A skill whose instructions reference a
companion that was omitted is reported unsupported rather than claimed working.
An import, like an adoption, never approves workspace trust: a `--project`
import stays unloaded until `clio-coder config trust plugins` approves the
project's plugin state, in addition to the foreign trust gate above. When the
model runs `library import` through a shell it asks for one-shot confirmation
in `default`, and `--dry-run` never asks.

## Terminal flow

Open `/interop` to inspect inventory or connect an external delegation peer.
Inventory detail folds behind Enter and wraps in the scrolling detail pane.
Select a host, press `p` for a project destination or `u` for user, and press `c`
to cycle the kind filter. Press `i` to review the full adoption plan, then `y`
to approve it or `b` to return without installing. Escape closes the overlay.
Connection remains a separate action: `a` connects a proposed peer and `d`
declines it. `/agents` browses the library's own agent recipes and is a separate
surface from this one.
