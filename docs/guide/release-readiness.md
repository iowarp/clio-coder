# Release preparation and publication

Package qualification, GitHub releases, npm publication, website deployment, and
wiki publication are separate operations. The commands below prepare and check
local artifacts; remote publication requires operator authorization.

## Prepare the version

Update `package.json` and `assets/acp-registry/agent.json` together. At the
release cut, date the matching `CHANGELOG.md` section and update the source-install
tag in `README.md`. While the changelog opens with `Unreleased`, keep the README
and website pinned to the latest dated stable release.

```bash
pnpm run release:readiness
```

This read-only command checks version consistency, the release-pinned product
docs, media metadata, and an isolated website build. It also checks visible
version strings in `site/*.html` against `site/product.json`.

## Qualify and publish the package

Commit the candidate and run from a clean tree:

```bash
pnpm run ci:release
pnpm run release:preflight
```

`ci:release` runs source checks, package audit, installed-package tests, and a
deterministic repack check. Its local receipt identifies the commit, Node
version, tarball SHA-256, and qualification time. `release:preflight` requires
the current source to produce those exact bytes. Changes to source, build inputs,
Node, or the artifact require a new qualification; stale receipts also require
renewal.

Publish the qualified artifact with `npm publish --access public` only after
preflight succeeds. Verify the published package and a clean installation.
Published npm versions are immutable; corrections require a new version.

Create `v<version>` at the qualified commit. Pushing the tag triggers
`.github/workflows/release.yml`, which runs CI, qualifies its package, and creates
the GitHub release from the matching changelog section. Check the tag's commit,
workflow result, release notes, and artifact. Published tags must remain fixed.
Complete package publication before making a website snapshot commit, since a
new source commit invalidates the local package receipt.

## Update the website and product docs

After the release tag exists, update `site/product.json` and the visible website
version references. Generate the product-docs snapshot from that tag:

```bash
python3 site/sync-docs.py --source-ref v<version>
python3 site/sync-docs.py --check
node site/render-cards.mjs
python3 scripts/media-assets.py --check
pnpm run release:readiness -- --release
```

The snapshot manifest records the source ref, full commit, version, and Markdown
hashes. Its inputs come from `docs/corpus.json`; generated `docs/wiki/**` pages
are excluded. Media rendering is needed when its templates, fonts, or inputs
change. The `--release` gate requires immutable release state.

Commit the website snapshot separately. Follow [the website deployment guide](../../site/README.md)
and run `bash site/deploy-blade.sh` when deployment is authorized. Check the
public version, docs provenance, search, install links, mobile layout, themes,
and link previews. Website recovery uses the previous tracked deployment source.

## Publish the generated wiki

Follow [Publishing the generated wiki to GitHub](publishing-wiki.md) to export
from the release ref into the separate wiki checkout. Review and commit the
export there before its authorized push. Wiki publication has its own commit
and deployment state; corrections use a new wiki commit.
