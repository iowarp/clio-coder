# Materio

Materio (materials + I/O) is Clio's curated materials research workflow. It turns a materials research question into a supplied-corpus literature synthesis,
a feasible virtual lab, an assumption-driven task plan, inspected task artifacts,
and a reviewed paper handoff. The scientific workflow derives from Daisy Quach's
research system; this package separates domain knowledge from host capabilities.

The root `plugin.json` follows Agent Plugins 1.0.0. Its six portable skills contain
the domain workflow and link to seventeen complete action guides. Clio's native
seventeen prompts, six agent recipes, and execute/verify fleet live under
`ai.iowarp.clio/` and are declared in a closed component graph. Shared references,
templates, and Python helpers live under `assets/`.

## Clio workflow

Install the whole package with `clio-coder library install ./plugins/materio --project`
from the repository, then reload plugin resources or restart the session. An
installed copy is a pinned tree; editing this source does not update that copy.

1. `/materio:identify-research` interviews domain, hypothesis,
   scope, resources, and timeline; the researcher selects a calibrated question.
2. `/materio:upload-data` indexes supplied papers/data and
   optionally copies files without overwriting collisions.
3. `/materio:literature-review` reviews supplied materials and
   authorized URLs, preserving actual inspection depth and justified gaps.
4. `/materio:define-virtual-lab` maps equipment, compute,
   licenses, collaborators, consumables, people, access constraints, and alternatives.
5. `/materio:define-research-tasks` customizes a traditional
   workflow, interviews per-task assumptions, and confirms defaults/resource gaps.
6. `/materio:execute-task N` prepares the approved task's
   output contract, reads actual artifacts, and presents advisory findings.
7. `/materio:wtfp` prepares author-reviewed new-paper,
   map-project, and create-outline briefs. Existing paper state routes to inspection
   and reuse/repair first. The bridge writes only `.research/handoff/`.

The remaining operations are `add-task`, `archive-task`, `remove-task`,
`checkpoint`, `pause-research`, `resume-research`, `settings`, `status`, `progress`,
and `help`. Task IDs remain stable across edits and archival; presentation order
and dependency order do not require renumbering existing output files.

The interactive orchestrator owns researcher questions. Workers return decision,
human-action, or human-verify checkpoints; the caller supplies the answer with
complete context on redispatch. A headless action needs already-confirmed inputs
and stops before an unanswered gated write. A generated protocol is prepared work;
physical measurements and successful computation remain separate pending actions.

The optional `materio-execute-task` fleet takes `task`,
`approval`, and `retrieval` variables. It runs the executor then the read-only
verifier. The fleet's host write boundary is `.research/tasks/`; the selected
subdirectory is also a caller instruction. The interactive action owns tighter
dispatch grants, findings, state updates, and checkpoint decisions. Peer exports
do not claim the same native fleet or write-boundary enforcement.

Clio's v4 fleet requires an existing Git worktree to validate its write boundary.
In a fresh research folder, use the execute-task prompt's direct executor dispatch
with the selected output grant followed by a separate read-only verifier dispatch.
The workflow never initializes git or disables the fleet boundary to make it run.
The verifier's read/ls checks are artifact review, not command-backed scientific
validation; any host grounding limitation or rejected receipt remains visible.

## State and checks

Python 3.10+ runs the stdlib-only helpers. Bash is used for shell syntax checking.
From a research project, initialize missing state using
`python3 /absolute/installed/package/assets/scripts/research_state.py init`.
The helper also accepts `--project /absolute/project` before its subcommand.

Config defaults are `web_search: false`, `auto_checkpoint: true`, and
`commit_research: false`. The historical `web_search` name controls provided-URL
retrieval and Crossref queries; it does not provide a search engine. Host model
selection remains in the host's configuration. Research data lives at `.research/data/`.

`research_state.py` validates JSON policy settings, allocates stable task IDs,
checks dependency graphs, copies data without collisions, and creates/restores
digest-verified checkpoint archives. Restore requires researcher confirmation,
replaces other research state exactly, and preserves data and checkpoint archives.
It creates no git repository or checkpoint tag. Optional commits require an empty
preexisting index and explicit changed filenames after `commit_research` is enabled.

`check_physics.py` checks conservative physical bounds. `check_scripts.py` parses
Python and checks shell syntax without running the generated program.
`verify_citations.py` extracts BibTeX/Key Papers entries and optionally queries
Crossref. Use `--offline` when network retrieval is disabled. All support `--json`:
exit 0 reports no findings in inspected inputs, 1 reports findings, and 2 reports
incomplete input coverage or execution failure. Missing checks are reported as
skipped. Crossref absence is inconclusive, and identity matching does not establish
full-text inspection or scientific support. Findings never delete citations or
override a researcher decision automatically.

## Peer packages

Codex can consume the root standard package through its portable skills. For a
native Claude package or Gemini extension, generate a separate output tree:

```bash
python3 assets/scripts/project_plugin.py --target claude --output /tmp/materials-claude
python3 assets/scripts/project_plugin.py --target gemini --output /tmp/materials-gemini
python3 assets/scripts/project_plugin.py --target codex --output /tmp/materials-codex
```

Claude receives six skills, seventeen native command wrappers, and six native
agents with `tools` frontmatter. Workers have no interview tool. Gemini receives
six skills and seventeen TOML commands; roles use available delegation or execute
in the main conversation. Codex receives a standard root manifest, six skills,
and the complete action guides. Every export includes `capability-report.json`
describing translated and omitted runtime behavior. These are installable content
projections; generated structure and manifest validation do not establish a live
model run on every host. No target auto-installs MCP servers or dependencies.

The standard package uses action requests such as “Run identify-research using the
materio-research-explorer skill.” It does not register Codex
slash commands or named agents. Native peer exports translate action routes to
their actual commands; Claude also binds roles to registered names such as
`materio:research-explorer`. Paper briefs name receiving wtf-p
actions and ask the researcher to use the invocation exposed by that adapter.
Next-task routing selects an actual dependency-ready task in workflow order;
gaps, archives, and reordered task IDs never imply incrementing the previous ID.

## Validation and provenance

Run the plugin's deterministic Python suite with:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s plugins/materio/tests -v
pnpm run test:file tests/contracts/materials-plugin.test.ts
```

The Python suite includes the upstream conservative checker regressions, balanced
BibTeX extraction, DOI-provider uncertainty, missing-file coverage, stable task
IDs, dependency failures, archive integrity/containment, data collision handling,
git-index preservation, and all three peer exports. Python 3.11+ is needed for the
test that parses generated Gemini TOML using `tomllib`.

Original domain content: Daisy Quach, with validation work by Matthew Larson,
from `iowarp/wtf-ms`. Extraction refs are recorded in
`ai.iowarp.portability/provenance.json`. No upstream licensing claim is inferred;
this package retains attribution metadata and does not invent an SPDX license.
