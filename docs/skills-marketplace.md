# Skills Marketplace

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/skills_blueprint.html](html/skills_blueprint.html) (Version: 0.3.6).

The Skills Hub (`/skill`) shows project skills, user skills, and the marketplace. Every marketplace row comes from the same local lookup that `clio-coder skills install <name>` and `/skill <name>` resolve through, so the hub lists nothing it cannot install.

## Where marketplace rows come from

There is one source, `discoverMarketplaceSkills()` in `src/domains/resources/skills/marketplace.ts`, and it reads two kinds of real local data:

1. **A catalog directory** of actual `SKILL.md` packages. Resolution order: `CLIO_CODER_SKILL_CATALOG_DIR`, then a `skills/` directory in the working tree when it holds packages, then the `skills/` catalog the installed clio-coder package carries. Metadata comes from the packages themselves through the skill loader, so a row's version, category, and audit state are the package's own.
2. **A JSON index** whose entries name a `sourceUrl` that `clio-coder skills install` accepts. Resolution order: `CLIO_CODER_SKILL_MARKETPLACE_INDEX`, then `<configDir>/skill-marketplace.json`, then the package's own `skills/skill-marketplace.json`. `npm run skills:pin` publishes that file's `version`, `audit`, and `category` fields.

The package fallbacks mean a fresh npm install has a marketplace with no configuration: `clio-coder skills search grill` lists `grill-me` from the shipped catalog, `clio-coder skills install grill-me` copies it out of the package into `.clio-coder/skills/`, and `/skill grill-me` offers that install before running. The shipped catalog is a marketplace source only, never a discovery root: nothing from it is loadable until the operator installs it, which keeps the install-then-activate contract and the per-skill scope choice in the operator's hands.

Catalog packages win over index entries on a name collision, because the local files are the thing that installs. Neither source reaches the network; the hub opens on local data and never blocks. Only an index entry whose `sourceUrl` is a GitHub URL, and that no catalog also carries, needs the network at install time.

The model sees the same lookup: `context(scope="skills")` lists installed skills and, under a `Marketplace (not installed)` heading, the entries this lookup would install. Loading a marketplace-only skill by name answers "not installed" and points at `/skill <name>`, never `unknown skill`.

When both sources are absent (a source checkout with no `skills/` folder, or an incomplete package) the hub has nothing to list and says so, naming the remedy:

```
no skills installed and no local marketplace configured. install one with
`clio-coder skills install <path|github-url>`, or point CLIO_CODER_SKILL_CATALOG_DIR at a
skills/ catalog.
```

The CLI reports the same state as `no local skill marketplace catalog or index configured`. A marketplace source that exists but fails (an unreadable index, a broken catalog package) is a diagnostic row in the hub, not a silent omission.

## Using the hub

| Key | Action |
|---|---|
| type | Filter all groups |
| `Enter` | Insert `/skill <name> ` into the editor for the task text |
| `Tab` | Toggle the detail pane (split layout on wide terminals) |
| `i` | Install the selected marketplace skill into the project scope through the local marketplace resolver |
| `PgUp`/`PgDn` | Scroll the detail pane |

Invoking an uninstalled marketplace skill with `/skill <name>` prompts before installing it. `i` runs the same install path eagerly from the hub.

The CLI `clio-coder skills` commands manage local skill discovery, validation, and
creation. Extension resource roots and share archives are documented in
[extensions-and-sharing.md](extensions-and-sharing.md); this page owns the TUI
Hub and marketplace behavior.

## Publishing a skill

Add a directory under `skills/<category>/<name>/` (or `skills/<name>/`) in the repo containing a `SKILL.md` with `name` and `description` frontmatter. The directory name must match `[A-Za-z0-9][A-Za-z0-9._-]*`. Run `npm run skills:pin` to republish `skills/skill-marketplace.json`, which is the index consumers point `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at or copy to `<configDir>/skill-marketplace.json`. Scientific and niche coding domains are the marketplace's focus; see the existing `skills/` tree for the house format.
