# Release readiness and publication runbook

This maintainer runbook coordinates package, GitHub, npm, website, product
documentation, generated Wiki, and communication checkpoints. It does not turn
them into one remote-writing command. Every publication or deployment remains a
separate, human-approved boundary.

Use `pnpm run release:readiness` throughout preparation. It is read-only: it
checks version state, the release-pinned docs snapshot, approved media, and an
isolated website build. `pnpm run release:readiness -- --release` additionally
requires immutable release state. Neither form publishes, tags, deploys, pushes,
or changes operator services.

## 1. Establish package and release truth

1. Confirm the intended version and release commit. An `Unreleased` heading is
   not a shipped release.
2. Update `package.json` and `assets/acp-registry/agent.json` together. Retitle
   the top changelog section as `## <version> - YYYY-MM-DD`, preserving release
   chronology in `CHANGELOG.md` rather than evergreen guides.
3. Update the source-install tag in `README.md`. The README pin remains on the
   latest dated stable release while the changelog still opens with
   `Unreleased`.
4. Review every release-note claim against source and focused behavioral
   coverage. Distinguish new core behavior, new access to an existing runtime
   capability, alpha UI, and measured observations. Usage and cost wording must
   preserve measured, estimated, and unavailable states.
5. Run `pnpm run release:readiness`. Before the cut, the website and public docs
   should still identify the latest stable release; they must not silently
   publish candidate prose.

The readiness command also checks every visible semantic-version literal in
`site/*.html`. A copied version string cannot drift from `site/product.json`
without failing the check.

## 2. Qualify the exact package and stop changing it

Commit the candidate with an explicit conventional commit, then start from a
clean tree:

```bash
pnpm run ci:release
pnpm run release:preflight
```

`ci:release` runs the full source gate, package audit, installed-package tests,
and deterministic repack check. It records the exact commit, Node version,
tarball SHA-256, and qualification time in the private qualification cache.
`release:preflight` proves the current source still packs to those exact bytes.
It is not a second qualification.

Any source change, rebuild input change, Node change, stale receipt, or tarball
change voids the local publication preflight. Recommit and rerun
`pnpm run ci:release`; do not patch or repack a qualified artifact. Record the
qualified commit, Node version, tarball path, SHA-256, and receipt time.

**npm boundary.** `npm publish --access public` is a remote write and is never
part of readiness or qualification. Run it only after explicit human approval,
from the unchanged qualified commit, and only after `release:preflight` passes.
The package version is immutable once accepted by npm. Verify the public package
page and a clean install, then record the npm URL, version, and publication time.

## 3. Create the immutable tag and GitHub release

Create `v<version>` only at the qualified commit. Do not move or replace a
published tag. Pushing that tag is a remote write requiring explicit approval;
it triggers `.github/workflows/release.yml`, which reruns CI, qualifies its exact
package artifact, and creates the GitHub release from the matching changelog
section.

Before proceeding:

- verify the tag resolves to the qualified commit;
- verify hosted CI and package qualification succeeded;
- inspect the GitHub release title, notes, artifact, and links;
- record the tag object/commit, workflow URL, release URL, artifact digest, and
  approval identity.

If npm publication follows the tag, return to the npm boundary above while the
checkout still points at the unchanged qualified commit. Do not make the website
snapshot commit first because that would invalidate the local package receipt.

## 4. Advance the release-pinned website and product docs

The website deploys separately from npm. After the release tag exists:

1. Set `site/product.json` and every visible website version reference to the
   released version.
2. Refresh only from that tag:

   ```bash
   python3 site/sync-docs.py --source-ref v<version>
   python3 site/sync-docs.py --check
   ```

   The snapshot manifest records the release version, source ref, full source
   commit, and every Markdown hash. The product corpus comes from
   `docs/corpus.json`; generated `docs/wiki/**` pages are forbidden.
3. Render and check approved media when templates, fonts, or inputs changed:

   ```bash
   node site/render-cards.mjs
   python3 scripts/media-assets.py --check
   ```

4. Run the immutable-state gate and review its isolated site output:

   ```bash
   pnpm run release:readiness -- --release
   ```

5. Commit the website/docs snapshot as a post-release source commit. This commit
   does not change the already-qualified npm artifact.
6. Deployment remains manual and remote. After explicit infrastructure approval,
   follow `site/README.md` and run `bash site/deploy-blade.sh`. Never install or
   replace a system service as part of a local check.
7. Inspect the public HTTPS site on desktop and mobile, both themes, docs source
   provenance, search, install links, a missing URL, no-JavaScript reading, and
   social unfurls. Record the deployment source commit, time, operator, live
   version, docs manifest digest, and verification URLs.

## 5. Export and publish the generated development Wiki

`docs/wiki/` is generated development reference, not product guidance. Do not
hand-edit or regenerate it as a side effect of website work. Follow
[Publishing the generated wiki to GitHub](publishing-wiki.md): export the
reviewed pages into the separate `clio-coder.wiki.git` checkout using the
published release ref, inspect additions, removals, rewritten links, Home,
sidebar, and footer, then commit there.

The Wiki push is a distinct remote write requiring approval. Record the source
commit/ref, exporter invocation, Wiki commit, reviewer, push time, and checked
public pages. Source and Wiki commits are not atomic; never describe an
unpublished export as live.

## 6. Approve communications and reusable media

Private drafts and upload copies may remain in ignored `social-campaigns/`, but
that directory is not a durable team archive. Before publication:

- verify package, GitHub release, npm, website, docs provenance, and intended
  links are live;
- recheck consequential claims against the tagged source and release notes;
- distinguish existing strengths from release additions and browser access from
  new core capability;
- label the GUI alpha, illustrative cards, and real product captures honestly;
- omit broad correctness, safety, sandbox, performance, or productivity claims
  that the evidence does not establish;
- check image dimensions, source/export hashes, alt text, mobile readability,
  and link-preview cache behavior.

Durable release truth belongs in `CHANGELOG.md` and GitHub release notes.
Evergreen approved copy belongs on the website/share page. Reusable approved
media belongs in tracked assets and `assets/media-manifest.json`. If the team
needs complete campaign history, use an external shared content repository.
Never force-add the ignored draft workspace.

Publish each channel only after explicit approval. Record owner, exact final
copy or durable source, asset ID/hash, URL, and publication time. Recheck public
links and unfurls after posting.

## 7. Rollback, correction, and evidence

Publication is intentionally split so each surface has an explicit recovery
path:

- **npm:** published versions are immutable. Deprecate a bad version if needed
  and prepare a corrected patch; never replace package bytes.
- **Git/tag/release:** do not move a published tag. Correct release notes or ship
  a follow-up version according to impact, preserving the original evidence.
- **Website:** redeploy the last known-good tracked website source, then diagnose
  the failed source offline. Record both deployment commits and times.
- **GitHub Wiki:** revert or correct the separate Wiki commit and push only after
  review.
- **Social:** correct or withdraw inaccurate copy using the channel's controls,
  link the durable correction, and record what changed.

Close the release record with: version and tag commit; qualification receipt and
artifact SHA-256; hosted workflow and GitHub release URLs; npm URL and clean
install result; website deployment commit/time and live checks; docs source ref,
commit, manifest hash, and page count; Wiki commit and verification URLs; social
post URLs, asset IDs, hashes, alt text, and approvals; known platform limits;
and every rollback or correction. A passing command records its stated boundary
only. It does not establish scientific validity or general model correctness.
