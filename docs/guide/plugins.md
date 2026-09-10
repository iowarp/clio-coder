# Portable plugins and the library

> **Visual blueprint:** The source checkout includes the complete
> [Plugins visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/plugins_blueprint.html).

A plugin is a complete, versioned bundle of skills and supporting files. The portable root `plugin.json` follows [Agent Plugins 1.0.0](https://agent-plugins.org/). Clio reads native prompts, agent recipes, and fleets from its namespaced manifest extension. Installing a bundle keeps those resources and their references together.

Browse the bundled catalog, preview a complete installation, then install it:

```bash
clio-coder library search
clio-coder library list --kind plugin
clio-coder library install plugin:materio --dry-run --json
clio-coder library install plugin:materio
```

The catalog is shipped with Clio; it does not install content automatically. A preview reports the destination and full-tree SHA-256. The pin covers the manifest, skills, prompts, scripts, references, names, and directory structure. The installer checks the staged bundle again before committing it. If a source changes after the preview, make a new plan. `--force` never overrides a catalog pin mismatch.

For a bundle you authored locally, install its directory directly:

```bash
clio-coder library install ./my-plugin --project
clio-coder library inspect my-plugin --project --json
```

An existing local directory always wins over a catalog ID with the same spelling. `--project` installs into `.clio-coder/plugins/`; the default user scope installs into Clio's configuration directory. Valid, compatible project installations take precedence, including a disabled project installation that suppresses the user copy. The Plugins tab identifies every installed scope and the copy its actions select.

Manage installed content through the same lifecycle functions used by the terminal UI:

```bash
clio-coder library list --all --json
clio-coder library disable materio
clio-coder library enable materio
clio-coder library drift materio
clio-coder library pin materio
clio-coder library update materio
clio-coder library remove materio
```

Every successful installation records a verified pin. `pin` reports and verifies it; it does not approve edited files. Drifted content is blocked from loading. Update refuses to replace local edits unless `--force` is supplied; the install result reports any recovery copies of edited content. Updating a catalog package uses the current catalog version and pin. Updating a local package uses its recorded source directory, even when the catalog contains the same plugin name. Updates and replacements preserve an existing disabled state; enable the plugin explicitly when ready. Removal preserves edited content and reports its recovery path.

In an active session, open `/library` or press Alt+L. Use the Plugins category, `b` for Browse or Installed, and `s` for User or Project scope. Enter opens a package's members; the selected row offers `i` to review installation, `u` to review an update, `e` to enable or disable, and `r` to review removal when those actions apply. Use the CLI `library pin` and `library drift` commands for pin and drift checks. Run `/library reload` to refresh resources in that session after changes. The headless `library reload` command refreshes only its own process.

## Private catalogs

The ordinary library catalog supports an `entries` list and plugin entries with explicit versions and pins:

```yaml
entries:
  - kind: plugin
    name: lab-workflow
    description: Lab analysis workflow and references.
    version: 1.0.0
    sourceUrl: ./lab-workflow
    sha256: <64 lowercase hexadecimal characters>
```

Relative paths resolve against the catalog's directory. Remote bundles use an explicit GitHub tree URL such as `https://github.com/owner/repository/tree/v1.0.0/plugins/lab-workflow`, together with the full-tree digest and version. The bounded Git transport fetches the selected branch or tag; the installer verifies every bundle file against the catalog pin. Other URL formats are rejected as unsupported. Automatic skill offers select only kind `skill`; they use the same package engine. Catalog `requires` references use the same typed dependency graph as other library entries. Installed plugin dependencies must also be loadable; disabled or damaged dependencies require explicit enabling or repair before installation continues.

Maintainers regenerate the shipped catalog after changing a bundled package:

```bash
pnpm library:pin
pnpm library:check
```

The pin command reads each bundle's actual portable manifest and hashes the complete bundle. `library:check` fails on stale catalog metadata or content digests and is part of release hygiene.

## Plugins and extensions

Recipe plugins and executable harness extensions serve different purposes and have completely distinct lifecycles:
- **Recipe Plugins**: Managed through `clio-coder library` and `/library`. They package portable declarative components (skills, prompts, agents, fleets, and supporting reference files or explicitly invoked evaluation scripts) using the portable `plugin.json` manifest. While full package trees may carry scripts invoked explicitly by evaluations or workflows, installation, browsing, or loading recipe metadata in the Library never registers executable harness capabilities (such as daemons, background runners, or harness hooks). They install into `.clio-coder/plugins/` (or user `plugins/`). Reloading recipes in an active session is done via `/library reload`.
- **Harness Extensions**: Managed through `clio-coder extensions` and `/extensions`. They package executable capabilities: an extension operator runtime requires a shipped Node `.mjs` entrypoint (`parseExtensionRuntime` in `src/domains/extensions/runtime-schema.ts`) registering custom slash handlers (`api.handle(...)`), passive lifecycle observations (`events: ["session_open", "turn_end"]`), status indicators, and UI panels. Separately, command tools support `runtime: node` or `python3`, and `hooks.yaml` defines blocking or effect-producing pre-tool/post-tool execution. Extensions install into `.clio-coder/extensions/` (or user `extensions/`). Reloading runtime handlers and hooks at idle is done via `/extensions reload` (subject to integrity checks). However, model-visible command-tool schemas are frozen at session boot and cannot change mid-session; altering tool schemas requires restarting Clio.
- **Strict Boundary**: The two systems never overlap. An extension manifest attempting to declare domain resources (`skills`, `prompts`, `agents`, `fleets`) is refused and points at `clio-coder library install <path>`. Use `clio-coder extensions list` and `/extensions` to inspect installed extensions. Retired slash commands `/plugins` and `/resources` return an explicit usage error directing operators to `/library` for recipe packages and `/extensions` for harness extensions.

## Other package kinds and evals

The same library supports single-resource skill, agent, prompt and fleet packages. See [library usage](resource-library.md) for registration and JSON state, and [architecture](../architecture/library.md) for the shared invariants. `/library` has all five kinds and `s` switches the selected scope.

Materio declares `extensions["ai.iowarp.clio"].evals.scripts: "evals/scripts.yaml"`. After installation, run `clio-coder eval validate --package plugin:materio --eval scripts` and `clio-coder eval run --package plugin:materio --eval scripts`. This offline suite copies the package to a temporary workspace and runs its Python script contracts. It does not evaluate model research quality.
