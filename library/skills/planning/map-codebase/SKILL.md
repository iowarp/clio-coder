---
name: map-codebase
description: "Create a clear interactive visual map of a codebase from verified structure, symbols and imports. Use for map this repository, visualize repo, codebase overview, or architecture diagram requests. Delivers a standalone HTML artifact with a readable overview and expandable source evidence."
triggers:
  - map this repository
  - map codebase
  - visualize repo
  - codebase overview
  - architecture diagram
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - bash
  - read
  - write
  - edit
  - code_nav
  - verify
  - context
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/planning/map-codebase
  audit: pass
  model-size: any
  agents:
    - main
    - architect
    - documenter
    - wiki-writer
---

# Map Codebase

Help the operator understand how this repository fits together. Deliver one
standalone HTML map, with no installation beyond Clio and this skill.

Run `clio-coder context map` in the workspace, adding `--out <requested.html>`
when the operator names a destination. It builds or refreshes the structural
index and renders the native map directly. The default destination is
`.clio-coder/artifacts/maps/<repo>.html`. `--json` returns a small artifact
receipt, not a diagram specification. No separate renderer or fallback exists.

Use `code_nav` project, entries, outline, deps and dependents to understand the
main responsibilities and important paths. Read the relevant entry points and
module documentation. The generated overview groups the code into areas;
its responsibility suggestions are explicitly inferred from names and roles.
Refine those headings and explanations with what you actually read, using
ordinary read/edit tools on the HTML. Keep source evidence intact. Explain the
main entry points, where decisions happen, and where state or output goes.
Focus on the operator's question; do not expand every import into one canvas.

Keep the overview readable, normally at most eight areas. Expandable area
sections expose files, symbols with lines, import directions, and external
packages. Add a short guided reading path when useful. Distinguish observed
imports from inferred runtime relationships. An import proves a static module
reference, not a call, control flow, or deployment boundary. Local source
locations describe the reconciled working tree; only verified clean Git
snapshots may link to immutable remote lines. Never fabricate citations or
promote dirty local lines to a committed revision.

Verify the final file with `verify(check="frontend", path="<map.html>")`.
Report actual structure, syntax and browser outcomes. A skipped or unavailable
browser is not a browser pass; browser loading is not perceptual review.
Return the artifact path, a short explanation of the major areas and their
relationships, and any evidence or language coverage limits. The map can be
opened in a browser without network access. Honor normal workspace write
permissions and the operator's requested path.
