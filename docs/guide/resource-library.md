# Library packages

The **library** is Clio Coder's collection of installable **packages**. Each package has one kind: `plugin`, `extension`, `skill`, `agent`, `prompt`, or `playbook`. The five content kinds use a root `plugin.json`, an explicit Semantic Version, a full-tree SHA-256 pin, and the same installation state: a plugin carries several components, and each other content kind exposes one public component and may include supporting files. An `extension` is Clio code in its own process. It uses `clio-coder-extension.yaml`, its own installation state, and the operator's review of its capability envelope; the operator installs it with `clio-coder library install extension:<name>`, and a plugin and an extension are always separate packages. This page owns the operator commands. Package invariants are in the [library architecture](../architecture/library.md) and manifest fields are in [authoring-plugins.md](authoring-plugins.md).

Bundled packages are available on a fresh installation, but none are installed automatically. Built-in runtime tools, agents and playbooks remain available independently of optional library packages.

Source: [library.ts](../../src/cli/library.ts), [library-import.ts](../../src/cli/library-import.ts), [skills.ts](../../src/cli/skills.ts), [skills-inventory.ts](../../src/cli/skills-inventory.ts), [agents.ts](../../src/cli/agents.ts), and `src/domains/resources/`.

## Command reference

```text
clio-coder library list [--kind <kind>] [--user|--project] [--json]
clio-coder library search [query] [--kind <kind>] [--json]
clio-coder library components [query] [--kind skill|agent|prompt|playbook] [--source core|package|user|project|compat] [--all] [--json]
clio-coder library register <path> [--user|--project] [--force] [--json]
clio-coder library inspect <path|kind:name|name> [--user|--project] [--json]
clio-coder library install <path|kind:name|name> [--user|--project] [--force] [--with-requirements] [--dry-run] [--json]
clio-coder library import <path|github-tree-url> [--user|--project] [--format claude|codex] [--dry-run] [--json] [--yes]
clio-coder library update <kind:name|name> [--user|--project] [--force] [--dry-run] [--json]
clio-coder library enable <kind:name|name> [--user|--project] [--dry-run] [--json]
clio-coder library disable <kind:name|name> [--user|--project] [--dry-run] [--json]
clio-coder library remove <kind:name|name> [--user|--project] [--dry-run] [--json]
clio-coder library pin <kind:name|name> [--user|--project] [--json]
clio-coder library drift [kind:name|name] [--user|--project] [--json]
clio-coder library reload [--json]
clio-coder library skills [--all] [--json]
clio-coder library inventory --json
clio-coder library validate <package-path|SKILL.md> [--json]
clio-coder library sync
clio-coder library push
clio-coder library remote confirm <url>
```

`--kind` takes `plugin`, `extension`, `skill`, `agent`, `prompt`, or `playbook` (`components` takes the four component kinds). `--from <index.yaml>` selects an index with the highest priority. `-f` is an alias of `--force`. `--dry-run` is accepted only by `install`, `import`, `update`, `enable`, `disable`, and `remove`, and `--source` only by `components`. `--user` and `--project` are mutually exclusive. `install` and `register` default to user scope. Other mutations select the project copy when one exists, and an explicit scope selects exactly that copy.

Every mutation builds one reviewed plan, rechecks it inside the package lock, refuses to break enabled dependents, and reports per-package outcomes with disk, component-admission and host-refresh facts separately. `--dry-run` prints the plan and writes nothing. A CLI never refreshes a running session, so its refresh status reads `not-applicable`. After a committed install, update, enable, disable or remove, plain output ends with `A running session picks this up after /library reload.` on stderr. A failed step prints `<operation> <ref> (<scope>) failed: <message>`; a refusal's message already names its fix, and other failures append the next step. With `--json`, install and update keep the fields older callers read (`confirmed`, `writes`, `results`, `id`, `path`, `sha256`, `recovery`) and add `plan` and `apply`. Failures print `{ok: false, error}`.

Exit codes: 0 for success, 1 for an operational failure, an invalid package, a refused plan, or a `drift` report that is not clean, and 2 for a usage error such as an unknown flag, both scope flags, or a bare `library`.

When the model runs a `clio-coder library` command through its shell, `install`, `import`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push` and `remote` ask for one-shot operator confirmation in `default`, and `--dry-run` on `install`, `import`, `update`, `enable`, `disable` and `remove` never asks. The dispositions at each autonomy level are in [skills-marketplace.md](skills-marketplace.md).

## Browse and install

```bash
clio-coder library list --json
clio-coder library search research --kind skill
clio-coder library inspect plugin:materio --json
clio-coder library install plugin:materio --project --dry-run --json
clio-coder library install plugin:materio --project --json
```

`install` is an explicit request to write. `--dry-run --json` reports every source, destination and digest in the plan without installing. The TUI asks for confirmation before writing. `--force` permits replacement of ordinary installed packages and preserves edited files in a reported recovery directory; it cannot override a source pin, identity or version mismatch. Installing over an existing destination without `--force` is refused with ``<ref> is already installed in <scope> scope; update it instead, or reinstall it with `clio-coder library install <ref> --force` ``.

An existing local directory wins over a library name with the same spelling. A source that is neither a local directory nor a library package fails with ``<source> is not a library package or a local package directory; find the name with `clio-coder library search` ``. `kind:name` checks the package kind; bare names are accepted when unambiguous. Package names share one namespace within each scope. A replacement cannot change a package's kind; remove it explicitly first. A raw or unindexed GitHub URL cannot be installed; use `library import` for a reviewed import, or add a pinned index row.

`inspect` reads a local package directory, an installed copy (the project copy first, with its copies, origin and diagnostics), or an indexed package staged without installing, and exits 1 when the manifest is invalid. `list` and `search` are package-oriented and answer with install targets. `--kind` and a query also match the components a plugin provides, returning the owning package, so a kind query finds the owning plugin before installation. Plain output has one line per package: `kind:name`, version, the state of each installed copy (`scope:state`) or `available`, origin, and description.

## Install an extension

```bash
clio-coder library install extension:materio --user --dry-run
clio-coder library install extension:materio --user
```

`extension:<name>` goes through the same reviewed plan as every other kind, and the review is the operator's consent. It reads the manifest alone, without loading any package code, and lists what the extension may do: its commands, events, hooks, runtime tools, interface slots, workspaces, the prompts it takes over, the host state it keeps (`state`), the content it may read, the files it may read and write, and whether it may run programs or use the network, followed by the envelope's SHA-256. An update leads with what the new envelope adds beyond the installed copy. The install records the envelope digest with the content digest, and a package whose envelope no longer matches the record stays inactive until the operator reinstalls and reviews it. See [Extensions](harness-extensions.md) for the envelope, the sandbox and the lifecycle.

An extension that serves a plugin shows that plugin in its Library detail, and the plugin shows its extension, each with the partner's installed state and whether a takeover applies. Installing a plugin never installs its extension, so the two are separate installs, each with its own review.

Every committed install, update, enable, disable, remove, register and import also writes a bounded lifecycle receipt. A receipt records the operation, the package kind and id, the content digest and, for an extension, the envelope digest, the scope, the source, and the actor (`operator`, `model-confirmed`, or `upgrade`). Clio keeps the most recent 512 receipts in `library-receipts.json` under its state directory. The Library detail pane and the `/extensions` reference show a package's last lifecycle line, and `clio-coder trace tail` and evidence bundles carry the package owner of extension, skill and prompt activity.

## Scope and workspace state

Content kinds install beneath `<configDir>/plugins/<name>/` at user scope or `<cwd>/.clio-coder/plugins/<name>/` at project scope. These engine directories hold complete packages, including single-component packages. The corresponding `plugins/state.json` records kind, source, structured origin, trust, installation time and verified digest. There is no per-kind installation pin file. An extension installs beneath `<configDir>/extensions/<id>/` or `.clio-coder/extensions/<id>/` with its own `extensions/state.json`, which also records the digest of its approved capability envelope; see [Extensions](harness-extensions.md).

`library list --json` returns `{entries, diagnostics}`. Each entry carries the index row, an `installed` array holding every matching installed scope with its `enabled`, `valid`, `compatible`, `effective`, and `loadable` flags, a `copies` array of `{scope, state}`, and the classified `provenance` origin, `format`, and `provides` hints. An empty `installed` array means the package is available but uninstalled. Scope flags filter the installed copies. Copy states are `loadable`, `disabled`, `shadowed`, `invalid`, `incompatible`, and `damaged`. Broken and disabled packages remain visible for repair or removal. An enabled project copy that waits for workspace approval reads `invalid` and carries the diagnostic below.

## Workspace trust for project packages

A project copy installs from the repository's own `.clio-coder/plugins/state.json`, so its digest check proves integrity and not consent. Project packages of every kind load only after the operator approves that file for the workspace, which is the `plugins` surface of workspace trust. User packages are unaffected.

Until the surface is approved, every project copy is blocked. Its skills, prompts, agents and playbooks do not load, it does not satisfy another package's dependency, and it neither shadows nor suppresses a user copy of the same package, so the user copy keeps loading even when the blocked project copy is disabled. A blocked copy stays listed. `library list` reads an enabled one `invalid`, the installed-package state of a skill-providing package reads `requires trust`, and `library inspect` shows `trustBlocked: true` with the warning `project plugins are not trusted for this workspace and are not loaded; review with clio-coder config trust plugins`.

```bash
clio-coder config trust plugins                  # print the captured state file and its SHA-256 digest (read-only)
clio-coder config trust plugins --hash <sha256>  # approve exactly those bytes
clio-coder config trust plugins --revoke         # withdraw the approval
```

Approval pins the exact bytes of `state.json`, which records the verified digest of every project package. Any change to those bytes ends the approval: a project install, update, enable, disable or remove, a `--force` reinstall, or an edit. The surface then reads `changed` and every project package in the workspace stays unloaded until the new bytes are reviewed and approved. `/library reload` applies a new approval to a running session. The command grammar and output are in [commands-and-modes.md](commands-and-modes.md), and the trust record is described in the [safety model](../architecture/safety-model.md).

The operator's first project install approves itself. When the workspace has no `.clio-coder/plugins/state.json`, a project-scope install through `clio-coder library install <ref> --project`, the Library overlay (`/library install <ref> --project`, or `i` with the project scope selected) or the GUI's Library page creates that file and approves its bytes in the same step. Nothing is printed about the approval, and it applies only when at least one project-scope install step committed. These paths never approve:

- `library import`, from the CLI or `/library import`.
- `interop adopt`.
- The install offers for a missing skill (`/skill <name>` and the marketplace question), which install through the skill installer.
- Any project install, update, enable, disable or remove after the first, since each changes the state file.

A package from one of those paths, installed into a project that has no plugin state, is blocked until `clio-coder config trust plugins` approves it.

A task worktree that Clio Coder created for a dispatched worker inherits its origin workspace's approval while its `.clio-coder/plugins/state.json` is byte-identical to the origin's approved file. A hand-made `git worktree`, a worktree whose state differs, and a worktree whose origin approval is revoked or changed do not inherit. The inheritance rules are in the safety model.

## Lifecycle

```bash
clio-coder library disable plugin:materio --project
clio-coder library enable plugin:materio --project
clio-coder library drift plugin:materio --project
clio-coder library pin plugin:materio --project
clio-coder library update plugin:materio --project --dry-run
clio-coder library update plugin:materio --project
clio-coder library remove plugin:materio --project
```

The list labels drifted copies `damaged`, not `shadowed`. Inspect changes before running `clio-coder library update kind:name --user --force` (or `--project`) to restore the recorded source; edited files are preserved in a recovery backup. Enabling alone cannot repair drift, and `enable` refuses an invalid or incompatible copy.

Drift prevents resources from loading. `drift` reports `clean`, `changed`, `missing`, or `unpinned`; without a reference it checks every installed copy and exits 1 unless all are clean. `pin` records nothing new. With `--json` it prints the recorded digest and source; otherwise it prints one line, `pinned <ref> (<scope>) at sha256 <digest>`. It fails with `plugin_local_changes` when the tree was edited, because it never blesses local changes. Without `--json`, `drift` prints one line per copy, `<ref> (<scope>) <detail>`, where the detail is `matches its pinned content`, `differs from its pin (pinned <digest>, on disk <digest>); update it or reinstall with --force`, `has no files on disk; reinstall it` or `has no verified pin; reinstall it from the library to record one`; with no installed package it prints `no installed packages`. `--json` prints the status object, or `{results}` for the whole-library form. Updates of catalog packages use the current index version and pin. Local installations update from their recorded source directory, and an update without `--force` refuses a tree that differs from its record. Update and replacement preserve disabled state. `update` also requires its dependencies to be installed and enabled first. `disable` and `remove` refuse when an enabled dependent would lose a requirement they satisfy. Removal preserves edited content and reports the recovery path. Installed state remains addressable after its index entry disappears.

A foreign package (installed by `interop adopt` or `library import`) cannot be updated or force-replaced: remove it and review a new adoption so omitted host executables cannot reappear. Foreign skills and prompts load only while `integrations.projectResources.trustProjectImports` is true, including foreign project files adopted to user scope. That gate is separate from workspace trust: a foreign package installed at project scope also needs the project's plugin state approved before anything loads. See [interoperability](interop.md) and invariant 7 of the library architecture.

## Import

`library import <path|github-tree-url>` reviews a portable, Claude Code, or Codex plugin from a directory or a `https://github.com/owner/repo/tree/ref/path` URL. A root `plugin.json` imports as data only. A `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` package is normalized into a portable Clio Coder package: skills keep their text and frontmatter names, command Markdown becomes prompts, and Claude agents become read-only Clio Coder agents. Hooks, MCP, LSP, scripts, and host settings are reported and never activated, and source files are never changed. `--format claude|codex` disambiguates a source that carries both hidden manifests. Import defaults to user scope.

The command prints the review and then asks `Import this plan? [y/N]` on a terminal. `--yes` approves without asking, and without a terminal or approval nothing is installed. A plan is blocked when requirements are unmet or the package ID already exists in that scope. Apply refuses when the source or the normalized content changed after review. The result reports publication, validation of the installed components, and the trust gate as separate facts: the package is installed with `trust: foreign` and an `import` origin, and the gate `integrations.projectResources.trustProjectImports` decides whether its skills and prompts load. Exit 0 requires a published, valid package with no diagnostics. In a session, `/library import <path-or-url>` opens the same review.

An import never approves workspace trust, including the first import into a workspace. A `--project` import writes `.clio-coder/plugins/state.json`, and the imported package stays blocked until `clio-coder config trust plugins` approves the project's plugin state (see [Workspace trust for project packages](#workspace-trust-for-project-packages)). Both the trust gate above and that approval must pass before a project-scope import loads. A user-scope import needs only the trust gate. `--dry-run` writes nothing and, from a model shell, never asks for confirmation; a real model-run `import` asks like any other library mutation.

## One index format

The bundled index is `library/registry.yaml`. Clio Coder also reads the user index selected by `integrations.library.catalog` (default `<configDir>/library.yaml`) and the project `.clio-coder/library.yaml`. Project rows override user and bundled rows with the same typed reference; `--from <index>` has highest priority. Installed packages that no index lists still appear, with an unknown origin.

Clio Coder ships the index together with its curated `library/skills/` packages and `library/plugins/` plugins in the npm package. The curated `library/extensions/` packages ship the same way. Bundled sources resolve relative to the installed index, so they remain available from any working directory without a GitHub fetch. Built-in agents ship separately under `src/domains/agents/builtins/`, and installed plugins can contribute additional agents and bound skills. The Clio namespace of the manifest, `extensions["ai.iowarp.clio"]`, identifies Clio Coder-specific declarations inside a package, not a marketplace address. How the bundled index is generated is in [skills-marketplace.md](skills-marketplace.md#registry-and-pins).

```yaml
entries:
  - kind: plugin
    name: lab-workflow
    description: Evidence-based laboratory workflow.
    version: 1.0.0
    sourceUrl: ./lab-workflow
    sha256: <64 lowercase hexadecimal characters>
    requires:
      - skill:ship
```

An index is JSON or YAML, either an `entries` object or a list. Every row requires `kind`, `name`, `description`, `version` (Semantic Version), `sourceUrl`, and `sha256` (64 lowercase hexadecimal characters). Optional fields are `requires`, `category`, `audit` (`pass`, `warn`, `fail`, `unknown`), `triggers`, and `provides`, a list of up to 256 body-free hints `{kind, name, description}` for the components a package holds. An `extension` row may also carry `plugin: <name>`, the plugin it serves. A malformed `provides` list is dropped with a diagnostic and the row stays installable, because hints support discovery and never admission. Relative paths resolve beside the index. Remote sources must be explicit GitHub tree URLs such as `https://github.com/owner/repo/tree/v1.0.0/packages/lab-workflow`, fetched with a bounded shallow clone with Git hooks disabled; other URL forms are rejected. The staged tree must match the pin. Neither opening the library nor registration fetches remote content.

`requires` contains typed package references and must agree with `extensions["ai.iowarp.clio"].requires` in the package manifest. Missing, malformed and cyclic dependencies are refused. Dependencies must be installed, enabled and loadable; disabled or damaged dependencies require explicit repair. `install --with-requirements` includes missing dependencies in its plan and installs them in dependency order. Each package is atomic; a later package failure does not undo already installed dependencies.

## Register a local package

```bash
clio-coder library validate ./lab-workflow --json
clio-coder library register ./lab-workflow --project --json
clio-coder library install plugin:lab-workflow --project
```

Registration validates a local package and writes its identity, version, digest and source into the selected scoped index without installing it. Replacing an existing registration requires `--force`. A path with no directory fails with `no package directory at <path>`. Plain output is one line, ``registered <ref> <version> from <source>; install it with `clio-coder library install <ref>` ``; `--json` prints `{ok, entry}`. The contributor journey and the maintainer pin commands (`pnpm library:pin`, `pnpm library:check`) are in [authoring-plugins.md](authoring-plugins.md#authoring-templates-and-contributor-journey) and [skills-marketplace.md](skills-marketplace.md#registry-and-pins).

## Private index synchronization

Private index repositories may opt into Git synchronization. Set `integrations.library.sync: true` (default false), configure a Git remote named `library` in the directory that holds the user index, and review it with `clio-coder library remote confirm <url>`, which records `integrations.library.remote` when empty and `integrations.library.confirmedRemote`. `library sync` runs `git fetch library` and merges `FETCH_HEAD` with `--ff-only`; `library push` runs `git push library`. Disabled synchronization (`library_sync_disabled`), or a `library` remote that is missing or differs from the confirmed URL (`library_remote_unconfirmed`), refuses before mutation, and `remote confirm` with a URL that differs from the configured remote is refused (`library_remote_mismatch`). These commands synchronize the private repository; they do not update installed packages. Run by the model through a shell, `sync`, `push` and `remote confirm` ask for one-shot operator confirmation like every other library mutation.

## Interactive library

**Alt+L** (`clio-coder.library.toggle`) or `/library` opens the fullscreen Library, and Alt+L inside it closes it and returns to the composer draft. `/skills`, `/agents`, and `/prompts` open the same browser on their category; `/library` opens on Plugins. The six tabs cover Skills, Agents, Prompts, Playbooks, Plugins, and Extensions. A typed reference such as `/library install extension:materio` opens the matching tab. Keybinding overrides and modal ownership are in [commands-and-modes.md](commands-and-modes.md).

| Key | Action |
| --- | --- |
| `/` | Focus search, then type to filter rows. Letters and left/right edit the query, Enter returns to the list, and Esc clears search or returns before closing. |
| Left / Right | Change kind tab |
| `b` | Switch Browse and Installed |
| `s` | Switch user/project action scope |
| `Enter` | Open a package's members, or show detail for a member |
| `v` | Use the selected runtime component: prepare its invocation in the composer; a playbook opens its `/fleet run` approval preview |
| `i` | Review installation; a second request can include missing requirements |
| `u` | Review update |
| `e` | Enable or disable the selected installed copy |
| `r` | Review removal |
| `n` | Open library notices |
| `o` | Open local-agent discovery and reviewed adoption |
| `R` | Reread the inventory |
| `Esc` | Close or cancel |

Mode and scope remain visible on empty tabs. A member's management action names its whole owning package and the selected scope. Core and loose components have no package removal action. Pin and drift inspection stay in the CLI.

`/library inspect <ref>`, `/library install <ref>`, `/library update <ref>`, `/library enable <ref>`, `/library disable <ref>`, `/library remove <ref>`, and `/library import <path-or-url>` open the same browser and review flow, with typed references such as `skill:tdd` and an explicit `--user` or `--project` when needed. Each verb opens the Library on that package with the review of the same operation the `clio-coder library` verb would apply, and nothing is written until the review is accepted. A verb the selected row cannot take shows the reason as a notice instead of a review. `/library reload` refreshes the session. The `u`, `e` and `i` keys start the same reviews from the browser. Import reviews the supplied source, its supported components and omitted features. Origin, vendor format, trust, scope and actual availability are separate facts; an installed foreign package may still have components withheld by the trust setting.

Every managed change is reviewed before writing. The review shows dependencies, affected dependents, fallback behavior and recovery, with `d` revealing paths and digests. Esc cancels and releases staged sources. Outcomes report committed, failed and unattempted steps, disk verification, resource admission and session refresh separately. A failed refresh does not undo a committed write; `R` in the outcome retries refresh without repeating the mutation.

## Session reload and disable behavior

`/library reload` refreshes installed components (skills, prompts, agents, playbooks) in the active session and reports `library: reloaded installed components (generation <N>)`. If an external CLI command or file edit changes installed components, `/library reload` picks them up without a restart. Headless `library reload` refreshes only its own process.

Disabling a package, by `library disable <ref>` or `e` in the overlay, adds the package to the `disabled` list in `plugins/state.json` and deletes no files. Resource discovery rechecks installation state on the next read ([resources.ts](../../src/domains/plugins/resources.ts)), so disabling, removal and digest drift take effect before a manual reload, while additions and replacements need a reload. A CLI disable does not cancel an in-flight tool in another process or erase instructions already in model context. A disabled project copy suppresses the matching user copy, and `library enable <ref>` restores discovery. Extensions have their own lifecycle and reload (`/extensions reload`) and never load from `/library reload`; see [harness-extensions.md](harness-extensions.md).

## One inventory for the operator and the model

```bash
clio-coder library components --json
clio-coder library components materials --kind agent
clio-coder library components --source core --all
```

`library components` is the versioned, body-free read of the skills, agents, prompts and playbooks actually discovered here, across every source: bundled core components, loose user and project files, installed package members, and foreign files in interop compatibility roots. Each row carries its actual runtime name, its owning package or source class, its scope, its origin evidence, its availability (`available`, `untrusted`, `invalid`, `shadowed`, `unavailable`) and, where it is usable, its invocation. `--all` adds internal diagnostic agents. It never fetches a remote source and never writes.

`library skills [--all] [--json]` lists runtime skills, including unmanaged files, with scope, source, trust, and invocation mode; `--all` includes untrusted and manual-only skills. `library inventory --json` is the fixed, body-free skills wire contract (version 1, at most 64 skills) that GUI hosts read. `clio-coder agents [--json] [--all]` lists user-visible agent specs from built-in, plugin, user, and project definitions. `library validate <path>` validates an unmanaged draft or a complete package candidate.

Clio Coder reads the same inventory through `gateway(op="call", capability="clio_library", args={})`. That capability is a read: bounded `kind`, `query` and `ref` selection with `limit`/`offset` pages, tagged rows for loaded resources, catalog hints and install targets, and no activation, installation, registration or pin write anywhere in it. Skill activation stays under `context(scope="skills")` and `/skill <name>`. A hint row names its installable owner and that member's availability and never carries an invocation, because nothing has loaded it. Internal and shadow agents, untrusted resources and instruction bodies are not in the model's view at all, and a worker run has no library projection of its own. See [tool usage](tool-usage.md) for the argument surface and the row shapes.

## Retired surfaces

- `/plugins` and `/resources` slash commands: a usage error pointing to `/library` to browse and install plugins and extensions and `/extensions` to control the running ones.
- `/library extensions` and `/library extensions reload`: `/library` has no such subcommand; use `/extensions` and `/extensions reload`.
