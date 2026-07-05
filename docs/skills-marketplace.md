# Skills Marketplace

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/skills_blueprint.html](html/skills_blueprint.html) (Version: 0.2.8).

The Skills Hub (`/skill`) shows three groups: project skills, user skills, and the marketplace. The live marketplace listing is backed by the `skills/` tree of [github.com/iowarp/clio-coder](https://github.com/iowarp/clio-coder/tree/main/skills) on `main`. Skill installation resolves through Clio's local marketplace sources: a repo/catalog `skills/` directory, `CLIO_SKILL_CATALOG_DIR`, or `skill-marketplace.json`.

## How the hub reaches the marketplace

The hub opens instantly on local data and never blocks on the network. Marketplace rows hydrate in three layers:

1. **Live listing.** The GitHub contents API lists `skills/` directories. Each selected row lazily fetches its `SKILL.md` from `raw.githubusercontent.com` for the detail pane.
2. **Disk cache.** Listings and details are cached at `<cacheDir>/marketplace-cache.json` with a 24-hour TTL, which also keeps the unauthenticated GitHub rate limit comfortable. A corrupt cache file is treated as a miss.
3. **Local fallback.** Offline or rate-limited sessions fall back first to the stale cache, then to local marketplace entries discovered from a catalog directory or JSON index. The default fetcher performs that fallback internally, so the hub may still show the marketplace section even when the backing source was cache or local metadata.

## Using the hub

| Key | Action |
|---|---|
| type | Filter all groups |
| `Enter` | Insert `/skill:<name> ` into the editor for the task text |
| `Tab` | Toggle the detail pane (split layout on wide terminals) |
| `i` | Attempt to install the selected marketplace skill into the project scope through the local marketplace resolver |
| `PgUp`/`PgDn` | Scroll the detail pane |

Invoking an uninstalled marketplace skill with `/skill:<name>` prompts before installation when a local marketplace entry is available. `i` runs the same install path eagerly from the hub.

The CLI `clio skills` commands manage local skill discovery, validation, and
creation. Extension resource roots and share archives are documented in
[extensions-and-sharing.md](extensions-and-sharing.md); this page owns the TUI
Hub and marketplace behavior.

## Publishing a skill

Add a directory under `skills/<name>/` in the repo containing a `SKILL.md` with `name` and `description` frontmatter. The directory name must match `[A-Za-z0-9][A-Za-z0-9._-]*`. Once merged to `main`, the skill appears in every hub within the cache TTL. Scientific and niche coding domains are the marketplace's focus; see the existing `skills/` tree for the house format.
