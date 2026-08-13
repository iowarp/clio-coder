# Installation and Lifecycle Operations

Clio Coder is designed to be self-contained and platform-compliant. This document outlines the default directory paths, file purposes, permission levels, and lifecycle commands (`install`, `reset`, `upgrade`, and `uninstall`). The supported alpha install path is a source checkout with a deterministic local symlink; npm distribution of `@iowarp/clio-coder` begins with the first stable v0.3.0 (the CLI already classifies and upgrades npm installs, so nothing here changes shape at that point).

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with a path simulator and visual flowcharts is located at [docs/html/lifecycle_blueprint.html](html/lifecycle_blueprint.html) (Version: 0.3.0). You can open it directly in any web browser to view details dynamically.

---

## 1. Directory Layout & Platform Defaults

Clio Coder follows standard platform specifications for user configurations, databases, and caches, but allows full environment overrides.

### Platform Defaults
| Operating System | Config (`configDir`) | Data (`dataDir`) | State (`stateDir`) | Cache (`cacheDir`) |
| :--- | :--- | :--- | :--- | :--- |
| **Linux / Unix** | `~/.config/clio` | `~/.local/share/clio` | `~/.local/state/clio` | `~/.cache/clio` |
| **macOS** | `~/Library/Application Support/clio/config` | `~/Library/Application Support/clio/data` | `~/Library/Application Support/clio/state` | `~/Library/Caches/clio` |
| **Windows** | `%APPDATA%\clio\config` | `%APPDATA%\clio\data` | `%LOCALAPPDATA%\clio\state` | `%LOCALAPPDATA%\clio\cache` |

Run `clio paths [--json]` to print the resolved table for the current environment.

### Environment Overrides
You can redirect Clio Coder's folders using environment variables:
*   `CLIO_HOME`: Sets a symmetric tree: `$CLIO_HOME/config`, `$CLIO_HOME/data`, `$CLIO_HOME/state`, and `$CLIO_HOME/cache`.
*   `CLIO_CONFIG_DIR`: Overrides the configuration directory only (takes precedence over `CLIO_HOME`).
*   `CLIO_DATA_DIR`: Overrides the data directory only (takes precedence over `CLIO_HOME`).
*   `CLIO_STATE_DIR`: Overrides the state directory only (takes precedence over `CLIO_HOME`).
*   `CLIO_CACHE_DIR`: Overrides the cache directory only (takes precedence over `CLIO_HOME`).

### The Project `.clio/` Directory

The tables above cover the per-user roots. A repository Clio works in also grows a
`.clio/` directory, and everything in it falls into one of three kinds:

*   **Operator input.** You wrote it. Clio only reads it. Deleting it removes a
    behavior you configured and nothing else.
*   **Runtime state.** Clio wrote it. It is derived from your repository and can be
    regenerated, though not always cheaply.
*   **Overlay.** You wrote it, and it composes with a directory Clio ships. The
    overlay column below says how.

| Path | Kind | What it is | Safe to delete? | `context reset` |
| :--- | :--- | :--- | :--- | :--- |
| `.clio/settings.yaml`, `.clio/settings.local.yaml` | Operator input | Project settings layered over the user's `settings.yaml`. Precedence is built-in < user < project < project-local. | Yes; the user-level settings apply again. | Kept |
| `.clio/safety.yaml` | Operator input | Per-repository command allowlist consulted before execute actions. | Yes; approvals return to per-action prompting. | Kept |
| `.clio/hooks.yaml`, `.clio/hooks.local.yaml` | Operator input | Project-declared hooks. | Yes. | Kept |
| `.clio/rules/**/*.md` | Operator input | Path-scoped project rules injected into the prompt. | Yes. | Kept |
| `.clio/profile.yaml` | Operator input | Operator profile; closed enums and bounded path lists. | Yes. | Kept |
| `.clio/fleets/*.md`, `.clio/fleets/commands.yaml` | Overlay | Fleet contracts and their command registry. Adds to the fleets shipped under `src/domains/agents/fleets/`. | Yes; shipped fleets remain. | Kept |
| `.clio/agents/*.md` | Overlay | Project agent recipes. Composes with shipped builtins and the user's `~/.config/clio/agents`; a project recipe reusing a builtin id is **ignored**, not applied, with a note on stderr. | Yes; shipped agents remain. | Kept, and named |
| `.clio/skills/**` | Overlay | Project skills, trusted as repository-local. Composes with skills Clio ships. | Yes; shipped skills remain. | Kept, and named |
| `CLIO.md` (repository root) | Runtime state | The generated project handbook. Human-reviewable, but written by `context init`. | Yes; regenerate with `clio context init`. | Kept unless `--all` |
| `.clio/codewiki.json` | Runtime state | Structural index, schema v5. | Yes; rebuilt by `clio context index`. | **Removed** |
| `.clio/state.json` | Runtime state | Index fingerprint and freshness stamps. | Yes; forces a rebuild. | **Removed** |
| `.clio/proposals/` | Runtime state | Ignored handbook drafts from `context init --propose`. | Yes. | **Removed** |
| `.clio/handoffs/` | Runtime state | Session handoff notes. | Yes. | **Removed** |
| `.clio/wiki/` | Runtime state | The generated Markdown wiki plus `meta.json`. The most expensive artifact here: one model dispatch per page. | Yes, but regenerating costs a full `clio context wiki` run. | Kept, and named |
| `.clio/wiki-prev/` | Runtime state | Previous wiki, retained for rollback during generation. | Yes. | Kept, not named |
| `.clio/worktrees/` | Runtime state | Git worktrees for `compete` candidate groups. | Prefer `git worktree remove`; a plain delete leaves git metadata behind. | Kept, not named |

`~/.clio/runtimes/` is a separate, user-level directory for third-party runtime
plugins. It is not part of any repository.

None of `.clio/` is published by Clio's own package. The directories Clio ships
(`src/domains/agents/builtins/`, `src/domains/agents/fleets/`, `skills/workflow/cut-it/`, `skills/git/`,
`src/domains/prompts/fragments/`, `src/domains/providers/models/`) are read from
the installed package root; the `.clio/` entries above compose with them and never
replace them on disk.

---

## 2. File & Permissions Matrix

The core files are created automatically during the first run. `credentials.yaml` is the secret-bearing file and is forced to owner-only read-write permissions. Other initialized files and directories use either the explicit mode shown below or the platform default produced by the writer and process umask.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and theme preferences. | `0o644` (rw-r--r--) | Removed by uninstall / `reset --config`. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio auth`. | `0o600` (rw-------) | Removed by uninstall / `reset --auth`. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **State** | `install.json` | Install metadata: Clio version, node, platform, `installedAt` (written once at first install), and `upgradedAt` (stamped on upgrade). | Writer/umask default | Removed by uninstall / `reset --state`. |
| **State** | `migrations.json` | Log of successfully applied schema/state migrations. | Writer/umask default | Removed by uninstall / `reset --state`. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | Writer/umask default | Removed by uninstall / `reset --data`. |
| **State** | `audit/YYYY-MM-DD.jsonl` | Daily safety audit logs showing allowed/blocked tool actions. | Writer/umask default | Removed by uninstall / `reset --state`. |
| **State** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | Writer/umask default | Removed by uninstall / `reset --state`. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls `initializeClioHome()` (see `src/core/init.ts`) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates the four roots (`config`, `data`, `state`, `cache`) and their skeletons: `agents` under config, `memory`/`evidence`/`evals` under data, and `sessions`/`audit`/`receipts`/`interviews`/`scratch` under state.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config. An existing file is never read, validated, or rewritten by initialization.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates a YAML file containing a managed-file comment and an empty object (`{}`), then locks its permissions immediately to owner-only read-write (`0o600`).
4.  **Install Metadata**: Writes `install.json` with `installedAt` exactly once at first install; a later version, platform, or node change preserves `installedAt` and stamps `upgradedAt`.

---

## 4. Source Checkout Install

Use the local source installer from the cloned repository:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio --version
```

`scripts/install-local.sh` is idempotent and auditable:

- verifies `node` satisfies `package.json` `engines.node`;
- runs `npm ci` unless `node_modules` satisfies the lockfile or `--skip-deps` is passed;
- runs `npm run build` unless `--no-build` is passed;
- verifies `dist/cli/index.js` exists and is executable;
- creates `${CLIO_BIN_DIR:-$HOME/.local/bin}` and links `clio` there;
- warns if that bin dir is not on `PATH`, and warns when another `clio`
  earlier on `PATH` shadows the freshly linked one;
- runs the installed CLI's structure repair (`node dist/cli/index.js doctor
  --fix` with the caller's environment), so a fresh install passes plain
  `clio doctor` with no manual steps.

On a machine where Clio has never run, plain `clio doctor` reports the
missing config structure and exits nonzero by design (it is a read-only
diagnosis); `clio doctor --fix`, the installer above, or simply launching
`clio` creates everything.

First-run target setup after install:

**Option A: Local Model / API Key Target**
```bash
clio configure --list
clio configure --id local-lmstudio --runtime lmstudio-native --url http://localhost:1234 --model your-model --set-orchestrator --set-fleet-default
clio targets use local-lmstudio
clio targets --probe
clio
```

**Option B: Subscription Target (OAuth / Claude Code)**
```bash
# Authenticate ChatGPT Plus/Pro or Claude Pro/Max subscription
clio auth login openai-codex
clio auth login anthropic-max

# Authenticate Claude CLI for worker targets
claude auth login

# Configure OAuth subscription target
clio configure --id claude-sub --runtime anthropic-max --model your-claude-model --set-orchestrator

# Configure Claude Code SDK worker target
clio configure --id claude-sdk-worker --runtime claude-sdk --model your-claude-model --set-fleet-default

clio targets use claude-sub
clio targets --probe
clio
```

If a shell still tries an old removed path such as `~/.local/bin/clio`, clear
its command cache with `hash -r` in Bash or `rehash` in Zsh.

## 5. Lifecycle Commands

Clio Coder provides CLI utilities to manage operations safely.

### A. Integrity Diagnostics (`clio doctor`)
Runs a series of health sweeps across the environment:
*   Validates `settings.yaml` against the strict schema, reporting exact key paths, read-only.
*   Asserts owner-only permissions on credentials (`0o600`).
*   Reports the installed Clio, Node, platform, and engine package readiness.
*   Checks config, data, state, cache, and state metadata freshness. It also warns when an OpenAI-compatible or Anthropic-compatible target appears to be a native LM Studio or Ollama server that should be converted.
*   *Recovery:* Run `clio doctor --fix` to create missing directories and templates, repair credential permissions, and refresh install metadata. Settings are always validated against the current schema; `--fix` does not rewrite removed keys or migrate an older settings file, so the operator must correct every reported path deliberately.

### B. Upgrades (`clio upgrade`)
Refreshes state metadata and applies pending data-dir migrations.
```bash
clio upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations]
```
The command detects the install method from the running binary. On a source
checkout it never runs `npm install -g`: it performs its safe local duties
(migration check, `install.json` refresh) and prints the real update steps,
`git pull`, `npm run install:local`, `hash -r`. The npm reinstall path applies
only to a genuinely npm-installed binary, once the package is published.

### C. System Resets (`clio reset`)
Selective recovery wipes:
```bash
clio reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force]
```
Levels are combinable except `--all`. Each level clears exactly the root or file it names and nothing else, then bootstraps the missing structure again unless `--dry-run` is present. `--force` is required only for destructive execution.

Every run lists each selected root and then the entries inside it, read off the
disk on that run, before removing anything; `--dry-run` prints the identical
listing. That listing, not this page and not `--help`, is the authoritative
inventory of what a level covers, because a remembered list drifts as soon as a
new artifact is written into a root.

*   `--state` *(Default)*: Deletes the state root only. It holds every session transcript and the audit trail beside it, so a reset is the end of `resume`, `/view`, and their history. This is the level a bare `clio reset` selects, and it carries that note in its preview.
*   `--data`: Deletes the data root only: memory, evidence, evals (durable products).
*   `--cache`: Deletes the cache root only.
*   `--auth`: Deletes `credentials.yaml`. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` to revert preferences to default.
*   `--all`: Wipes all four roots (config, data, state, cache) and automatically reinitializes a fresh environment.

### D. Uninstallation (`clio uninstall`)
`clio uninstall` is the single uninstall path for every install method. It
removes all four roots (config, data, state, cache):

```bash
clio uninstall [--remove-binary] [--dry-run] [--force]
```

Preview first, then remove:

```bash
clio uninstall --dry-run
clio uninstall --remove-binary --force
hash -r
```

`--dry-run` prints the roots and the optional launcher action without changing
anything, and enumerates the same resolved absolute paths the real run would
remove. It prints binary-removal guidance for the active launcher, npm-global
installs, npm links, and the local source symlink.

#### Per-project `.clio/` directories

Uninstall removes the four roots under your home directory. The `.clio/`
directory Clio writes inside each repository it runs in is not one of them and
is never removed here. Every project is recorded in the session metadata under
the state root, so both the real run and `--dry-run` list the surviving
`.clio/` directories and name the command that clears one:

```bash
clio context reset --all
```

That command works on the current directory, so run it from inside each listed
project. The listing is printed before the roots are removed, because the record
it reads lives in one of them, and before `--remove-binary` unlinks the launcher,
because `clio context reset` needs the binary that is about to go. With
`--remove-binary` the listing says so and tells you to clear the projects first,
then re-run the uninstall. Neither the preview nor the real run deletes project
data. To wipe state selectively
while keeping settings or credentials, use `clio reset` instead of
uninstalling. If the launcher is already gone but state remains, run the built
CLI directly from the checkout: `node dist/cli/index.js uninstall --force`.

#### What `--remove-binary` will and will not remove

Ownership is identity, not shape. The launcher is removed only when it resolves
to *this* installation's own `dist/cli/index.js`. A path test on the target's
spelling was three ways too broad: it matched a live symlink into a different
clio checkout, and it matched a target that is not even a file, so an uninstall
from one installation could unlink another one's launcher and leave that
installation on disk with no way to start it.

| At `$CLIO_BIN_DIR/clio` | Outcome |
| --- | --- |
| A symlink resolving to this installation's entry | Removed |
| A symlink resolving to a different clio installation | Kept, with the path it points at and the exact `rm` that removes it |
| A symlink to a directory named `index.js` | Kept, because a directory is not an entry |
| A real file | Kept, with a note to remove it through the package manager that put it there |
| A dangling symlink naming a clio entry | Removed, and reported as dangling. Leaving it would put a broken `clio` on PATH after an uninstall that claimed to finish |
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
    *   `~/.config/clio`
    *   `~/.local/share/clio`
    *   `~/.local/state/clio`
    *   `~/.cache/clio`
2.  **Local Source Bin Link**:
    *   `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio`
3.  **Global Bin Links**:
    *   `clio` executable in your global npm path (for source checkouts, avoid this path unless intentionally debugging npm link behavior).
4.  **Per-Repository State**:
    *   `.clio/` in every repository Clio has worked in, and the generated `CLIO.md` beside it. See [The Project `.clio/` Directory](#the-project-clio-directory) for what each entry is before deleting.
    *   Remove `.clio/worktrees/` with `git worktree remove` rather than `rm -rf`, so git does not keep stale worktree metadata.

---

## 7. Headless and CI Execution Behavior

Clio Coder supports headless operation for automation and continuous integration.

When executing tasks headlessly using `clio run`, interactive permission prompting is unavailable. The engine resolves permission requests using a deterministic model:
- **Main-agent auto-denial:** Any main-agent tool call that parks for operator authorization is denied with `clio run cannot confirm permission requests; rerun interactively to approve this action.` The parked call is cancelled with that reason, and the headless turn finishes according to the resulting assistant outcome.
- **Worker non-stall policy:** Dispatched workers use `workers.onPermission`. The default `deny` turns a permission ask into a structured tool denial and lets the worker continue. `fail` aborts the worker and records the dispatch outcome as `failed/permission_required`.
- **CI behavior:** Neither path waits for an interactive prompt. Exit status still reflects the final headless or dispatch result rather than the mere fact that a permission ask occurred.
