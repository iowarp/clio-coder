# Clio Coder media assets

`assets/` is the canonical tracked home for Clio Coder brand and product media
masters. [`media-manifest.json`](media-manifest.json) records provenance,
dimensions, roles, channels, alt-text seeds, real or illustrative status,
approval, and supersession notes. Delivery copies under `site/assets/` and
`apps/clio-coder-gui/client/public/` exist because those builds have independent
roots; they are not additional masters.

## Check and synchronize delivery copies

From the repository root:

```bash
python3 scripts/media-assets.py --check
python3 scripts/media-assets.py --sync
```

`--check` is read-only. It verifies manifest hashes and dimensions, exact website
and GUI delivery copies, and all declared social-card exports. `--sync` copies
only the manifest's declared master-to-delivery mappings, then runs the same
check. Review and commit every resulting file. Do not use it to collect an
unreviewed screenshot.

When intentionally replacing a master, update its provenance and approval notes,
then run `python3 scripts/media-assets.py --record-hashes` before checking. This
command records current bytes; it does not establish that the media was reviewed
or approved.

## Render social cards

The editable card masters are `site/cards/*.html`, `site/css/cards.css`, and the
fonts and logo named in the manifest. Render every approved export with:

```bash
node site/render-cards.mjs
# If Chrome is elsewhere:
node site/render-cards.mjs --chrome /path/to/chrome
python3 scripts/media-assets.py --check
```

The renderer launches Chrome through the GUI workspace's pinned
`playwright-core`, sets 1200×630 for link cards and 1080×1080 for square cards,
waits for `document.fonts.ready`, and captures the page without resizing. It
updates source and export hashes in the manifest. `--check` catches missing
exports, wrong dimensions, changed bytes, delivery-copy drift, and template,
font, stylesheet, or logo changes that were not followed by a render.

## Real product captures

Ignored GUI smoke and visual-review screenshots are test output, not approved
product media. To create a reusable real GUI or TUI capture:

1. Use an isolated Clio home and a small reviewable demonstration repository.
   Record the Clio version or commit, interface, scenario, capture date, and
   platform. Never expose credentials, private paths, user names, or unpublished
   project data.
2. Run the scenario in the actual interface and capture the real result. Do not
   rewrite model output, passing checks, timings, cost, or quota. Usage and cost
   must retain measured, estimated, and unavailable distinctions.
3. Keep raw and one-off captures in ignored scratch space or approved object
   storage. Review the selected frame for accuracy, permissions, readability,
   and sensitive information; add a complete alt-text seed.
4. Promote only the approved, optimized master into `assets/`, add it to the
   manifest, and declare any required delivery copies. Add it to the npm package
   allowlist only when the installed product truly needs it.

The checked-in terminal session is marked real in the manifest. Social workflow
cards are marked illustrative. Neither status implies a benchmark or a general
agent-correctness claim.

## Editorial retention

`social-campaigns/` is intentionally ignored
for private drafts and upload copies. Durable release truth belongs in
`CHANGELOG.md` and GitHub release notes; evergreen copy belongs on the website;
approved reusable media belongs here or in another tracked asset location. Use
an external shared content repository when the team needs complete campaign
history. Do not force-add local campaign drafts.
