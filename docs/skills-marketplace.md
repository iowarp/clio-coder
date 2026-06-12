# Skills Marketplace

The Skills Hub (`/skill`) shows three groups: project skills, user skills, and the marketplace. The marketplace group is backed by the `skills/` tree of [github.com/iowarp/clio-coder](https://github.com/iowarp/clio-coder/tree/main/skills) on `main`.

## How the hub reaches the marketplace

The hub opens instantly on local data and never blocks on the network. Marketplace rows hydrate in three layers:

1. **Live listing.** The GitHub contents API lists `skills/` directories. Each selected row lazily fetches its `SKILL.md` from `raw.githubusercontent.com` for the detail pane.
2. **Disk cache.** Listings and details are cached at `<dataDir>/marketplace-cache.json` with a 24-hour TTL, which also keeps the unauthenticated GitHub rate limit (60 requests/hour) comfortable. A corrupt cache file is treated as a miss.
3. **Pinned fallback.** Offline or rate-limited sessions fall back first to the stale cache, then to the pinned local marketplace list maintained by `npm run skills:pin`. Detail panes label cached or pinned content.

## Using the hub

| Key | Action |
|---|---|
| type | Filter all groups |
| `Enter` | Insert `/skill:<name> ` into the editor for the task text |
| `Tab` | Toggle the detail pane (split layout on wide terminals) |
| `i` | Install the selected marketplace skill into the project scope |
| `PgUp`/`PgDn` | Scroll the detail pane |

Invoking an uninstalled marketplace skill with `/skill:<name>` still installs it on first use; `i` simply does it eagerly from the hub.

## Publishing a skill

Add a directory under `skills/<name>/` in the repo containing a `SKILL.md` with `name` and `description` frontmatter. The directory name must match `[A-Za-z0-9][A-Za-z0-9._-]*`. Once merged to `main`, the skill appears in every hub within the cache TTL. Scientific and niche coding domains are the marketplace's focus; see the existing `skills/` tree for the house format.
