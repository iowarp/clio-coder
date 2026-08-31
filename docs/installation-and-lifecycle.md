# Installation and Lifecycle Operations

Clio Coder is designed to be self-contained and platform-compliant. This document outlines the default directory paths, file purposes, permission levels, and lifecycle commands (`install`, `reset`, `upgrade`, and `uninstall`). Clio Coder installs from npm as `@iowarp/clio-coder` (`npm install -g @iowarp/clio-coder`, published since v0.3.0) or from a source checkout with a deterministic local symlink; the CLI classifies both install kinds and `clio-coder upgrade` handles each.

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with a path simulator and visual flowcharts is located at [docs/html/lifecycle_blueprint.html](html/lifecycle_blueprint.html) (Version: 0.3.9). You can open it directly in any web browser to view details dynamically.

### Optional dependency: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` is an `optionalDependencies` entry, not a hard dependency. Its platform package carries a proprietary binary of roughly 224MB per platform, and only the `claude-sdk` runtime uses it. Skip it with:

```bash
npm install -g @iowarp/clio-coder --omit=optional
```

Measured on Linux x64 with a production install (`--omit=dev`): 387MB across 118 packages with the SDK, 143MB across 109 packages without it. That is 244MB and nine packages saved, a 63% smaller tree, and what remains is fully open-licensed.

Everything except the `claude-sdk` runtime works on the smaller install: boot, `clio-coder doctor`, every other target and worker runtime. Dispatching a `claude-sdk` target on an install that omitted the package fails that run with a diagnostic naming the package and the command that fixes it (`npm install @anthropic-ai/claude-agent-sdk@0.3.186`); nothing else degrades, and nothing fails at startup.

---

## 1. Directory Layout & Platform Defaults

Clio Coder follows standard platform specifications for user configurations, databases, and caches, but allows full environment overrides.

### Platform Defaults
| Operating System | Config (`configDir`) | Data (`dataDir`) | State (`stateDir`) | Cache (`cacheDir`) |
| :--- | :--- | :--- | :--- | :--- |
| **Linux / Unix** | `~/.config/clio-coder` | `~/.local/share/clio-coder` | `~/.local/state/clio-coder` | `~/.cache/clio-coder` |
| **macOS** | `~/Library/Application Support/clio-coder/config` | `~/Library/Application Support/clio-coder/data` | `~/Library/Application Support/clio-coder/state` | `~/Library/Caches/clio-coder` |
| **Windows** | `%APPDATA%\clio-coder\config` | `%APPDATA%\clio-coder\data` | `%LOCALAPPDATA%\clio-coder\state` | `%LOCALAPPDATA%\clio-coder\cache` |

Run `clio-coder paths [--json]` to print the resolved table for the current environment.

### Environment Overrides
You can redirect Clio Coder's folders using environment variables:
*   `CLIO_CODER_HOME`: Sets a symmetric tree: `$CLIO_CODER_HOME/config`, `$CLIO_CODER_HOME/data`, `$CLIO_CODER_HOME/state`, and `$CLIO_CODER_HOME/cache`.
*   `CLIO_CODER_CONFIG_DIR`: Overrides the configuration directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_DATA_DIR`: Overrides the data directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_STATE_DIR`: Overrides the state directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_CACHE_DIR`: Overrides the cache directory only (takes precedence over `CLIO_CODER_HOME`).

### The Project `.clio-coder/` Directory

The tables above cover the per-user roots. A repository Clio works in also grows a
`.clio-coder/` directory, and everything in it falls into one of three kinds:

*   **Operator input.** You wrote it. Clio only reads it. Deleting it removes a
    behavior you configured and nothing else.
*   **Runtime state.** Clio wrote it. It is derived from your repository and can be
    regenerated, though not always cheaply.
*   **Overlay.** You wrote it, and it composes with a directory Clio ships. The
    overlay column below says how.

| Path | Kind | What it is | Safe to delete? | `context reset` |
| :--- | :--- | :--- | :--- | :--- |
| `.clio-coder/settings.yaml`, `.clio-coder/settings.local.yaml` | Operator input | Project settings layered over the user's `settings.yaml`. Precedence is built-in < user < project < project-local. | Yes; the user-level settings apply again. | Kept |
| `.clio-coder/safety.yaml` | Operator input | Per-repository command allowlist consulted before execute actions. | Yes; approvals return to per-action prompting. | Kept |
| `.clio-coder/hooks.yaml`, `.clio-coder/hooks.local.yaml` | Operator input | Project-declared hooks. | Yes. | Kept |
| `.clio-coder/rules/**/*.md` | Operator input | Path-scoped project rules injected into the prompt. | Yes. | Kept |
| `.clio-coder/profile.yaml` | Operator input | Operator profile; closed enums and bounded path lists. | Yes. | Kept |
| `.clio-coder/fleets/*.md`, `.clio-coder/fleets/commands.yaml` | Overlay | Fleet contracts and their command registry. Adds to the fleets shipped under `src/domains/agents/fleets/`. | Yes; shipped fleets remain. | Kept |
| `.clio-coder/agents/*.md` | Overlay | Project agent recipes. Composes with shipped builtins and the user's `~/.config/clio-coder/agents`; a project recipe reusing a builtin id is **ignored**, not applied, with a note on stderr. | Yes; shipped agents remain. | Kept, and named |
| `.clio-coder/skills/**` | Overlay | Project skills, trusted as repository-local. This is where `clio-coder skills install <name>` lands a catalog skill; the shipped catalog under the package's `skills/` is a marketplace to install from, not a discovery root, so nothing appears here until the operator installs it. | Yes; the shipped catalog remains installable. | Kept, and named |
| `CLIO-CODER.md` (repository root) | Runtime state | The generated project handbook. Human-reviewable, but written by `context init`. | Yes; regenerate with `clio-coder context init`. | Kept unless `--all` |
| `.clio-coder/codewiki.json` | Runtime state | Structural index, schema v5. | Yes; rebuilt by `clio-coder context index`. | **Removed** |
| `.clio-coder/state.json` | Runtime state | Index fingerprint and freshness stamps. | Yes; forces a rebuild. | **Removed** |
| `.clio-coder/proposals/` | Runtime state | Ignored handbook drafts from `context init --propose`. | Yes. | **Removed** |
| `.clio-coder/handoffs/` | Runtime state | Session handoff notes. | Yes. | **Removed** |
| `.clio-coder/wiki/` | Runtime state | The generated Markdown wiki plus `meta.json`. The most expensive artifact here: one model dispatch per page. | Yes, but regenerating costs a full `clio-coder context wiki` run. | Kept, and named |
| `.clio-coder/wiki-prev/` | Runtime state | Previous wiki, retained for rollback during generation. | Yes. | Kept, not named |
| `.clio-coder/worktrees/` | Runtime state | Git worktrees for `compete` candidate groups. | Prefer `git worktree remove`; a plain delete leaves git metadata behind. | Kept, not named |

`~/.config/clio-coder/runtimes/` holds third-party runtime plugins. It lives under the
user configuration directory, not in any repository.

None of `.clio-coder/` is published by Clio's own package. The directories Clio ships
(`src/domains/agents/builtins/`, `src/domains/agents/fleets/`, the whole `skills/` catalog
with its `registry.yaml` and `skill-marketplace.json`, `src/domains/prompts/fragments/`,
`src/domains/providers/models/`) are read from the installed package root; the `.clio-coder/`
entries above compose with them and never replace them on disk. Builtin agent recipes bind
skills straight out of the package catalog; the operator's own session reaches the same
catalog only as a marketplace, through `clio-coder skills install <name>` or `/skill <name>`.

---

## 2. File & Permissions Matrix

The core files are created automatically during the first run. `credentials.yaml` is the secret-bearing file and is forced to owner-only read-write permissions. Other initialized files and directories use either the explicit mode shown below or the platform default produced by the writer and process umask.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and theme preferences. | `0o644` (rw-r--r--) | Removed by uninstall / `reset --config`. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio-coder auth`. | `0o600` (rw-------) | Removed by uninstall / `reset --auth`. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **State** | `install.json` | Install metadata: Clio version, node, platform, `installedAt` (written once at first install), `upgradedAt` and `upgradedFrom` (stamped on a version change), and `noticedVersion` (the version whose one-time upgrade notice the interactive launch has shown). | Writer/umask default | Removed by uninstall / `reset --state`. |
| **State** | `migrations.json` | Log of successfully applied schema/state migrations. | Writer/umask default | Removed by uninstall / `reset --state`. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | Writer/umask default | Removed by uninstall / `reset --data`. |
| **Data** | `tools/<id>/<version>/` | One pinned external program Clio downloaded on request (`clio-coder tools install <id>`), with its upstream license text and a `clio-install.json` recording url, sha256, platform and install time. Binaries `0o755`, documents `0o644`. Only the pinned version is kept: a successful install prunes the versions it supersedes. | `0o755` dir | `clio-coder tools remove <id>` deletes every version of one tool; removed by uninstall / `reset --data`. |
| **State** | `audit/YYYY-MM-DD.jsonl` | Daily safety audit logs showing allowed/blocked tool actions. | Writer/umask default | Removed by uninstall / `reset --state`. |
| **State** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | Writer/umask default | Removed by uninstall / `reset --state`. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls `initializeClioHome()` (see `src/core/init.ts`) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates the four roots (`config`, `data`, `state`, `cache`) and their skeletons: `agents` under config, `memory`/`evidence`/`evals` under data, and `sessions`/`audit`/`receipts`/`interviews`/`scratch` under state.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config. An existing file is never read, validated, or rewritten by initialization.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates a YAML file containing a managed-file comment and an empty object (`{}`), then locks its permissions immediately to owner-only read-write (`0o600`).
4.  **Install Metadata**: Writes `install.json` with `installedAt` exactly once at first install; a later version, platform, or node change preserves `installedAt` and stamps `upgradedAt`, and a version change also records the previous version as `upgradedFrom`.

---

## 4. Source Checkout Install

Use the local source installer from the cloned repository:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio-coder --version
```

`scripts/install-local.sh` is idempotent and auditable:

- verifies `node` satisfies `package.json` `engines.node`;
- runs `npm ci` unless `node_modules` satisfies the lockfile or `--skip-deps` is passed;
- runs `npm run build` unless `--no-build` is passed;
- verifies `dist/cli/index.js` exists and is executable;
- creates `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` and links `clio-coder` there;
- warns if that bin dir is not on `PATH`, and warns when another `clio-coder`
  earlier on `PATH` shadows the freshly linked one;
- runs the installed CLI's structure repair (`node dist/cli/index.js doctor
  --fix` with the caller's environment), so a fresh install passes plain
  `clio-coder doctor` with no manual steps.

On a machine where Clio has never run, plain `clio-coder doctor` prints one
`WARN installation  not set up yet` row, exits 0, and creates nothing (it is a
read-only diagnosis, and an untouched home is not a broken one). Launching
`clio-coder`, running `clio-coder configure`, or `clio-coder doctor --fix`
creates everything; once any root exists, doctor reports each missing piece and
exits 1 until it is repaired.

First-run target setup after install:

**Option A: Local Model / API Key Target**
```bash
clio-coder configure --list
clio-coder configure --id local-lmstudio --runtime lmstudio --url http://localhost:1234 --model your-model --set-orchestrator --set-fleet-default
clio-coder targets use local-lmstudio
clio-coder targets --probe
clio-coder
```

**Option B: Subscription Target (OAuth / Claude Code)**
```bash
# Authenticate ChatGPT Plus/Pro or Claude Pro/Max subscription
clio-coder auth login openai-codex
clio-coder auth login anthropic-max

# Authenticate Claude CLI for worker targets
claude auth login

# Configure OAuth subscription target
clio-coder configure --id claude-sub --runtime anthropic-max --model your-claude-model --set-orchestrator

# Configure Claude Code SDK worker target
clio-coder configure --id claude-sdk-worker --runtime claude-sdk --model your-claude-model --set-fleet-default

clio-coder targets use claude-sub
clio-coder targets --probe
clio-coder
```

If a shell still tries an old removed path such as `~/.local/bin/clio-coder`, clear
its command cache with `hash -r` in Bash or `rehash` in Zsh.

## 5. Lifecycle Commands

Clio Coder provides CLI utilities to manage operations safely. For a complete catalog of operational errors, permission denial handling, and remediation procedures, see [troubleshooting.md](troubleshooting.md).

### A. Integrity Diagnostics (`clio-coder doctor`)
Runs a series of health sweeps across the environment:
*   Validates `settings.yaml` against the strict schema, reporting exact key paths, read-only.
*   Asserts owner-only permissions on credentials (`0o600`).
*   Reports the installed Clio, Node, platform, and engine package readiness.
*   Checks config, data, state, cache, and state metadata freshness. It also warns when an OpenAI-compatible or Anthropic-compatible target appears to be a native LM Studio or Ollama server that should be converted.
*   *Recovery:* Run `clio-coder doctor --fix` to create missing directories and templates, repair credential permissions, and refresh install metadata. Settings are always validated against the current schema; `--fix` does not rewrite removed keys or migrate an older settings file, so the operator must correct every reported path deliberately.

### B. Upgrades (`clio-coder upgrade`)
Refreshes state metadata and applies pending data-dir migrations.
```bash
clio-coder upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations]
```
The command detects the install method from the running binary. On a source
checkout it never runs `npm install -g`: it performs its safe local duties
(migration check, `install.json` refresh) and prints the real update steps,
`git pull`, `npm run install:local`, `hash -r`. The npm reinstall path applies
only to a genuinely npm-installed binary.

#### Upgrading from 0.3.0

Nothing has to be done by hand. On an npm install, one command does it all:

```bash
clio-coder upgrade
```

The 0.3.0 binary prints its header (`install npm`, `channel latest`,
`current 0.3.0`), runs `npm install -g @iowarp/clio-coder@latest`, and then
hands over to the binary that install just put on `PATH` with
`clio-coder upgrade --post-install`. That newer binary runs the migration
check, records `2026-08-18-lmstudio-runtime-id` in `state/migrations.json`, and
normalizes any legacy LM Studio target id, websocket URL, and stored credential
name. It then runs `clio-coder doctor --fix`,
which refreshes `install.json`, and reports the transition as
`ok: 0.3.0 -> 0.3.1 (migrations: 1)`. The outer 0.3.0 process closes with
`ok: 0.3.0 -> post-install checks complete`. Under nvm or a custom npm prefix
this works because `npm install -g` and the bare `clio-coder` resolve through
the same prefix; the doctor rows the child prints are the proof of which binary
answered. `clio-coder upgrade --dry-run` first names the exact command it would
run, names the pending LM Studio migration, and prints
`would refresh state metadata 0.3.0 -> 0.3.1` without touching the record.

If you instead ran `npm install -g @iowarp/clio-coder` yourself, or launched
the new binary before running `upgrade`, plain `clio-coder doctor` shows one
failing row, `state metadata  stale 0.3.0 (...); current 0.3.1`, pointing at
`clio-coder doctor --fix`, and exits 1. Either `clio-coder doctor --fix` or the
next `clio-coder` launch refreshes it. `install.json` then reads
`version: 0.3.1`, keeps the original `installedAt`, and gains `upgradedAt` and
`upgradedFrom: "0.3.0"`; doctor's row becomes
`0.3.1 (installed ..., upgraded ... from 0.3.0)`.

#### Upgrading to 0.3.3

Upgrading from 0.3.1 to 0.3.3 is automated:

```bash
clio-coder upgrade
```

Key lifecycle and operational updates in v0.3.7:
- Upgraded the underlying engine SDK libraries to 0.84.0 with signal-aware OAuth cancellation.
- Hardened migration resilience: damaged `credentials.yaml` files no longer block upgrades when no renames are needed (#121); `--skip-migrations` is available as a recovery override.
- Fullscreen TUI mode (`terminal.tuiMode`, `terminal.fullscreenScrollbar`) is available via Settings → Terminal (restart required). Adaptive presentation pacing is the live `terminal.smoothStreaming` setting; 0.3.3 defaults it to `off`, with conservative `auto` and explicit `on` available from the same section.
- Interactive launch paints a measured Stage 0 shell on the same terminal and editor that Stage 1 hydrates. Typing, queued submits, resize, and Ctrl+C remain live during hydration; set `CLIO_CODER_INSTANT_SHELL=0` for the legacy fully hydrated first-frame path.
- Turn settlement is enforced on `/new`, `/resume`, `/tree`, and `/fork` to cleanly commit in-flight streams before session writer replacement (#114).
- Resumed and forked session entry replays standardize message prefixes through `src/engine/messages.ts`.
- `AI_AGENT=clio-coder` is set on all child processes for system attribution.

The first interactive launch after upgrading shows the version notice:
`clio: upgraded 0.3.1 → 0.3.3. What changed at the keyboard: ...`
Recorded once per version in `install.json` as `noticedVersion`.

### C. System Resets (`clio-coder reset`)
Selective recovery wipes:
```bash
clio-coder reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force]
```
Levels are combinable except `--all`. Each level clears exactly the root or file it names and nothing else, then bootstraps the missing structure again unless `--dry-run` is present. `--force` is required only for destructive execution.

Every run lists each selected root and then the entries inside it, read off the
disk on that run, before removing anything; `--dry-run` prints the identical
listing. That listing, not this page and not `--help`, is the authoritative
inventory of what a level covers, because a remembered list drifts as soon as a
new artifact is written into a root.

*   `--state` *(Default)*: Deletes the state root only. It holds every session transcript and the audit trail beside it, so a reset is the end of `resume`, `/view`, and their history. This is the level a bare `clio-coder reset` selects, and it carries that note in its preview.
*   `--data`: Deletes the data root only: memory, evidence, evals (durable products).
*   `--cache`: Deletes the cache root only.
*   `--auth`: Deletes `credentials.yaml`. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` to revert preferences to default.
*   `--all`: Wipes all four roots (config, data, state, cache) and automatically reinitializes a fresh environment.

### D. Uninstallation (`clio-coder uninstall`)
`clio-coder uninstall` is the single uninstall path for every install method. It
removes all four roots (config, data, state, cache):

```bash
clio-coder uninstall [--remove-binary] [--dry-run] [--force]
```

Preview first, then remove:

```bash
clio-coder uninstall --dry-run
clio-coder uninstall --remove-binary --force
hash -r
```

`--dry-run` prints the roots and the optional launcher action without changing
anything, and enumerates the same resolved absolute paths the real run would
remove. It prints binary-removal guidance for the active launcher, npm-global
installs, npm links, and the local source symlink.

#### Per-project `.clio-coder/` directories

Uninstall removes the four roots under your home directory. The `.clio-coder/`
directory Clio writes inside each repository it runs in is not one of them and
is never removed here. Every project is recorded in the session metadata under
the state root, so both the real run and `--dry-run` list the surviving
`.clio-coder/` directories and name the command that clears one:

```bash
clio-coder context reset --all
```

That command works on the current directory, so run it from inside each listed
project. The listing is printed before the roots are removed, because the record
it reads lives in one of them, and before `--remove-binary` unlinks the launcher,
because `clio-coder context reset` needs the binary that is about to go. With
`--remove-binary` the listing says so and tells you to clear the projects first,
then re-run the uninstall. Neither the preview nor the real run deletes project
data. To wipe state selectively
while keeping settings or credentials, use `clio-coder reset` instead of
uninstalling. If the launcher is already gone but state remains, run the built
CLI directly from the checkout: `node dist/cli/index.js uninstall --force`.

#### What `--remove-binary` will and will not remove

Ownership is identity, not shape. The launcher is removed only when it resolves
to *this* installation's own `dist/cli/index.js`. A path test on the target's
spelling was three ways too broad: it matched a live symlink into a different
clio-coder checkout, and it matched a target that is not even a file, so an uninstall
from one installation could unlink another one's launcher and leave that
installation on disk with no way to start it.

| At `$CLIO_CODER_BIN_DIR/clio-coder` | Outcome |
| --- | --- |
| A symlink resolving to this installation's entry | Removed |
| A symlink resolving to a different clio-coder installation | Kept, with the path it points at and the exact `rm` that removes it |
| A symlink to a directory named `index.js` | Kept, because a directory is not an entry |
| A real file | Kept, with a note to remove it through the package manager that put it there |
| A dangling symlink naming a clio-coder entry | Removed, and reported as dangling. Leaving it would put a broken `clio-coder` on PATH after an uninstall that claimed to finish |
| A dangling symlink naming anything else | Kept, with the exact `rm` |

#### Partial failure

A recursive delete can stop halfway: an unwritable parent leaves some children
removed and some in place. `reset` and `uninstall` collect per-path failures
instead of throwing the first one. Every selected root still gets its attempt,
the skeleton is rebuilt, each surviving path is named with the reason it
resisted, and the command exits 1 with the exact invocation to rerun. Both
commands are idempotent, so the recovery is always the same: fix the permission
or release the handle, then run the identical command again and it resumes from
whatever is left. A partial delete never reports global success.

---

## 6. Residues Checklist for Manual Purging

If you are removing Clio Coder completely from your system, verify that all categories of residues are removed:

1.  **System Roots**:
    *   `~/.config/clio-coder`
    *   `~/.local/share/clio-coder`
    *   `~/.local/state/clio-coder`
    *   `~/.cache/clio-coder`
2.  **Local Source Bin Link**:
    *   `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}/clio-coder`
3.  **Global Bin Links**:
    *   `clio-coder` executable in your global npm path (for source checkouts, avoid this path unless intentionally debugging npm link behavior).
4.  **Per-Repository State**:
    *   `.clio-coder/` in every repository Clio has worked in, and the generated `CLIO-CODER.md` beside it. See [The Project `.clio-coder/` Directory](#the-project-clio-directory) for what each entry is before deleting.
    *   Remove `.clio-coder/worktrees/` with `git worktree remove` rather than `rm -rf`, so git does not keep stale worktree metadata.

---

## 7. Headless and CI Execution Behavior

Clio Coder supports headless operation for automation and continuous integration.

When executing tasks headlessly using `clio-coder run`, interactive permission prompting is unavailable. The engine resolves permission requests using a deterministic model:
- **Main-agent auto-denial:** Any main-agent tool call that parks for operator authorization is denied with `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` The parked call is cancelled with that reason, and the headless turn finishes according to the resulting assistant outcome.
- **Worker non-stall policy:** Dispatched workers use `workers.onPermission`. The default `deny` turns a permission ask into a structured tool denial and lets the worker continue. `fail` aborts the worker and records the dispatch outcome as `failed/permission_required`.
- **CI behavior:** Neither path waits for an interactive prompt. Exit status still reflects the final headless or dispatch result rather than the mere fact that a permission ask occurred.
