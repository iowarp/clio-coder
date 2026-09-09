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
clio-coder library register ./lab-workflow --project --json
clio-coder library install plugin:lab-workflow --project
pnpm library:pin
pnpm library:check
```

Registration validates a local package and writes its identity, version, digest and source into the selected scoped index without installing it. Replacing an existing registration requires `--force`. The maintainer pin command regenerates the bundled index from complete packages in `skills/` and `plugins/`; `library:check` is part of hygiene. See [authoring a package](authoring-plugins.md) and the [architecture invariants](../architecture/library.md).

Private index repositories may opt into Git synchronization. Set `integrations.library.sync: true`, configure a remote named `library`, and review `clio-coder library remote confirm <url>`. `library sync` fetches that remote and merges `FETCH_HEAD` with `--ff-only`; `library push` pushes it. Disabled synchronization or an unconfirmed/mismatched remote refuses before mutation. These commands synchronize the private repository; they do not automatically update installed packages.

## Interactive library and evals

`/library` opens the plugin tab; `/library skill`, `/library agent`, `/library prompt`, and `/library fleet` select the other tabs. `s` switches the action scope between user and project. `i` reviews installation, `u` reviews update, `e` toggles enabled state, `r` reviews removal, `p` verifies the pin, and `d` checks drift. Long approval paths and digests wrap and scroll. `/library reload` refreshes resources in the active session. A headless `library reload` refreshes only its own process.

`/skill` opens the skill tab; `/skill <name>` activates a skill or offers its package installation. `library skills --all --json` lists runtime skills, including unmanaged files; `library inventory --json` is the fixed body-free GUI read. `library validate <SKILL.md>` validates an unmanaged draft. Installed package lifecycle remains in `library`; the retired top-level `skills`, `plugins`, and `/resources` spellings are unrecognized.

A package declares named suite paths in `extensions["ai.iowarp.clio"].evals`. Run the same eval interface for every kind:

```bash
clio-coder eval validate --package plugin:materio --eval scripts --project
clio-coder eval run --package plugin:materio --eval scripts --project
```

Evals run only when explicitly requested. Installed packages must be active and verified; local authoring directories can be tested directly. The resulting suite provenance includes the package reference, version, digest and eval name. Materio's `scripts` suite runs its offline Python contracts in a temporary copy; it measures script behavior, not model output quality. The separate experimental `eval skill <name|path>` lane runs authored `evals.md` baseline/treatment/judge scenarios.
