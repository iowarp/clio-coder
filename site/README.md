# Clio Coder website

The public website at **https://coder.iowarp.ai/** is a static Node build served
by Nginx. Product pages and documentation are readable HTML; JavaScript adds
themes, menus, copy controls, search, and legacy query links.

## Build and preview

```bash
python3 site/sync-docs.py --check
clio_site_preview=$(mktemp -d)
node site/build.mjs --out "$clio_site_preview/public"
python3 site/check.py "$clio_site_preview/public"
python3 -m http.server 4173 --bind 127.0.0.1 --directory "$clio_site_preview/public"
```

Open http://127.0.0.1:4173/. The builder shares navigation and footer markup,
renders documentation, and generates canonical URLs, structured data, search
metadata, and the sitemap. Output is generated; use an empty directory or one
carrying the builder's ownership marker. Remove the preview directory afterward.

## Content and media

`product.json` supplies version, origin, and repository identity. Product pages
use self-hosted IBM Plex Sans and Mono, semantic colors in `css/brand.css`, and
layout rules in `css/site.css`. Canonical image masters live in root `assets/`;
`assets/media-manifest.json` maps their website copies. The homepage uses the
terminal and browser captures; card templates remain in `cards/`.

```bash
python3 scripts/media-assets.py --sync
python3 scripts/media-assets.py --check
node site/render-cards.mjs
```

## Documentation snapshot

`content/docs/` contains the authored product corpus declared in
`docs/corpus.json`. The snapshot manifest records the release ref, source commit,
and file hashes. The independent generated development Wiki is published
separately. After creating the matching release tag:

```bash
clio_release_version=$(node -p 'require("./package.json").version')
python3 site/sync-docs.py --source-ref "v${clio_release_version}"
python3 site/sync-docs.py --check
pnpm run release:readiness -- --release
```

Documentation source links resolve to that release. Learning labs are written
workflows; `content/recordings.json` supplies optional published video IDs.

## Deployment

The existing route is Cloudflare → Blade Tunnel → Traefik → the site container.
For infrastructure operations, read the local HLab skill at
`/home/akougkas/dotfiles/homelab/skills/hlab/SKILL.md`.

```bash
bash site/deploy-blade.sh
```

The script builds and checks the site, synchronizes its source to Blade, updates
only the `clio-coder-site` Compose service, and validates Nginx and the origin
response. Check the HTTPS pages, mobile layout, themes, documentation, search,
and install links after deployment. DNS and tunnel configuration are managed
separately.
