# Resource Library

The resource library extends the existing local skills marketplace catalog to carry agent recipes, prompt templates, and fleet contracts. It does not change the Agent Skills format, discovery roots, trust gating, or existing skill installation sources.

## Catalog schema

A catalog is a JSON or YAML list, or an object whose `skills` property contains the list. The historical property name remains accepted so every existing skill marketplace index works unchanged.

```yaml
skills:
  - kind: fleet
    name: release
    description: Build and verify a release.
    sourceUrl: ./fleets/release.md
    requires:
      - agent:release-builder
      - skill:ship
```

`kind` accepts `skill`, `agent`, `prompt`, or `fleet` and defaults to `skill`. `requires` accepts typed references with those same four prefixes. Clio resolves requirements recursively across the selected catalog and the private catalog. Missing, malformed, and cyclic requirements are refused with stable `library_requirement_*` diagnostics. A requirement is satisfied when its typed reference exists in `<configDir>/library-pins.yaml` or its kind-specific destination exists. Add output lists satisfied and unsatisfied requirements separately. Requirements are reported without installation unless `library add` receives `--with-requirements`. That flag installs only the unsatisfied dependencies in dependency order before the requested entry.

## Private catalog and remote gating

`library.catalog` selects a private catalog and defaults to `<configDir>/library.yaml`. Relative sources in that file resolve beside the catalog. `library.remote` records an optional git remote URL. `library.sync` defaults to false, and no git process is started while it remains false.

The private catalog repository must name its git remote `library`. Clio checks it with `git remote get-url library`. Run `clio-coder library remote confirm <url>` once after reviewing the configured URL. When `library.remote` is unset, confirmation records the URL as both the configured and confirmed remote. A confirmation that differs from an existing `library.remote` refuses with `library_remote_mismatch`. A missing confirmation or a later settings change refuses synchronization and publishing with `library_remote_unconfirmed`.

When `library.sync` is false, both `library sync` and `library push` refuse with `library_sync_disabled` before any process starts. When synchronization is enabled, `library sync` runs `git fetch library` followed by `git merge --ff-only FETCH_HEAD`, and `library push` runs `git push library`. Both commands execute git as an argument vector without a shell.

## CLI

```text
clio-coder library list [--kind k] [--json]
clio-coder library search <query> [--kind k] [--json]
clio-coder library add <ref> [--from <catalog|path>] [--with-requirements] [--yes] [--json]
clio-coder library use <kind> <name>
clio-coder library push
clio-coder library sync
clio-coder library remote confirm <url>
```

`library add` prints every destination and SHA-256 hash before it writes. It writes nothing until `--yes` is present. `library use` prints the invocation to paste into the relevant surface.

## In the TUI

The Skills Hub carries one tab per kind. `/library <kind>` opens it on that kind's tab and `/library` alone opens it on Skills, which is also where `/skill` opens. Each tab lists the entries this same discovery finds, with the requirements an entry still needs named in the warning token. Installing from a row runs the same plan-then-write pair `library add` runs, behind a confirmation that states every destination and hash and writes nothing when it is cancelled, and an entry with unresolved requirements is refused by name before an install-with-requirements confirmation offers to write them all. `Enter` on an installed row leads where that kind is invoked from: the composer for an agent, a prompt, or a skill, and the `/fleet run` approval preview for a fleet. See [skills-marketplace.md](skills-marketplace.md) for the key table.

## Installation roots and validation

| Kind | User installation root | Validation before write |
| --- | --- | --- |
| skill | `<configDir>/skills/<name>/SKILL.md` | Existing skill loader and installer |
| agent | `<configDir>/agents/<name>.md` | Agent recipe schema and policy |
| prompt | `<configDir>/prompts/<name>.md` | Prompt template loader |
| fleet | `<configDir>/fleets/<name>.md` | Fleet contract parser |

Every installed item records a kind-qualified hash in `<configDir>/library-pins.yaml`. Agent recipes become visible through `clio-coder agents`. User fleet contracts participate between built-in and project fleet precedence, so a project contract still wins. Prompts use the existing user prompt root.

Share archives may carry agent and fleet entries. Import always validates these formats before writing, and fleet entries land in the user fleet root.
