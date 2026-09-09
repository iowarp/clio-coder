# Portable plugins and the library

> **Visual blueprint:** The source checkout includes the complete
> [Plugins visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/plugins_blueprint.html).

A plugin is a complete, versioned bundle of skills and supporting files. The portable root `plugin.json` follows [Agent Plugins 1.0.0](https://agent-plugins.org/). Clio reads native prompts, agent recipes, and fleets from its namespaced manifest extension. Installing a bundle keeps those resources and their references together.

Browse the bundled catalog, preview a complete installation, then install it:

```bash
clio-coder plugins search
clio-coder library list --kind plugin
clio-coder library add plugin:materio --json
clio-coder library add plugin:materio --yes
```

The catalog is shipped with Clio; it does not install content automatically. A preview reports the destination and full-tree SHA-256. The pin covers the manifest, skills, prompts, scripts, references, names, and directory structure. The installer checks the staged bundle again before committing it. If a source changes after the preview, make a new plan. `--force` never overrides a catalog pin mismatch.

For a bundle you authored locally, install its directory directly:

```bash
clio-coder plugins install ./my-plugin --project
clio-coder plugins inspect my-plugin --project --json
```

An existing local directory always wins over a catalog ID with the same spelling. `--project` installs into `.clio-coder/plugins/`; the default user scope installs into Clio's configuration directory. Valid, compatible project installations take precedence, including a disabled project installation that suppresses the user copy. The Plugins tab identifies every installed scope and the copy its actions select.

Manage installed content through the same lifecycle functions used by the terminal UI:

```bash
clio-coder plugins list --all --json
clio-coder plugins disable materio
clio-coder plugins enable materio
clio-coder plugins drift materio
clio-coder plugins pin materio
clio-coder plugins update materio
clio-coder plugins remove materio
```

Every successful installation records a verified pin. `pin` reports and verifies it; it does not approve edited files. Drifted content is blocked from loading. Update refuses to replace local edits unless `--force` is supplied; the install result reports any recovery copies of edited content. Updating a catalog package uses the current catalog version and pin. Updating a local package uses its recorded source directory, even when the catalog contains the same plugin name. Updates and replacements preserve an existing disabled state; enable the plugin explicitly when ready. Removal preserves edited content and reports its recovery path.

In an active session, open `/resources plugins` or `/resources library plugin`. The Plugins tab shows catalog entries and local installations, their scope, state, resources, and diagnostics. Press `i` to review an installation, `u` to review an update, `e` to enable or disable, `r` to review removal, `p` to inspect the verified pin, or `d` to check drift. Run `/resources plugins reload` to refresh resources in that session after changes. The headless `plugins reload` command refreshes only its own process.

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

Relative paths resolve against the catalog's directory. Remote bundles use an explicit GitHub tree URL such as `https://github.com/owner/repository/tree/v1.0.0/plugins/lab-workflow`, together with the full-tree digest and version. The bounded Git transport fetches the selected branch or tag; the installer verifies every bundle file against the catalog pin. Other URL formats are rejected as unsupported. Plugin entries never enter the skill-only marketplace or skill installer. Catalog `requires` references use the same typed dependency graph as other library entries. Installed plugin dependencies must also be loadable; disabled or damaged dependencies require explicit enabling or repair before installation continues.

Maintainers regenerate the shipped catalog after changing a bundled package:

```bash
pnpm plugins:pin
pnpm plugins:check
```

The pin command reads each bundle's actual portable manifest and hashes the complete bundle. `plugins:check` fails on stale catalog metadata or content digests and is part of release hygiene.

## Plugins and extensions

Plugins carry portable resources. Harness extensions carry executable command tools and hook declarations, and have their own manifest, install root, and lifecycle. The two never overlap: a manifest that declares domain resources is refused and points at `clio-coder plugins install <path>`. Use `clio-coder extensions list` and `/resources extensions` to inspect installed extensions; command-tool schema changes require a new session.
