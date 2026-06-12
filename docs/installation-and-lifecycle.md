# Installation and Lifecycle Operations

Clio Coder is designed to be self-contained and platform-compliant. This document outlines the default directory paths, file purposes, permission levels, and lifecycle commands (`install`, `reset`, `upgrade`, and `uninstall`). The supported alpha install path is a source checkout with a deterministic local symlink, not a fragile npm-global prefix link.

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with a path simulator and visual flowcharts is located at [docs/html/lifecycle_blueprint.html](html/lifecycle_blueprint.html). You can open it directly in any web browser to view details dynamically.

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

All files are created automatically during the first run. The configuration directories have strict file permission bits to protect user secrets.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and theme preferences. | `0o644` (rw-r--r--) | Removed by uninstall; `uninstall-local.sh --keep-settings-auth` preserves it. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio auth`. | `0o600` (rw-------) | Removed by uninstall; `uninstall-local.sh --keep-settings-auth` preserves it. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **State** | `install.json` | Install metadata: Clio version, node, platform, `installedAt` (written once at first install), and `upgradedAt` (stamped on upgrade). | `0o644` (rw-r--r--) | Removed by uninstall / `reset --state`. |
| **State** | `migrations.json` | Log of successfully applied schema/state migrations. | `0o644` (rw-r--r--) | Removed by uninstall / `reset --state`. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | `0o644` (rw-r--r--) | Removed by uninstall / `reset --data`. |
| **State** | `audit/YYYY-MM-DD.jsonl` | Daily fsynced safety audit logs showing allowed/blocked tool actions. | `0o644` (rw-r--r--) | Removed by uninstall / `reset --state`. |
| **State** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | `0o700` / `0o644` | Removed by uninstall / `reset --state`. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls `initializeClioHome()` (see `src/core/init.ts`) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates the four roots (`config`, `data`, `state`, `cache`) and their skeletons: `agents` under config, `memory`/`evidence`/`evals` under data, and `sessions`/`audit`/`receipts`/`interviews`/`scratch` under state.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config. An existing file is never read, validated, or rewritten by initialization.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates an empty JSON credentials template and locks its permissions immediately to owner-only read-write (`0o600`).
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
- warns if that bin dir is not on `PATH`;
- recommends `clio doctor --fix` (or runs it with `--run-doctor`).

First-run target setup after install:

```bash
clio doctor --fix
clio configure --list
clio configure --id <id> --runtime <runtime> --url <url> --model <model> --set-orchestrator --set-fleet-default
clio targets use <id>
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
*   Checks for version updates or environment configuration drifts.
*   *Recovery:* Run `clio doctor --fix` to repair structure only: missing directories, missing template files, and credential permissions. `--fix` never rewrites an existing `settings.yaml`, valid or invalid.

### B. Upgrades (`clio upgrade`)
Updates package installations and database states.
```bash
clio upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations]
```
The current source-checkout release is not published to npm, so source users
should update with `git pull`, `npm run install:local`, `hash -r`, and
`clio doctor --fix`. The `clio upgrade` npm-global path is retained for future
registry availability.

### C. System Resets (`clio reset`)
Selective recovery wipes:
```bash
clio reset [--state | --data | --cache | --auth | --config | --all] --force
```
Each level clears exactly the root (or file) it names and nothing else:
*   `--state` *(Default)*: Deletes the state root only: sessions, audit logs, receipts, run ledger, install metadata.
*   `--data`: Deletes the data root only: memory, evidence, evals (durable products).
*   `--cache`: Deletes the cache root only.
*   `--auth`: Deletes `credentials.yaml`. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` to revert preferences to default.
*   `--all`: Wipes all four roots (config, data, state, cache) and automatically reinitializes a fresh environment.

### D. Local Source Uninstallation (`npm run uninstall:local`)
Preview first:

```bash
npm run uninstall:local -- --dry-run
```

Full local source uninstall:

```bash
npm run uninstall:local -- --force
hash -r
```

This removes the `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio` symlink only when it
points into the current checkout, then removes Clio config/data/cache. To keep
only the active settings and credentials files, not old backups or other config
residue, run:

```bash
npm run uninstall:local -- --force --keep-settings-auth
```

Use `--keep-state` for binary-only unlinking. Use `--preserve-settings-auth
<dir>` to copy active `settings.yaml` and `credentials.yaml` to an explicit
operator-chosen directory before restoring them. Credential contents are never
printed.

### E. CLI State Uninstallation (`clio uninstall`)
`clio uninstall` removes all four roots (config, data, state, cache):

```bash
clio uninstall [--remove-binary] --force
```

`--remove-binary` also removes the launcher symlink when it resolves into a
clio dist; anything else (a real file, a foreign symlink) is left in place.
It prints binary-removal guidance for the active launcher, npm-global installs,
npm links, and the local source symlink. Prefer `npm run uninstall:local` for
source checkouts because it handles both the symlink and state in one audited
path.

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
3.  **Git Hooks**:
    *   If you ran `npm run hooks:install` inside a cloned repository, delete the hook at: `<repo-root>/.git/hooks/pre-commit`
4.  **Global Bin Links**:
    *   `clio` executable in your global npm path (for source checkouts, avoid this path unless intentionally debugging npm link behavior).

---

## 7. Headless and CI Execution Behavior

Clio Coder supports headless operation for automation and continuous integration.

When executing tasks headlessly using `clio run`, interactive permission prompting is unavailable. The engine resolves permission requests using a deterministic model:
- **Auto-Denial:** Any action requiring operator authorization is immediately and deterministically denied by the runtime.
- **Rejection Reason:** Rejections carry a standard message indicating that the action must be executed in interactive mode to approve.
- **Fail-Safe Exit:** The engine cancels all pending and parked tool calls, and exits immediately with an error status. This prevents silent script stalls or unsafe mutations during CI builds.
