# Clio Coder website

The public product website at **https://coder.iowarp.ai/** is a static Node build served by Nginx. Product pages and all 49 documentation pages contain readable HTML before JavaScript runs. JavaScript enhances theme switching, menus, copying, documentation search, and legacy query links.

```bash
node site/build.mjs
python3 site/check.py
pnpm run lint
python3 -m http.server 4173 --bind 127.0.0.1 --directory site/public
```

Open http://127.0.0.1:4173/. Preview the generated output, not the source directory. The builder derives shared navigation and footer markup from `index.html`, renders the documentation snapshot through `docs.html`, and generates canonical URLs, structured data, the sitemap, and search metadata. `product.json` supplies the public version, origin, and repository identity.

`site/public/` is generated and ignored by Git. A custom output directory must be empty or carry this builder’s `.clio-coder-site-build` ownership marker. The builder refuses source replacement and nonempty directories it does not own. Never point it at the repository’s root `dist/`.

## Design and content

`css/brand.css` defines self-hosted IBM Plex Sans and Mono fonts and the shared semantic color roles: cyan interaction, sage success, amber action/warning, brick failure, warm-paper light surfaces, black dark surfaces, and code wells that remain dark. `css/site.css` owns website layout and components. The website does not edit or implement the GUI.

The homepage workflow is explicitly illustrative. `assets/session.png` is the original terminal capture from the repository; `assets/session.webp` is a smaller derivative for inline display and links to the original. Do not substitute invented run outcomes or performance claims.

Documentation snapshots are under `content/docs/`. Refresh them deliberately with `python3 site/sync-docs.py`; the installed package remains the authority for its own version. The written labs in `learn.html` remain useful without recordings. Add a supplied YouTube ID to `content/recordings.json`; the builder renders only valid, published recordings and omits empty entries.

## Social previews

The templates in `cards/` use the same fonts, palette, and hierarchy as the website. Regenerate the four PNG assets with browser screenshots after changing their templates or typography. Render `link.html` and `link-light.html` at 1200 × 630, and `square.html` and `square-light.html` at 1080 × 1080. Wait for `document.fonts.ready` before capture. `share.html` links to the exported images.

## Production

Read the HLab skill at `/home/akougkas/dotfiles/homelab/skills/hlab/SKILL.md` before infrastructure work. The existing route is Cloudflare → Blade Tunnel → Traefik → the website container. DNS, tunnel routing, and unrelated services are outside this deployment.

```bash
bash site/deploy-blade.sh
```

This builds and checks an isolated output, synchronizes only the website source to Blade, builds and replaces the `site` service in the `clio-coder-site` Compose project, validates Nginx, and checks the origin response. Inspect the HTTPS website afterward, including mobile layouts, both themes, documentation, search, menus, copy controls, a missing URL, and reading without JavaScript. CSP permits the existing Cloudflare analytics injection.

The sitemap and robots file preserve crawlability. Actual search-engine indexing requires checking the relevant Search Console property and is not established by a successful site build or deployment.
