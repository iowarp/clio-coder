# CLIO Coder public site

A static public window into CLIO Coder: one overview, user documentation, practical tutorials, and open research questions. The site has no account flow or hosted agent service. Read [DESIGN.md](DESIGN.md) before making changes.

## Live local preview

From the repository root:

```sh
node site/dev.mjs
```

Open **http://localhost:4173/**. The server builds the site, regenerates the public guides from current repository files, watches source changes, and reloads connected browsers. Use `node site/dev.mjs --snapshot` to preview a pinned documentation snapshot without regenerating it. It listens on all local interfaces so a forwarded browser can reach it. Pass `--host 127.0.0.1` for loopback-only access, or `--port 4180` for another port. Generated output is in ignored `.preview/` directories; verification screenshots stay outside the public tree.

Review the unregistered guides in `content/drafts/` in a second preview with its own output directory: `node site/dev.mjs --snapshot --review --dir .preview-review --port 4191`. Two previews must never share a directory.

## Design and prose rules

- `design-system.json` is the sanctioned palette, semantic theme map, shared motion tokens, and copy policy.
- `tokens.mjs` generates `css/brand.css`; component CSS cannot introduce literal colors.
- `DESIGN.md` documents the selected CLIO Coder identity, IOWarp references, naming, writing, copyright, and accessibility rules.
- `partials.html` supplies one header and footer. Primary navigation is Overview, Docs, Tutorials, Research.
- `policy.mjs` runs on every build and checks palette drift, color declarations, motion tokens, public copy length, disallowed phrases, navigation, attribution, and documentation boundaries.

The identity uses IOWarp’s existing cyan CLIO ring with a copper center. `assets/brand/` holds its high-quality original and the IOWarp lattice mark. Its provenance file records source artwork and hashes. Legacy terminal-orbit artwork remains in the repository for compatibility but is not published by the new site.

Export the selected artwork, tokens, fonts, and licenses for another CLIO project with `node site/export-brand.mjs --out /tmp/clio-brand-kit`. The kit contains no site layout code.

The live theme default is controlled by `defaultTheme` in `design-system.json`. Use `dark` (current), `light`, or `system`. Saved visitor preferences still take priority. Regenerate tokens and deploy a committed build after changing it; the initial HTML metadata and no-JavaScript CSS use the same setting.

After an explicitly authorized token change:

```sh
node site/tokens.mjs
```

## Generated documentation

`public-docs.json` explicitly selects user-facing repository sources, short labels, task groups, and optional source sections or authored summaries. The current visitor guides use brief summaries in `content/doc-summaries/`; edit those files, then regenerate the snapshot. `sync-docs.py` checks summary paths and produces the Markdown snapshot, search index, and provenance manifest. The manifest retains a hash of each full upstream guide and its immutable source commit. Each public page links to that full guide. Neither summary Markdown nor the architecture corpus, generated Wiki, audits, or agent work journals enter the public build. When section selection is used, every selected upstream heading must still exist.

```sh
python3 site/sync-docs.py --worktree
python3 site/sync-docs.py --check
```

Working-tree snapshots record a fixed source base, branch, full input hashes, and generated document hashes. `--check` validates current source bytes, selected sections, index, and manifest using the recorded base; it does not compare that base with a new HEAD. Committing an unchanged snapshot therefore does not invalidate it. The base is provenance, not a claim that modified source bytes were committed there.

For a future release snapshot, after its matching tag exists:

```sh
python3 site/sync-docs.py --source-ref v<VERSION>
```

`product.json.version` describes the documentation source; `publishedVersion` describes the released npm package. They intentionally differ during development. The overview and structured source metadata use `version`, set to the upcoming release while a development tree is pinned (a `-dev` package version is accepted for repository snapshots). A working-tree preview also accepts a pre-release of a later version, such as `0.8.0-rc.1` while the site stays on `0.7.0`; deployment and release checks reject working-tree snapshots, so regenerate the committed pin with `--source-ref v<VERSION>` before committing. The source version link points to the pinned repository snapshot. Keep `publishedVersion` accurate to the npm registry; update it only after confirming the published package. Installation always uses the actual npm package, with no link to an unpublished release tag.

A website can also pin the reviewed source without creating a package release:

```sh
python3 site/sync-docs.py --snapshot-ref <COMMIT>
python3 site/sync-docs.py --check
```

Repository snapshots use a full commit as their source reference and validate against its original document bytes. They remain valid after later working-tree changes. Production accepts an immutable repository or release snapshot and rejects a working-tree draft.

## Tutorials, research pages, and recordings

Research pages use the same registry shape in `content/research.json`, with Markdown in `content/research/`. They render at `/research/<slug>.html` and are listed at `/research.html`. Every old `/experimental` URL stays in `redirects.json`.

Write a useful Markdown article in `content/tutorials/` and register it in `content/tutorials.json`. [CONTENT.md](CONTENT.md) describes the guide blocks, the capture registry, and review builds; a `cover` names a capture in `content/captures.json` in place of `image`, `width`, `height`, and `alt`. Supply a slug, title, description, category, reading time, author, image dimensions, alt text, and source filename. The builder creates both its article and listing entry. An optional `video` field accepts a real YouTube ID and uses the privacy-enhanced embed domain. Publish captions with the recording. Empty media entries and fictional product demonstrations are not allowed.

`assets/temperature-calibration.zip` is the standalone runnable example from the recorded local CLIO Coder session. It contains only the implementation, seven tests, private package manifest, and README. It is published through the explicit build asset list so the tutorial does not depend on a separate product repository push. Test an extracted archive with `npm test` in its `temperature-calibration/` directory when replacing it.

## Build and verify

```sh
python3 site/sync-docs.py --check
node site/tokens.mjs --check
node site/policy.mjs
node site/build.mjs
python3 site/check.py
python3 site/tests/sync-docs.test.py
python3 site/image-variants.py --check
pnpm exec biome check site
node site/browser-check.mjs
node site/performance-check.mjs
# add --paths /tutorials/<slug>.html to measure guides with captures
```

The static checker validates the link graph, anchors, metadata, source provenance, and rendered documentation. The browser check covers both themes at 320, 390, 768, 850, 1024, and 1440px; all guides receive desktop accessibility checks. It exercises repeated copying, search keyboard navigation, active contents links, FAQ controls, screenshot viewing and zoom, menu keyboard behavior, saved themes, runtime reduced-motion changes, touch tablet rotation, redirects, 404 handling, and navigation without JavaScript. It writes screenshots and results to `/tmp/clio-site-review` by default; pass `--out` elsewhere. Pass `--url`, `--out`, or `--chrome` to override defaults; browser dependencies are reused from the GUI workspace.

Responsive images and square browser icons are generated from approved originals with `python3 site/image-variants.py`; `image-variants.json` records the hashes and sizes. Every build verifies these assets and adds responsive image attributes. The full-size viewer capture loads only when opened. The performance check measures cold-cache mobile FCP, LCP, layout shift, and initial asset transfers at 2Mbps download, 100ms latency, and 4x CPU slowdown. It writes `/tmp/clio-site-review/performance.json` and enforces documented budgets. Run it without another browser audit in parallel. These local measurements do not represent field Core Web Vitals.

## Search and crawler outputs

The build writes `sitemap.xml`, `robots.txt`, `llms.txt`, and `llms-full.txt` from the same records as the pages. Each sitemap entry carries a `lastmod` from the last commit that touched the page sources; a build outside a git checkout omits it rather than guessing. `robots.txt` names the major search and AI crawlers, allows every page and asset, and blocks only the internal docs manifest. `llms.txt` is a short Markdown index of every docs, tutorial, and research page; `llms-full.txt` carries their full Markdown with absolute links and a `Source:` line per page.

Every page has a structured data graph (WebSite, Organization, WebPage, breadcrumbs, and the article or software type that fits), and the home page adds a FAQPage built from its questions. Social previews are real product captures: `python3 site/image-variants.py --social` renders a 1200x630 PNG for every tutorial cover plus the default GUI capture into `assets/social/`, recorded in `social-images.json`. Hreflang alternates are not used because the site has one language. `check.py` enforces sitemap coverage and format, redirect exclusion, preview size, FAQ coverage, the robots policy, and llms link coverage.

`node site/build.mjs --out <directory>` supports an alternative output path. It refuses to replace a nonempty directory without its ownership marker. Output contains only published HTML, selected browser scripts and styles, product assets, fonts and licenses, search metadata, and the source manifest.

## Deployment

GitHub Pages serves https://coder.iowarp.ai from the `gh-pages` branch, which holds only the built website. No workflow deploys it; `.github/workflows/` holds only `ci` and `release`. Two paths commit to that branch.

A stable release deploys the site as part of publication. `scripts/release-candidate.mjs` builds `website.tgz` in an isolated checkout of the qualified commit, re-pinned there with `python3 site/sync-docs.py --snapshot-ref <COMMIT>`. `publishWebsite` in `scripts/release-publish.mjs` then unpacks it onto `origin/gh-pages`, commits and pushes, and the publisher waits for `/version.json` to report that commit. Beta and dev releases do not touch the site.

A website-only change between releases uses `bash site/publish-pages.sh` from a clean, committed tree. It runs `deployment-check.mjs` and `sync-docs.py --check`, builds with the current `HEAD` as the revision, runs `check.py`, and commits the output to the local `gh-pages` branch on top of the remote tip, stopping if the two have diverged. It never pushes. Review the commit and push the branch when authorized. Run it from `main`, so the published revision is a commit readers can find. It publishes the documentation pin committed in `content/docs-manifest.json`, which can be older than the one a release deployed, because the release re-pin stays in its isolated checkout.

`linkRef` in `product.json` is normally unset. When set, it points reader-facing source links at a public ref while the pinned commit is unpublished. The manifest still records the real pin.

The hosted installers are small: the build copies `scripts/installer-bootstrap/install.sh`, `scripts/installer-bootstrap/install.ps1` and `scripts/install.cmd` into the output unmodified, and `check.py` fails the build when they differ. The first two delegate to the full `scripts/install.sh` and `scripts/install.ps1` attached to each GitHub release, and `install.cmd` fetches the released `install.ps1`, so changing the full installers reaches users only through a release. A release attaches `install.sh`, `install.ps1`, `install.cmd` and `native-install.cjs`, and the attached scripts are the documented fallback when the site is unreachable.

GitHub Pages cannot send response headers or HTTP redirects. The Content-Security-Policy and referrer policy ride in `<meta>` tags, and each entry in `redirects.json` becomes a small page with a meta refresh, a canonical link and a script redirect. `frame-ancestors` and `X-Frame-Options` are not available. `CNAME` and `.nojekyll` are written by the build, and `/version.json` records the site version, the documentation commit and the deployed revision.

Preview the exact deployment build locally with `node site/build.mjs --out <directory>` and `python3 site/check.py <directory>`.
