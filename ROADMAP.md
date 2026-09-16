# Clio Coder Roadmap

This file is the canonical agreement between the operator and the working
agent on what each release is for. Keep it short. Each milestone gets a
one-paragraph thesis and a checklist; strike items or add feedback inline and
the next session picks it up. Detailed session notes live in
`.superpowers/devlog-*.md`.

Shipped history lives in CHANGELOG.md. v0.4.0 (2026-08-31) shipped the first
panes/herdr mux, yazi companion, vendored toolchain, Workbench, dispatch queue,
typed intent, ACP terminal auth, Settings Center, and LiteLLM provider. It
shipped fast and under-tested; the 0.4.x line pays that down while finishing
the product surfaces those systems opened.

## v0.4.9 — Scientific tool quality and capability gateway

The implementation is landed on the candidate branch; the release cut is still pending. This milestone improves file I/O, scientific processing, and inspectable verification while moving secondary capabilities behind one admitted gateway. See [the individual tool audit](docs/process/tool-audit-v0.4.9.md) for contracts, limitations, and commit status.

- [x] Windowed text reads, honest encoding/identity, atomic write/edit, bounded diffs, and explicit search completeness and symlink listings.
- [x] Direct run_script with streamed logs, provenance, partial-output outcomes, bounded process-group cleanup and pipe draining, and run retention.
- [x] Read-only CSV/TSV and JSON/JSONL data inspection with precision, missing-value, and sampled/cut-view reporting.
- [x] Explicit numeric tolerance/non-finite policy, provenance, separate judgement axes, version-2 performance environments, and judged-output ceilings.
- [x] Gateway discovery and invocation with preserved authority/evidence, gateway-only artifacts, docs/library browsing, GET-only web reading, and existing command extensions.
- [x] Local stdio MCP with operator trust, CLI and slash controls, cancellation, and client-owned awaited cleanup. ORCHESTRATE and INTERACT remain direct.
- [ ] Qualify and authorize the version cut through `docs/process/release-cut-checklist.md`.

Deferred from the ranked release scope: script-to-tool calling, general OS sandboxing, remote MCP/OAuth, durable-run redesign, and hosted infrastructure. Declared script references and trusted process launch do not imply filesystem isolation; this milestone does not promise escaped-process containment or scientific validity from an exit code.

## v0.4.1 — Shipped 2026-09-01

The patch-only plan changed during the sprint. v0.4.1 is a full release: it
ships settings v2 and the canonical command grammar alongside the editor,
marketplace, and dock features, then closes the release blockers and hardening
queue found by source review and real-binary smoke tests. Detailed evidence is
in `.superpowers/devlog-v041.md` and `.superpowers/release-test-v041.md`.

- [x] Ship strict `settings.yaml` v2 with a one-time atomic v1 migration,
      backup and report, canonical-path tombstones, migrated consumers, and
      preservation of the pane settings v0.4.0 actually shipped
- [x] Ship slash-registry cleanup: seven `/settings` areas, `/resources`,
      explicit command ordering, grammar-aware autocomplete, and targeted
      refusals for retired commands
- [x] Ship the workspace `@` file picker and finish the current bang family:
      `!!` is model-private and multiline pasted sigils remain inert through
      every send path
- [x] Ship local marketplace self-promotion with catalog trigger metadata,
      scoped decline memory, offer-bound consent, auditable full-auto installs,
      and the hard own-marketplace-only source gate
- [x] Ship opt-in managed herdr docks through `interface.panes.layout`, with
      workers/watch and files/Yazi slots, crash adoption, live share reporting,
      zoom, and clean-exit reclamation
- [x] Close the original v0.4.0 bug-hunt queue: Fleet cost provenance, retired
      pane controls, embedded-mode guest fallback (`19e94bb0`; explicit
      refusal shipped in v0.4.4 #294), Workbench clock/deadline/queue
      handling, W001 cardinality fixtures, LM Studio harness isolation, dead
      demo seeds, and the live pane-notification failure-path check
- [x] Close SOL-01..07 and the TUI smoke findings: read-only doctor, trace empty
      states and validation order, configure/onboarding cancellation, fleet
      view help and plain output, Settings/prompt/autocomplete narrow layouts,
      and the interactive prose-wrap sweep
- [x] Close the settings-v2 release blockers and repeat the complete built-TUI
      matrix at `9959652c`; both upgraded v1 and empty v2 homes boot
- [x] Keep ROADMAP.md as the canonical worklist; by operator decision this
      cycle does not duplicate the queue into GitHub issues
- [x] Close the two live-demo findings before release: model-picker Use now
      reaches the session/global apply and changes the binding, while cached
      marketplace-offer evaluation measures 0.24–0.49ms on steady-state real-home
      turns without raising the 50ms soft budget

## v0.4.2 — Finish the v0.4.0 wiring

Start with the live LiteLLM gateway, then draw the next finish slice from the
preserved 0.4.x queue. Diagnose before changing either Clio or the homelab.

- [x] **First mission — LiteLLM gateway track:** test the live `blade` gateway
      and determine whether the break is Clio's LiteLLM runtime/catalog cache,
      the gateway configuration, or local settings. Fix Clio first when the
      defect is here, then advise on gateway configuration, then finish the
      selector/binding flow.
- [x] Make a LiteLLM target an honest unified catalog provider: probe
      `/v1/models` plus `/v1/model/info`, show the flat model catalog and probed
      capabilities, bind main/worker/background models through normal settings
      v2 flows, expose only reliably forwarded knobs, and keep direct
      llama.cpp/LM Studio/Ollama targets for backend-native controls.
- [ ] Settings Center seven-area redesign, kept intact from the ergonomics
      plan: slices 1–8 and 11–12 of
      `.superpowers/tui-ergonomics-spec.md`. Slice 0 (schema/migration) and
      slices 9–10 (slash registry and grammar engine) shipped in v0.4.1; the
      seven-pane workbenches, dynamic completion providers, help/docs, and
      cross-surface reconciliation did not.
- [ ] Operators `@@` / `#` / `##`: whole-file excluded glance with folding,
      task-board visibility and mutation grammar, and ephemeral excluded board
      glance as specified in `.superpowers/operators-spec.md`. The shipped
      `@`, `!`, and `!!` work is only the foundation; `^` remains v0.4.3+.
- [ ] Panes phases 5–6: opt-in embedded herdr ownership and the separately
      specified foreign-interactive-agent surface. Guest-mode managed docks
      shipped in v0.4.1; they do not complete either deferred phase.

- [ ] Workbench parity rows 2–3: sanitized ACP events for the eight named
      channels, session-native reads (branch `feat/workbench-parity`,
      unmerged; `prompts/parity-continuation.md` is stale, re-anchor first)
- [ ] Widen the event aperture past `safety.loopBlocked` (dispatch's five
      channels first, so subagent runs stop being one opaque tool card)
- [ ] ACP registry submission package: `agent.json` + icon (code half shipped)
- [ ] Typed JSON for the four upstream boundaries Workbench names
      (`evidence list`, eval discovery, project-safe `trace runs`,
      `verifiers discover`)
- [ ] Decide the legacy intent-inference fallback removal once
      `dispatchIntentAdoption()` telemetry says it's safe
- [ ] Library coherence follow-through: v0.4.1 shipped the catalog cleanup,
      trigger sweep, skills-fragment tuning, and marketplace promotion flow;
      keep auditing skills, prompts, agents, and tools, settle shipped-default
      versus marketplace-only placement, and remove remaining stale or
      duplicate units

## v0.4.3 — Repository maps through archify

Interactive system maps become a Clio capability without Clio owning a
renderer. The archify skill package is distributed index-only from its pinned
upstream tag, Clio owns one wrapper `SKILL.md`, and generated maps land under
`.clio-coder/artifacts/maps/` as human-transient artifacts.

- [x] Tier 0: `.clio-coder/artifacts/maps/` is a placement class; an
      operator-named path overrides and lands in the working tree
- [x] Tier 1: `skills/remote.yaml` remote marketplace entries. `skills:pin`
      publishes them with `origin: "remote"`, the upstream tree as
      `sourceUrl`, an `overlay` package, and an `exclude` list; install
      stages the clone, drops excluded members, lays the overlay on top,
      and swaps atomically; `skills update` re-applies the same shaping
- [x] Tier 1: the `archify` wrapper skill at `skills/planning/archify`,
      pinned to `tt-a1i/archify` v2.16.0, with Clio placement, repository
      evidence through `context map`, and `verify(check="frontend")` after
      delivery; upstream's network update check is omitted entirely

## v0.4.4 — Trust spine: typed claims, executable validation, decision provenance

One sprint, orchestrated in sibling worktrees `../clio-coder-v044*` on branch
`v044`, answering the NSF "Beyond Code" findings F.1.1, F.1.4, F.3.2, and
F.3.3 where the harness still trusted prose or sniffed files. Correctness
first; no new subsystems, wiring and deletion where possible.

- [x] Shared decision provenance types: `DecisionRecord.source/alternatives/
      rationale`, `decisionRef()`, sealed `decisionRefs` on request, envelope,
      and receipt under integrity coverage, `CommitAttributionEvidence.decisions`
- [x] Slice 1: `limitation` tool replaces the finish-contract prose regex;
      the contract is fully receipt-grounded
- [x] Slice 2: one strict `validation.yaml` loader shared by rigor, authoring,
      and doctor; rigor rises on a valid contract only, invalid is diagnosed
- [x] Slice 3: `decide` tool records agent design choices with alternatives;
      receipts and `Clio-Decision:` commit trailers cite active decisions;
      wiki, handoff, and evidence findings consume them
- [x] Slice 4: read-only `evidence` tool for the provenance agent over the
      canonical trust projection; accountability counts unverified successes
      and ungrounded claims
- [x] Slice 5: dispatch board renders from the observability projection;
      the second bus fold is deleted
- [x] Slice 6: `numeric-compare` and `perf-budget` verifier kinds with
      tolerance math in core and baselines in the catalog
- [x] Slice 7: operator tasks carry acceptance (expected outputs, named
      checks) normalised by the dispatch intent grammar and enforced by the
      finish contract under high rigor
- [ ] Issue sweep before the cut (merged into `v044`): #275, #279, #280, #281, #285, #286, #292, #293, #294, #297, #298, #300, #301, #302, #303, #304, #305, #306, #307, #308, #309, #311, #312, #313, #314, #316, #317, #318, #319, #321, #322; closed as already fixed or superseded: #276, #278, #291, #315, #323, #324; #331 pinned by smoke, not reproduced
- [x] Merged the v0.4.3 tag into `v044` (`58012f48`); full `npm run ci` passes at `f3331f82` (843 tests); the
      built-TUI smoke matrix before cut

## v0.4.5 — Codewiki architecture seed

An explicit feature item, not hardening: `clio-coder context map` derives an
archify architecture seed from the codewiki index with no model call, so a
"map this repository" turn starts from indexed evidence. The seed function and
command ship early in v0.4.3 behind the archify skill; v0.4.5 owns the
follow-through.

- [ ] Tier 2: the seed is the documented entry of the "map this repository"
      flow; the wrapper skill refines it instead of authoring from scratch,
      `--repo-root .` verifies every cited path, and the seed validates with
      zero errors on this repository under the standard profile
- [ ] Seed quality follow-through: fewer route crossings and label clearance
      warnings on dense repositories, and a fixture-repo eval for the two
      recorded archify scenarios

## Later (0.5.0 and beyond)

- Tier 3 of the archify line: archify diagrams inside the docs/html
  blueprints, and a Workbench panel that lists and opens the maps under
  `.clio-coder/artifacts/maps/`.

- Benchmark campaign (the v0.5.0 headline). Operator decision at the
  v0.4.1 diet: the eval platform (`src/domains/eval`, `clio-coder
  eval`, `skills eval`, reference suites under `evals/`) is the SINGLE
  evaluation system and ships in the product; the ten community
  adapters (11K lines, zero campaigns run) and the duplicate internal
  campaign harness are retired to branch `archive/v041-pre-diet`; no
  eval runs in CI or the release gate. The v0.5.0 campaign builds on
  the eval engine: SWE-bench and Terminal-Bench first (both want thin
  adapters in their own ecosystems; the engine already emits SWE
  JSONL), SciCode/ScienceAgentBench for the IoWarp science identity,
  each campaign with an owner and a decision threshold.
- croc transfer primitive — `prompts/transfer-croc.md`
- Windows toolchain assets (yazi/croc never executed there; herdr
  deliberately undeclared)
- Spotter — `spotter-spec.html`, design only
- Huly dashboard integration — assessed NO-GO, see `.superpowers/huly.md`
  (dead upstream cloud, 14-container stack, trademark, unstable API).
  If the itch is presentation, the alternative is a read-only issues
  pane in the Workbench over `gh --json`.

## v0.7.0 — Legacy naming compatibility removal

The two-minor compatibility window across v0.5 and v0.6 expires. Remove the
legacy naming compatibility layer, helper shims, and historical event/literal
lists.

- [ ] Retire legacy naming compatibility helpers and history lists:
      definitions in `src/core/naming-compat.ts` (`warnLegacyNaming`,
      `readNamingEnvironment`), consumer call sites in `src/cli/configure.ts`,
      `src/core/config.ts`, `src/domains/providers/model-runtime-capabilities.ts`,
      `src/domains/providers/types/knowledge-base.ts`,
      `src/domains/resources/skills/loader.ts`, and
      `src/domains/resources/skills/marketplace.ts`, and historical lists
      `LEGACY_EVENT_TYPES` and `LEGACY_HISTORY_LITERALS` in
      `src/domains/lifecycle/naming-history.ts`.

## The 0.4.x arc

Quick, frequent releases through v0.4.9: fixing, hardening, and
productizing what exists — this is the hardening era before users arrive.
v0.5.0 is the milestone release: benchmark results, performance, TUI
rendering quality, ergonomics, and compatibility with other agents,
protocols, and resources. Deferred spec work queued for the coming waves:
Settings Center seven-area redesign (slices 1–8, 11–12), operators
`@@`/`#`/`##` implementation, panes phases 5–6, Workbench parity, and the
LiteLLM gateway/provider track led by v0.4.2.

## Rules for this line

- 0.4.x releases harden, finish, and productize the directions already in
  motion; scope growth must stay explicit rather than masquerading as a patch.
- Anything deferred stays in this canonical roadmap, not only in prose.
- The release doesn't ship while a known defect is admitted in its own
  changelog.
