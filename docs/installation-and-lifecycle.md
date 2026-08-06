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
Levels are combinable except `--all`. Each level clears exactly the root or file it names and nothing else, then bootstraps the missing structure again unless `--dry-run` is present. `--force` is required only for destructive execution:
*   `--state` *(Default)*: Deletes the state root only: sessions, audit logs, receipts, runs, install metadata, migrations, interviews, and scratch state.
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

`--dry-run` prints the roots and optional launcher action without changing
anything. `--remove-binary` also removes the launcher symlink when it resolves
into a clio dist, which is exactly the shape `npm run install:local` creates;
anything else (a real file, a foreign symlink) is left in place. It prints
binary-removal guidance for the active launcher, npm-global installs, npm
links, and the local source symlink. To wipe state selectively while keeping
settings or credentials, use `clio reset` instead of uninstalling. If the
launcher is already gone but state remains, run the built CLI directly from
the checkout: `node dist/cli/index.js uninstall --force`.

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

---

## 7. Headless and CI Execution Behavior

Clio Coder supports headless operation for automation and continuous integration.

When executing tasks headlessly using `clio run`, interactive permission prompting is unavailable. The engine resolves permission requests using a deterministic model:
- **Main-agent auto-denial:** Any main-agent tool call that parks for operator authorization is denied with `clio run cannot confirm permission requests; rerun interactively to approve this action.` The parked call is cancelled with that reason, and the headless turn finishes according to the resulting assistant outcome.
- **Worker non-stall policy:** Dispatched workers use `workers.onPermission`. The default `deny` turns a permission ask into a structured tool denial and lets the worker continue. `fail` aborts the worker and records the dispatch outcome as `failed/permission_required`.
- **CI behavior:** Neither path waits for an interactive prompt. Exit status still reflects the final headless or dispatch result rather than the mere fact that a permission ask occurred.
