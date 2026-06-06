# Installation and Lifecycle Operations

Clio Coder is designed to be self-contained and platform-compliant. This document outlines the default directory paths, file purposes, permission levels, and lifecycle commands (`install`, `reset`, `upgrade`, and `uninstall`).

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
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and theme preferences. | `0o644` (rw-r--r--) | Kept on uninstall unless specified. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio auth`. | `0o600` (rw-------) | Kept on uninstall unless specified. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **Data** | `install.json` | Platform-specific install metadata (Clio version, node, platform, date). | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `state/migrations.json` | Log of successfully applied schema/state migrations. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `audit/YYYY-MM-DD.jsonl` | Daily fsynced safety audit logs showing allowed/blocked tool actions. | `0o644` (rw-r--r--) | Removed on uninstall / reset. |
| **Data** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | `0o700` / `0o644` | Removed on uninstall / reset. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls [initializeClioHome()](file:///home/akougkas/iowarp/clio-coder/src/core/init.ts#L31) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates root `config`, `data`, and `cache` folders, followed by the 9 default data subdirectories: `sessions`, `audit`, `state`, `agents`, `prompts`, `receipts`, `evidence`, `evals`, and `memory`.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates an empty JSON credentials template and locks its permissions immediately to owner-only read-write (`0o600`).
4.  **Install Metadata**: Writes or updates version info inside `install.json`.

---

## 4. Lifecycle Commands

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
1.  **Phase 1 (Binary Upgrade):** Spawns your package manager to fetch the upgraded package (`npm install -g @iowarp/clio-coder@<channel>`).
2.  **Phase 2 (Post-Install Schema Migrations):** Spawns the new execution context to run pending schema/data migrations (configured in `src/domains/lifecycle/migrations/`).
3.  **Phase 3 (Diagnostic Sweep):** Executes `clio doctor --fix` to update configuration files, rewrite permission schemas, and refresh `install.json` metadata.

### C. System Resets (`clio reset`)
Selective recovery wipes:
```bash
clio reset [--state | --auth | --config | --all] --force
```
*   `--state` *(Default)*: Deletes database state files, cache, and history folders. Retains target preferences and API keys.
*   `--auth`: Deletes `credentials.yaml`. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` to revert preferences to default.
*   `--all`: Wipes all config, data, and cache folders. Automatically calls initialization to boot up a fresh environment.

### D. Uninstallation (`clio uninstall`)
Removes all local files:
```bash
clio uninstall [--keep-config] [--keep-data] --force
```
*   Removes configuration, data, and cache directories based on flags.
*   Does not delete the global binary itself; it prints guidelines for global removal:
    *   *NPM global checkouts:* `npm uninstall -g @iowarp/clio-coder`
    *   *Local source links:* `npm unlink @iowarp/clio-coder`

---

## 5. Residues Checklist for Manual Purging

If you are removing Clio Coder completely from your system, verify that all three categories of residues are removed:

1.  **System Roots**:
    *   `~/.config/clio`
    *   `~/.local/share/clio`
    *   `~/.cache/clio`
2.  **Git Hooks**:
    *   If you ran `npm run hooks:install` inside a cloned repository, delete the hook at: `<repo-root>/.git/hooks/pre-commit`
3.  **Global Bin Links**:
    *   `clio` executable in your global NPM path (e.g. `/usr/local/bin/clio` or `~/.npm-global/bin/clio`).
