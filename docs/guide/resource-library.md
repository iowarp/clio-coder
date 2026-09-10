# Library packages

> **Visual blueprint:** See the [Library visual reference](../html/resource_library_blueprint.html) in the source checkout.

The **library** is Clio's collection of installable **packages**. Each package has one kind: `plugin`, `skill`, `agent`, `prompt`, or `fleet`. Every kind uses a root `plugin.json`, an explicit Semantic Version, a full-tree SHA-256 pin, and the same installation state. A plugin bundles several resources; each other kind exposes one public resource and may include supporting files.

## Browse and install

```bash
clio-coder library list --json
clio-coder library search research --kind skill
clio-coder library inspect plugin:materio --json
clio-coder library install plugin:materio --project --dry-run --json
clio-coder library install plugin:materio --project --json
```

`install` is an explicit request to write. `--dry-run` reports every source, destination and digest without installing. The TUI asks for confirmation before writing. `--force` permits replacement of ordinary installed packages and preserves edited files in a reported recovery directory; it cannot override a source pin, identity or version mismatch.

An existing local directory wins over a library name with the same spelling. `kind:name` checks the package kind; bare names are accepted when unambiguous. Package names share one namespace within each scope. A replacement cannot change a package's kind; remove it explicitly first.

## Scope and workspace state

All kinds install beneath `<configDir>/plugins/<name>/` at user scope or `<cwd>/.clio-coder/plugins/<name>/` at project scope. These existing engine directories hold complete packages, including single-resource packages. The corresponding `plugins/state.json` records kind, source, structured origin, trust, installation time and verified digest. There is no per-kind installation pin file.

Install and registration default to user scope. Other lifecycle actions select the project copy when it exists; `--user` or `--project` selects exactly that copy. A valid, compatible project copy takes precedence over the user copy. Disabling that project copy suppresses the user copy as well. Invalid project content does not hide a valid user installation.

`library list --json` returns `{entries, diagnostics}`. Each entry includes an `installed` array containing every matching installed scope and its `enabled`, `valid`, `compatible`, `effective`, and `loadable` state. An empty array means the package is available but uninstalled. Scope flags filter the installed copies. Broken and disabled packages remain visible for repair or removal.

```bash
clio-coder library disable plugin:materio --project
clio-coder library enable plugin:materio --project
clio-coder library drift plugin:materio --project
clio-coder library pin plugin:materio --project
clio-coder library update plugin:materio --project --dry-run
clio-coder library update plugin:materio --project
clio-coder library remove plugin:materio --project
```

Drift prevents resources from loading. `pin` verifies and reports the recorded pin; it never blesses local changes. Updates of registered packages use the current index version and pin. Local installations update from their recorded directory. Update and replacement preserve disabled state. Removal preserves edited content and reports the recovery path. Installed state remains addressable after its index entry disappears.

Interop adoption records `{kind: "interop", host, source}` and `trust: "foreign"`. Foreign skills and prompts require `integrations.projectResources.trustProjectImports`, including foreign project files adopted to user scope. Updates and forced replacement of an interop-origin package are refused: remove it and review a new adoption so omitted host executables cannot reappear. See [interoperability](interop.md).

## One index format

The bundled index is `library/registry.yaml`. Clio also reads the user index selected by `integrations.library.catalog` (default `<configDir>/library.yaml`) and the project `.clio-coder/library.yaml`. Project rows override user and bundled rows with the same typed reference; `--from <index>` has highest priority.

Clio Coder ships the index together with its curated `library/skills/` packages and `library/plugins/` bundles in the npm package. Bundled sources resolve relative to the installed index, so they remain available from any working directory without a GitHub fetch. Built-in subagent recipes ship separately under `src/domains/agents/builtins/`; installed plugins can contribute additional recipes and bound skills. The manifest's `ai.iowarp.clio` extension key identifies Clio-specific declarations inside a package, not a marketplace address.

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

An index is JSON or YAML, either an `entries` object or a list. Every row requires kind, name, description, version, source and digest. Relative paths resolve beside the index. Remote sources use explicit GitHub tree URLs, such as `https://github.com/owner/repo/tree/v1.0.0/packages/lab-workflow`; the staged tree must match the pin. Neither opening the library nor registration fetches remote content.

`requires` contains typed package references and must agree with `extensions["ai.iowarp.clio"].requires` in the package manifest. Missing, malformed and cyclic dependencies are refused. Dependencies must be installed, enabled and loadable; disabled or damaged dependencies require explicit repair. `install --with-requirements` includes missing dependencies in its plan and installs them in dependency order. Each package is atomic; a later package failure does not undo already installed dependencies. Updates require their dependencies to be installed first.

## Register and publish

```bash
clio-coder library validate ./lab-workflow --json
clio-coder library register ./lab-workflow --project --json
clio-coder library install plugin:lab-workflow --project
pnpm library:pin
pnpm library:check
```

Working authoring templates for all five package kinds live in `library/_authoring/templates/`. Registration validates a local package and writes its identity, version, digest and source into the selected scoped index without installing it. Replacing an existing registration requires `--force`. The maintainer pin command regenerates the bundled index from complete packages in `library/` (`library/skills/` and `library/plugins/`); `library:check` is part of hygiene and verifies all distributed bytes against `library/registry.yaml`. For curated skills, `skills:pin` records normalized skill-body hashes as provenance evidence. See [authoring a package](authoring-plugins.md) and the [architecture invariants](../architecture/library.md).

`library:pin` also regenerates `.claude-plugin/marketplace.json` from those pins, which is what lets another agent install these packages from the repository: `claude plugin marketplace add iowarp/clio-coder`, then `claude plugin install <name>@clio-coder`. Codex reads the same canonical directories through `.agents/skills`. Neither surface holds a copied recipe body, and `library:check` fails on a stale one. A package publishes there only when a peer host would load a real skill surface from it and nothing it would default-scan into a native component; the pin run prints which packages it left out and why, and leaving one out is not a failure. See [coding agent interoperability](interop.md).

Private index repositories may opt into Git synchronization. Set `integrations.library.sync: true`, configure a remote named `library`, and review `clio-coder library remote confirm <url>`. `library sync` fetches that remote and merges `FETCH_HEAD` with `--ff-only`; `library push` pushes it. Disabled synchronization or an unconfirmed/mismatched remote refuses before mutation. These commands synchronize the private repository; they do not automatically update installed packages.

## Interactive library and evals

**Alt+L** or `/library` opens the fullscreen Library; `/skills`, `/agents`, and `/prompts` open its corresponding category. The five tabs cover skills, agents, prompts, fleets, and plugins. `b` switches Browse/Installed, and `s` selects User/Project for management. Mode and scope remain visible on empty tabs. Left/right changes category; `/` focuses search, where letters and left/right edit the query. Enter returns from search to the list; Esc clears search or returns before closing.

Enter opens a package's members. `v` uses an available recipe by preparing its invocation in the composer; a fleet opens its existing approval preview. `i` reviews installation, `u` update, `e` enable/disable, and `r` removal. A member's management action names its whole owning package and the selected scope. Core and loose recipes have no package removal action. `o` opens local-agent discovery and reviewed adoption; `R` rereads the browser inventory. Pin and drift inspection remain available through the CLI.

`/library inspect <ref>`, `/library install <ref>`, `/library remove <ref>`, and `/library import <path-or-url>` open the same browser and review flow; use typed references such as `skill:tdd` and an explicit `--user` or `--project` when needed. Import reviews the supplied source, its supported recipes and omitted features. Origin, vendor format, trust, scope and actual availability are separate facts; an installed foreign package may still have recipes withheld by the trust setting.

Every managed change is reviewed before writing. The review shows dependencies, affected dependents, fallback behavior and recovery, with `d` revealing paths and digests. Esc cancels and releases staged sources. Outcomes report committed, failed and unattempted steps, disk verification, resource admission and session refresh separately. A failed refresh does not undo a committed write; `R` in the outcome retries refresh without repeating the mutation. `/library reload` refreshes recipes in the active session; a headless `library reload` refreshes only its own process. Harness reload stays under `/extensions reload`.

`/skills` opens the skill tab; `/skill <name>` activates a skill or offers its package installation. `library skills --all --json` lists runtime skills, including unmanaged files; `library inventory --json` is the fixed body-free GUI read. `clio-coder library validate <path>` validates an unmanaged draft or a complete package candidate. Installed package lifecycle remains in `library`; the retired top-level `skills` and `plugins` commands and the `/resources` and `/plugins` slash spellings are unrecognized. `/extensions` is the harness extension surface and is separate from the recipe library.

## One inventory for the operator and the model

```bash
clio-coder library recipes --json
clio-coder library recipes materials --kind agent
clio-coder library recipes --source core --all
```

`library recipes` is the versioned, body-free read of the recipes actually discovered here, across every source: bundled core recipes, loose user and project files, installed package members, and foreign files in interop compatibility roots. Each row carries its actual runtime name, its owning package or source class, its scope, its origin evidence, its availability and, where it is usable, its invocation. It never fetches a remote source and never writes. `library list` and `library search` stay package-oriented and answer with install targets; `--kind agent` there also matches packages whose generated `provides` hints include an agent, so a kind query finds the owning bundle before installation. `library inventory --json` is unchanged: it remains the fixed skills wire contract that GUI hosts read.

Clio reads the same inventory through `context(scope="library")`. That scope is a read: bounded `kind`, `query` and `ref` selection with `limit`/`offset` pages, tagged rows for loaded resources, catalog hints and install targets, and no activation, installation, registration or pin write anywhere in it. Skill activation stays under `context(scope="skills")` and `/skill <name>`. A hint row names its installable owner and that member's honest state and never carries an invocation, because nothing has loaded it. Internal and shadow agents, untrusted resources and instruction bodies are not in the model's view at all, and a worker run has no library projection of its own. See [tool usage](tool-usage.md) for the argument surface and the row shapes.

A package declares named suite paths in `extensions["ai.iowarp.clio"].evals`. Run the same eval interface for every kind:

```bash
clio-coder eval validate --package plugin:materio --eval scripts --project
clio-coder eval run --package plugin:materio --eval scripts --project
```

Evals run only when explicitly requested. Installed packages must be active and verified; local authoring directories can be tested directly. The resulting suite provenance includes the package reference, version, digest and eval name. Materio's `scripts` suite runs its offline Python contracts in a temporary copy; it measures script behavior, not model output quality. The separate experimental `eval skill <name|path>` lane runs authored `evals.md` baseline/treatment/judge scenarios.
