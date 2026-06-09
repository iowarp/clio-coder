# Installation and Lifecycle Operations

Clio Coder is designed to be self-contained and platform-compliant. This document outlines the default directory paths, file purposes, permission levels, and lifecycle commands (`install`, `reset`, `upgrade`, and `uninstall`). The supported alpha install path is a source checkout with a deterministic local symlink, not a fragile npm-global prefix link.

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard with a path simulator and visual flowcharts is located at [docs/html/lifecycle_blueprint.html](html/lifecycle_blueprint.html). You can open it directly in any web browser to view details dynamically.

---

## 1. Directory Layout & Platform Defaults

Clio Coder follows standard platform specifications for user configurations, databases, and caches, but allows full environment overrides.

### Platform Defaults
| Operating System | Config Directory (`configDir`) | Data Directory (`dataDir`) | Cache Directory (`cacheDir`) |
| :--- | :--- | :--- | :--- |
| **Linux / Unix** | `~/.config/clio` | `~/.local/share/clio` | `~/.cache/clio` |
| **macOS** | `~/Library/Application Support/clio` | `~/Library/Application Support/clio` | `~/Library/Caches/clio` |
| **Windows** | `%APPDATA%\clio` | `%APPDATA%\clio` | `%LOCALAPPDATA%\Temp\clio` |

### Environment Overrides
You can redirect Clio Coder's folders using environment variables:
*   `CLIO_HOME`: Sets a unified tree where config goes to `$CLIO_HOME`, data goes to `$CLIO_HOME/data`, and cache goes to `$CLIO_HOME/cache`.
*   `CLIO_CONFIG_DIR`: Overrides the configuration directory only (takes precedence over `CLIO_HOME`).
*   `CLIO_DATA_DIR`: Overrides the data directory only (takes precedence over `CLIO_HOME`).
*   `CLIO_CACHE_DIR`: Overrides the cache directory only (takes precedence over `CLIO_HOME`).

---

## 2. File & Permissions Matrix

All files are created automatically during the first run. The configuration directories have strict file permission bits to protect user secrets.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and theme preferences. | `0o644` (rw-r--r--) | Removed by full uninstall; restored only with `--keep-settings-auth` or retained by `clio uninstall --keep-config`. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio auth`. | `0o600` (rw-------) | Removed by full uninstall; restored only with `--keep-settings-auth` or retained by `clio uninstall --keep-config`. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **Data** | `install.json` | Platform-specific install metadata (Clio version, node, platform, date). | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `state/migrations.json` | Log of successfully applied schema/state migrations. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `audit/YYYY-MM-DD.jsonl` | Daily fsynced safety audit logs showing allowed/blocked tool actions. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | `0o700` / `0o644` | Removed on uninstall / reset. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls `initializeClioHome()` (see `src/core/init.ts`) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates root `config`, `data`, and `cache` folders, followed by the 9 default data subdirectories: `sessions`, `audit`, `state`, `agents`, `prompts`, `receipts`, `evidence`, `evals`, and `memory`.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates an empty JSON credentials template and locks its permissions immediately to owner-only read-write (`0o600`).
4.  **Install Metadata**: Writes or updates version info inside `install.json`.

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
*   Validates configuration YAML syntax.
*   Asserts owner-only permissions on credentials (`0o600`).
*   Checks for version updates or environment configuration drifts.
*   *Recovery:* Run `clio doctor --fix` to restore missing folders, rewrite correct permissions, or auto-migrate legacy runtime configurations.

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
clio reset [--state | --auth | --config | --all] --force
```
*   `--state` *(Default)*: Deletes database state files, cache, and history folders. Retains target preferences and API keys.
*   `--auth`: Deletes `credentials.yaml`. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` to revert preferences to default.
*   `--all`: Wipes all config, data, and cache folders. Automatically calls initialization to boot up a fresh environment.

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
`clio uninstall` removes selected state but does not remove the binary:

```bash
clio uninstall [--keep-config] [--keep-data] --force
```

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
