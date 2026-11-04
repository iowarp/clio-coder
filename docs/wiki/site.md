---
title: "Public website build and documentation sync"
summary: "How the public Clio Coder website is generated, previewed, validated, and kept in step with the user guides under docs/guide. Read this before changing site pages, build scripts, or the documentation snapshot."
sources:
  - "site/build.mjs"
  - "site/sync-docs.py"
  - "site/dev.mjs"
  - "site/check.py"
  - "site/browser-check.mjs"
  - "site/js/site.js"
  - "site/js/docs.js"
  - "site/js/landing.js"
  - "site/public-docs.json"
tests:
  - "site/tests/sync-docs.test.py"
invariants:
  - "site/build.mjs refuses an --out directory that is not empty-or-owned by its marker file, and refuses an --out equal to the filesystem root, the site source directory, or a parent of it."
  - "site/sync-docs.py builds documentation pages only from entries in site/public-docs.json whose source is a guide under the docs/guide directory or README.md; a source or summary outside that boundary raises before any output is written."
  - "In working-tree snapshot mode, sync-docs.py --check compares against the recorded base commit, so committing the generated files does not by itself make the snapshot fail the check; editing a guide afterward does."
  - "A release snapshot taken from a branch rather than a v<version> tag is refused with 'require --source-ref'."
  - "site/build.mjs --review throws unless --out is also given, so review drafts are not written into the default output directory."
validate:
  - "python3 site/sync-docs.py --check"
  - "python3 -m unittest site/tests/sync-docs.test.py"
  - "node site/build.mjs --out <scratch-directory> && python3 site/check.py <scratch-directory>"
---

# Public website build and documentation sync

The `site/` directory produces the public Clio Coder website. It has three jobs: pull the
user guides under `docs/guide` into a pinned, hashed snapshot; render that snapshot and the
authored pages into static HTML; and check the rendered output before it is published. A
contributor needs this page when editing a page template, a client script, a guide directive,
the documentation allowlist, or the preview server.

## What the area does

- `site/sync-docs.py` reads `site/public-docs.json`, the allowlist of guides. It writes the
  rendered Markdown into `site/content/docs/`, a search index at `site/content/index.json`, and
  a manifest at `site/content/docs-manifest.json`. Its `--check` mode recomputes the expected
  bytes and fails on drift.
- `site/build.mjs` reads the content, product and brand JSON files, the tutorial and
  experimental catalogs, and the templates, and writes a static tree. It emits HTML for each
  page, copies fonts, responsive images, captures, CSS and client scripts, and writes a sitemap,
  `site/robots.txt`, `CNAME`, `.nojekyll`, `version.json`, `site.webmanifest`, and redirect stubs.
- `site/dev.mjs` runs a local HTTP server on a `.preview*` directory. It rebuilds on source
  changes, streams reload events to connected browsers, and swaps output by renaming directories.
- `site/check.py` validates a built tree: private directories absent from output, unique
  titles and descriptions, canonical and alternate links, structured data, sitemap entries,
  internal links and anchors, manifest icons, and installer bootstrap files.
- `site/browser-check.mjs` drives a headless Chromium through `playwright-core` and
  `@axe-core/playwright` across viewport widths and both themes, checking horizontal overflow, a
  single `main h1`, WCAG 2 A and AA axe rules, and browser console or page errors.

## Owning source

| Concern | Source | Key symbols |
| --- | --- | --- |
| Allowlist and snapshot generation | `site/sync-docs.py` | `inputs`, `check`, `sync`, `main` |
| Static site generation | `site/build.mjs` | `renderMarkdown`, `directives`, `directive`, `shell`, `head`, `responsiveImages`, `writePage` |
| Preview server | `site/dev.mjs` | `build`, `run`, `changed`, the request handler |
| Output validation | `site/check.py` | the `Page` parser class and the link and metadata checks |
| Browser checks | `site/browser-check.mjs` | the per-case loop over theme, width and path |
| Client behavior | `site/js/site.js`, `site/js/docs.js`, `site/js/landing.js` | copy buttons, screenshot viewer, tabs, capture sequences, search, table-of-contents tracking, scene playback |

The only focused test under `site/` is `site/tests/sync-docs.test.py`. A search of the
repository for references to these scripts from `package.json` was not repeated,
so this page does not claim how they are wired into package scripts. Deployment and the
contributor notes in `site/CONTENT.md` were not read for this page.

## Documentation snapshot flow

`site/sync-docs.py` has these modes:

1. `--worktree` reads current files from the working tree. The manifest records mode
   `working-tree` and the branch name (or the commit) as `source.ref`.
2. `--source-ref <ref>` and `--snapshot-ref <commit>` read a pinned Git revision. `inputs`
   refuses a plain release snapshot unless the ref is `v<version>`. A repository snapshot
   (`--snapshot-ref`) skips that check and records mode `repository`. Both compare the
   `package.json` version in that revision against `site/product.json`; a `-dev` suffix is
   accepted only for working-tree and repository snapshots.

`inputs` enforces the public boundary for each catalog entry. The source must match
a guide under the `docs/guide` directory or `README.md` with no `..` segments, the output path must end in `.md`
and be unique, and a `sections` list must name `## ` headings that exist, or the call raises
`public section disappeared from <source>`. A `summary` must match
`[a-z0-9]+(?:-[a-z0-9]+)*\.md` and replaces the upstream body with the file read from
`site/content/doc-summaries/`. The excerpt and title come from the catalog entry.

`sync` writes the generated files into a temporary directory under `site/content`, replaces
`content/docs`, and then writes the index and manifest. `check` recomputes every generated
file, the index and the manifest and reports `documentation drift`, `documentation search index
differs`, or `documentation source manifest differs`.

The focused test file `site/tests/sync-docs.test.py` builds a temporary repository with
`docs/guide/start.md` and a catalog entry whose `sections` is `["Run Clio"]`. Its cases:

- `test_committing_snapshot_does_not_invalidate_its_base`: syncs `HEAD` in working-tree mode,
  commits, and expects `check()` to pass. Changing `Run \`clio-coder\`.` in the guide afterward
  must raise `documentation drift`.
- `test_generated_bytes_and_search_index_are_validated`: overwrites `site/content/docs/README.md`
  and expects `documentation drift`; overwrites the index with `[]` and expects a
  `search index` error.
- `test_repository_snapshot_is_immutable_without_a_release_tag`: syncs a commit in repository
  mode, changes the guide, and expects `check()` to still pass. Setting `sourceSha256` to zeros
  in the manifest raises `source manifest`.
- `test_release_snapshot_ignores_later_working_tree_changes`: tags `v1.0.0`, syncs it, and
  expects a later edit to pass. Syncing `main` as a release raises `require --source-ref`.
- `test_public_summary_retains_pinned_source_and_detects_edits`: sets the catalog `summary` to
  `start.md`, asserts the generated README contains `Your first task` and not
  `Private development detail`, and expects a later summary edit to raise `documentation drift`.
- `test_summary_and_upstream_sources_cannot_escape_public_boundary`: a summary containing a parent-directory (`..`) segment
  raises `invalid public summary`, and a source of `docs/guide/private/notes.md` raises
  `not a public user guide`.

## Build flow

`site/build.mjs` runs top to bottom at module load. The sequence is:

1. Parse `--out`, `--revision` and `--review`. `--review` without `--out` throws, and a
   `--revision` that is not a 40-character lowercase hex commit throws.
2. Refuse an `--out` equal to `/`, the site root, or a parent of the site root.
3. Call `checkPolicy()` imported from `site/policy.mjs`. That module was not read for this page.
4. Read the JSON inputs. Validate each capture (its required keys, the `assets/` path pattern,
   and that both files exist), and resolve each tutorial's `cover` against `captures`.
5. Check that each `site/image-variants.json` asset matches its SHA-256 hash, and validate the
   `site/redirects.json` keys and targets against static URL patterns.
6. Verify `manifest.source.version` equals `product.version`, check the commit format, and
   check that the index and catalog path lists are identical.

Rendering goes through `renderMarkdown(markdown, sourcePath, guide)`. A `marked` renderer
overrides `heading` (to assign slugs and deduplicate with a numeric suffix), `link` (to map
internal links through `sourceMap` or fall back to a repository blob URL), `image`, and `code`
(to set a language label). When `guide` is true, `directives` splits `:::` blocks and
dispatches each one to `directive`. The recognized names are `needs`, `steps`, `prompt`,
`result`, `limits`, `note`, `capture`, `diagram`, `tabs`, `compare` and `next`. An unknown name
throws `Unknown guide directive`. A `tabs` block requires each child to start with a `###`
heading and throws `Each tab in a tabs directive starts with a ### heading` otherwise.

`shell(html, path, title, description, type)` fills the template comment slots, rewrites
`<pre>` blocks into labeled code blocks, and calls `responsiveImages`, which adds `srcset` and
`sizes` from `site/image-variants.json`. `writePage` throws `Unresolved template slot` if any
`<!-- site-`, `<!-- doc-`, `<!-- tutorial-`, `<!-- source-` or `<!-- version` comment remains.

Output writing is guarded. `site/build.mjs` reads the output directory's marker file
`.clio-coder-site-build`. It refuses to proceed if the directory is nonempty and the marker is
absent or names a different root. It then removes and recreates the directory. The remaining
steps copy assets, write one page per guide and tutorial, the collection listings, redirect
stubs, the sitemap, the installer bootstraps from `scripts/`, `version.json`, and the
search index. Two nginx-facing files are also written: `.clio-coder-redirects.conf` and
`.clio-coder-revision.conf`. The code comment marks the former as kept only for one
deployment.

The content security policy is written into each page as a `<meta http-equiv>` tag. The comment
in `site/build.mjs` states that `frame-ancestors` is not honored in a meta tag and cannot be
restored there.

The build's failure modes are represented by the throws listed above. Review drafts are
included only when `--review` is passed, which the code in `site/build.mjs` requires to be
paired with `--out`, and `site/dev.mjs` passes `--review` only when its own flag is set.

## Preview server

`site/dev.mjs` runs `sync-docs.py --worktree` (unless `--snapshot` is given), then
`build.mjs --out <dir>-next`, and swaps the result into `<dir>` by renaming. The previous
output is moved to `<dir>-previous` and removed after the swap. Builds are serialized: a request
during a build sets `pending` and reruns once. A failure logs a message and keeps the last good
output. The `--dir` argument must match `^\.preview[a-z0-9-]*$`.

The server serves only regular files under that directory. It returns 404 for any path with a
dot segment, sets a Content-Security-Policy header, and injects a script tag that loads "/__reload.js"
into HTML responses unless the request carries `__static`. The reload script URL is a route that
the server answers directly, not a file on disk. `/__events` is a server-sent-events stream
that receives `data: reload` after each successful swap. Paths listed in `site/redirects.json` are
answered with 308.

File watching triggers a rebuild for changes whose names end in html, css, js, mjs, json, md,
py, webp, or png. It skips names starting with `.preview`, `public`, `content/docs`, or
`site/content/index.json`. It also watches `docs/guide`, and the repository root `README.md` and
`package.json`.

## Client scripts

`site/js/site.js` is loaded on every page. It wires the theme toggle and `clio-theme` storage,
the navigation menus with Escape handling, copy buttons for `<pre>` blocks and `[data-copy]`
elements, a `<dialog>` screenshot viewer for links to `/assets/` PNG files, capture sequences
behind a tab list, tab sets for install commands, and scroll reveals. Reveals are skipped
when `prefers-reduced-motion` matches.

`site/js/docs.js` runs only on pages with an `#doc` element. It fetches the generated search index
for search when a search box is present, redirects a legacy `?d=` query to the matching guide URL,
and keeps the table of contents aligned with scroll position through `aria-current`.

`site/js/landing.js` controls the landing page's video scenes. It plays a scene only when it is
visible, the page is visible, motion is allowed, and the visitor has not paused it. It
releases a video's `src` when the theme changes and resumes from the saved position. No
browser test covering these client files was inspected; `site/browser-check.mjs` exercises some
of the same behavior (menus, copy, theme persistence, screenshot viewer, search keyboard use,
redirects, and reduced motion) and is the closest check.

## Things to watch when editing

- `site/build.mjs` deletes and recreates its output directory. Output paths should be scratch
  directories, and an existing `--out` directory must carry the builder's marker or be absent.
- Review drafts enter a build only through `--review`, which requires `--out`. Do not add drafts
  to a standard build.
- The sync script's public boundary depends on `site/public-docs.json`. A new guide is public
  only when it appears there, and a new `sections` entry must match an existing `## ` heading
  in the source file.
- Any hand edit to `site/content/docs`, `site/content/index.json`, or
  `site/content/docs-manifest.json` without rerunning `site/sync-docs.py` causes `check` to report
  drift.
- `site/browser-check.mjs` takes its Chromium path from `CLIO_CODER_CHROME` or a fixed default
  under the operator's home directory, and writes screenshots to `/tmp/clio-site-review` by
  default. Pass `--chrome` and `--out` when running it elsewhere. It loads `playwright-core` and
  `@axe-core/playwright` through the package manifest at `apps/clio-coder-gui/package.json`. The
  browser check was not run for this page.

## Related pages

The interactive surfaces that the guides describe are covered by the [CLI surfaces](cli.md)
page. Repository-level scripts are covered by the [scripts](scripts.md) page.

