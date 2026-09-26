# Clio Coder website redesign review

Reviewed and deployed on 2026-09-26, branch `v057`. Website implementation commit: `46bfe07b9`. Public origin: https://coder.iowarp.ai/.

## Design and scope

The website uses a new sans-serif product design with self-hosted IBM Plex Sans and Mono, a compact navigation system, controlled reading widths, shared components, and responsive layouts. The original website stylesheet was replaced. The semantic color contract remains cyan for interaction, sage for success, amber for action/warning, brick for failure, warm paper for light surfaces, black for dark surfaces, and dark code wells in both themes.

The homepage introduces the agent, installation, scientific verification, model choice, workers, context, reusable procedures, integrations, and practical limits in that order. A labeled illustrative solver workflow accompanies the introduction. The original terminal screenshot remains unchanged and matches `assets/readme/clio-session.png` by SHA-256; a smaller WebP derivative links to the original.

Installation, capabilities, runtime architecture, integrations, library, learning, project provenance, sharing, and 404 pages use the same system. The documentation reader has a start-first grouped navigation, active-page indicator, generated table of contents, code copy controls, and a narrower reading column. All ten written labs remain usable. Empty recording entries produce no placeholder cards; valid supplied recordings can render at build time.

The GUI is described as an opt-in alpha with different coverage from the terminal. Its architecture is stated as React/Vite, Node/Hono HTTP/SSE, and ACP over stdio. This task changed only `site/`. Concurrent GUI/runtime changes, repository `docs/`, root `dist/`, Dynamo, DNS records, tunnel configuration, and unrelated services were preserved.

## Build and checks

- `node site/build.mjs`: passed; 58 indexable pages, including 49 documentation pages.
- `python3 site/check.py`: passed; readable rendered documentation, unique titles and descriptions, canonical URLs, structured data, matching Open Graph/Twitter metadata, correct document source links, assets, anchors, and internal links.
- `pnpm exec biome check site/css site/js site/build.mjs`: passed without warnings.
- Builder output protection: an unowned nonempty output directory was refused and its sentinel file preserved; the source directory was refused. The existing `.clio-coder-site-build` marker remains in use.
- `pnpm run lint`: an earlier run passed. The final run failed outside website scope on formatting in concurrently generated, untracked `docs/wiki/meta.json`. Source warnings were also reported outside `site/`. A separate hygiene run found 59 documentation-link drift conditions under that same generated `docs/wiki/` tree. Those files were left to their owner. The full shared-repository check is therefore not reported as passing at completion.

## Browser review

Google Chrome 154.0.8037.57, headless through Playwright. Local checks used 1440, 820, and 390 pixel viewport widths in both dark and light themes.

An initial sweep covered 13 pages across six theme/width combinations. This exposed horizontal overflow on installation and lab pages; the grid items were given a bounded width and the failures were corrected. The final local sample covered 30 combinations with no WCAG A/AA accessibility violations or page overflow. All 49 documentation pages were separately loaded at 390 pixels, with no horizontal page overflow. See [local results](local-browser-results.json).

Visual review covered the homepage’s first viewport and full page, tablet stacking, mobile reading order, light and dark surfaces, installation steps, the runtime diagram, and the top and middle of long documentation pages. Tables scroll inside their own regions on narrow screens and retain readable code identifiers. Desktop documentation uses a constrained text column. Accessibility checks support these observations; they are not treated as proof of visual quality.

Production review covered the homepage, installation, labs, long configuration documentation, and a nonexistent URL across five viewport/theme combinations: desktop dark/light, mobile dark/light, and tablet dark. All 25 combinations had the expected HTTP status, no page overflow, no detected WCAG A/AA violations, and no JavaScript or CSP errors. See [production browser results](browser-results.json).

Interactive checks verified documentation search, no-result text, index-unavailable fallback, install and code copying, theme persistence, native menus, Escape dismissal and focus restoration, and legacy `docs.html?d=...` navigation. Reading the long configuration reference with JavaScript disabled produced its complete HTML article and 49 navigation links. Native disclosure controls also remain usable without JavaScript.

## Deployment and crawlability

Read the [HLab skill](https://github.com/akougkas/dotfiles) at `/home/akougkas/dotfiles/homelab/skills/hlab/SKILL.md` before infrastructure operations. Deployment used the existing `bash site/deploy-blade.sh` workflow, scoped to the `site` service in the `clio-coder-site` Compose project. The previous website image was retained locally on Blade as `clio-coder-site:before-v057-redesign`.

The container is healthy. Nginx configuration validation passed. The origin and public HTTPS homepage return 200, TLS verification succeeds, and HTTP redirects with 308 to HTTPS. A nonexistent public URL returns the new 404 page with `noindex`. The existing CSP remains unchanged and allows Cloudflare analytics.

All 58 public sitemap URLs were fetched successfully with curl. Public CSS, brand tokens, site JavaScript, social preview, and terminal WebP match local build hashes. `robots.txt` permits normal page crawling and names the public sitemap. An initial Python urllib request received an edge 403; Chrome and curl retrieved the same sitemap and pages successfully. No Cloudflare security or DNS configuration was changed.

**Actual search-engine indexing remains unverified.** An authorized Search Console user needs to check or verify the `coder.iowarp.ai` property, submit or confirm `https://coder.iowarp.ai/sitemap.xml`, inspect representative homepage and documentation URLs, and review any crawl or indexing exclusions. The successful HTTP and HTML checks establish availability and crawlable structure, not indexing.

## Synthetic performance

The latest measurements used three fresh browser contexts per profile, browser cache disabled, the public HTTPS origin, and a 2.5 second observation window after load. Cloudflare’s edge cache was not cleared; the browser process and test workstation were shared. This is a small synthetic sample, not field Core Web Vitals data or a speed guarantee.

Desktop used a 1440 × 1000 viewport with no added network or CPU throttling. Mobile used a 390 × 844 viewport, DevTools network rules configured for 4 Mbit/s download, 1 Mbit/s upload and 150 ms latency, and 4× CPU slowdown. Chrome reported the applied network rule on all 11 mobile requests and exposed the configured 150 ms connection RTT. Device behavior outside this simulation may differ.

| Profile | LCP samples | Median LCP | Observed CLS | Encoded page/resource bodies |
| --- | --- | --- | --- | --- |
| Desktop | 248, 180, 180 ms | 180 ms | 0.00029 | 168,223 bytes |
| Simulated mobile | 672, 668, 660 ms | 668 ms | 0 | 99,911 bytes |

Resource counts were 12 on desktop and 11 on mobile; the desktop viewport loaded the nearby lazy terminal image. Byte totals are the resource bodies visible to browser performance timing, not an exhaustive accounting of cross-origin analytics or HTTP overhead. The site’s compressed JavaScript bodies were 1,539 bytes in the initial production sample. See [latest raw performance samples](performance-results.json).

## Representative deployed screenshots

- [Desktop, dark](homepage-desktop-dark.png)
- [Mobile, dark](homepage-mobile-dark.png)
- [Mobile through the illustrative workflow](homepage-mobile-workflow.png)
- [Desktop, light](homepage-desktop-light.png)
- [Mobile, light](homepage-mobile-light.png)
- [Documentation, desktop](documentation-desktop.png)
- [Documentation, mobile](documentation-mobile.png)

These captures were taken from the deployed HTTPS origin. Larger full-page captures and intermediate inspection artifacts remain under `/tmp/clio-coder-redesign/` for this session.
