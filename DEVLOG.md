# Developer Log

This file preserves the detailed release and development history for Clio
Coder. For public-facing release notes, see [CHANGELOG.md](CHANGELOG.md).
Versions follow semantic versioning for a pre-1.0 project: minor versions may
change interfaces.

## 0.3.0 - hardening session 9: the lifecycle a stranger walks

Sessions 1 through 8 hardened what Clio does. This one covers obtaining it,
configuring it, learning it, operating it, repairing it, and removing it. The
bar was that a stranger should be able to install Clio, understand it, trust
it, recover it, and remove it without the person who wrote the code in the
room, and the method was to run the packaged tarball rather than the checkout
and to write down what actually happened.

### The first screen was the one that handled width worst

`clio configure --list` and the first-run runtime menu wrote fixed-width rows
sized for roughly 88 columns. At 80, which is the oldest default there is, the
model hints ran to 141 columns and the terminal wrapped them into fragments
that lined up with no header; a label longer than its 20-wide column pushed
every later column right. The surface a new user meets first was the one that
degraded worst.

The rows now measure the terminal. `--list` keeps one aligned row per runtime
while every column fits and restacks into a two-line form below that, carrying
identity and auth state on the first line and the display name and hints
indented on the second. Narrowing costs vertical space, never information: 51
lines at 80 columns against 30 at 100, and nothing dropped in either. The
category menu and the answers its parser accepts now come from one list, so a
printed choice can no longer advertise a spelling the parser rejects.

Wiring that up exposed a bug in the wrapper itself. `wrapPlain` counted the
hanging indent against the budget the next word was measured against, so every
continuation line came out shorter than the one before it and a four-word tail
wrapped four times. Visible at 100 columns as an "Inception)" alone on a line
with 60 columns of room beside it.

### One quantity, one word

The chat panel and the `/cost` overlay report the same numbers about the same
session and named them differently. The panel says `turn · in 9650 over 65
calls`; the overlay called that count `requests`. Worse, the panel marks an
estimated reasoning total `≈900 estimated` and the overlay printed a bare
number, and the mismatch is not cosmetic: the cost tally sums only what
providers report and never estimates, while the panel falls back to estimating
from the reasoning text it displayed. On a model that reports nothing, a footer
reading `r≈900` sat beside an overlay reading `reasoning 0` with nothing to say
why. Teaching the cost path to estimate was the other option and was rejected,
because those numbers reach receipts and the trace store. The overlay row says
`provider-reported only`, which is true of that tally and is the difference the
user is looking at.

Five surfaces answered "what is Clio talking to" five ways when the answer was
nothing: `not configured/not configured` in the banner, because it substituted
the same phrase into both halves and joined them with a slash; `no model` in
the editor rail; `none · none` in the footer; `(unset)` and `(no model)` in two
overlays. `formatTargetLabel` owns that now for the three status surfaces. A
target with no model and a model with no target stay distinct, because
collapsing them loses which half to fix.

### Terminal behavior had never been tested on a terminal

Piping stdout reports no width, so every width-sensitive path collapsed to the
80-column fallback and the interesting sizes were never exercised. The TUI
additionally refuses to start without a TTY, which left raw mode, the cursor,
bracketed paste, and SIGINT covered by hand and nothing else. `node-pty` had
been a devDependency used by nothing.

`tests/smoke/tui-width-matrix.test.ts` runs the built entry through a real
pseudo-terminal at 40x12, 60x20, 80x24, 100x30, 120x40, 160x50, and 400
columns. Degradation at 40 is intentional and now observed: the box frame
drops, the experimental warning shortens to "May break or change.", and the
footer collapses to two fields. Teardown is checked as a balance rather than a
smoke test. Clio renders inline and never takes the alternate screen, so what
must balance is the cursor, bracketed paste, and the kitty keyboard-protocol
stack. Holding the input schedule until the frame appears instead of sleeping
long enough for the slowest machine took the suite from 98 seconds to 33.

The frame-cost bound at 160x50 reads `CLIO_RENDER_TRACE` over forty
keystrokes: 9753 bytes for the widest frame and 0.03ms panel-render p95, held
to 24000 and 5ms so a lost render diff fails while a loaded CI box does not.
The byte figures were identical across four runs. The trace is asserted to
contain none of the typed text, which is what lets it be documented as safe to
share.

### Two defects the matrix found that reading the code did not

`scripts/lifecycle-matrix.mjs` runs the twenty required cases against a real
`npm pack` installed into a throwaway prefix. Nineteen passed on the second
run. The two that did not were real.

`clio uninstall --remove-binary --force` printed `binary remove <path>
(dangling; that installation is already gone)`, exited 0, and left the link on
PATH. `rmSync(path, { force: true })` stats through a symlink; on a dangling
one it gets ENOENT and `force: true` treats that as already-gone. The
regression that was supposed to cover this asserted `existsSync(link) ===
false`, which is true of a dangling link whether or not it was removed. The
test asked the same wrong question the code did, which is how a defect ships
under a passing suite.

`clio trace --help` wrote `unknown trace flag: --help` to stderr and exited 2
while every other subcommand answered on stdout with 0. The one thing a lost
user reliably types was the one thing that looked broken.

Three of the harness's own checks were wrong before the code was, and saying so
is the point: the tar listing went through the output clip and measured a
198-file package as 118; the settings-loader assertion required the message not
to mention `doctor --fix`, which it mentions on purpose to say what that command
does not do; and a documented example naming a target the reader was told to
create cannot exit 0 on a fresh install, so what is held is that it parses.

### Claims that rot are now claims that fail

Three documents assert completeness, and completeness maintained by review does
not survive contact with a second contributor.
`docs/environment-variables.md` claimed to list every variable `src/` reads and
omitted five, one of which writes conversation text to disk.
`docs/configuration-and-targets.md` had no per-key inventory at all; writing one
turned up two keys with no row. Both now have a contract test that reads the
source of truth and fails naming what is missing. Against the previous revision
of the environment page, the check names exactly the five that were absent.

`CLIO_MEMORY_TRACE` records up to 8000 characters of the text each memory step
saw. It is content-bearing by construction, and its row says so rather than
leaving the reader to find out from the file. Both trace variables name a path
rather than taking `1`, and they sat beside seven toggles that do take `1`, so
they have their own table stating the exception.

### The divergence sweep found nothing, which is worth recording

Session 8 fixed `memory.intervention.timeoutMs`, where a settings default of
180000 sat beside a policy fallback of 20000 and survived by being unreachable
in normal runs. Scanning every settings access paired with a literal fallback
across `src/` found no second instance. The hits it did produce were all
null-to-display substitutions, which is how the five spellings of "not
configured" surfaced.

### Measured

`npm run ci` green under Node 22.22.3 and Node 24.9.0. The lifecycle matrix
runs 20 of 20 cases, 121 checks, against the packaged tarball. Case 9's live
turn ran on `dynamo` against `Nemo-3.5-Lightning`, the only model resident
there; `/v1/models` was recorded before and after and the loaded set is
identical, so nothing was loaded or unloaded to make a test pass.

## 0.3.0 - hardening session 8: the loop's cost, three proofs, and the release cut

The gap session 7 reported rather than hid, the proof tasks it deferred, and
the version bump. Codex ran this session; the launch that session 7's command
policy refused now works, and it produced the H1 design recommendation.

### A loop's cost was sealed and never read

`clio-soak-loop.yaml` passed with `tokens.measured: false`. That was the
contract working: `clio fleet run --json` drains its workers' events and
publishes step receipts plus one summary, so no `message_end` ever crosses the
runner's stdout and the token fold correctly saw nothing. The suite gated a
bounded loop's bound while being blind to what the loop cost.

The information was sealed all along, in the `tokenCount` and `costUsd` of
receipts the suite already reads for `receipt.*`. The question was not
plumbing, it was governance: a sealed receipt is an observation too, and an
authenticated one, but merging it into `tokens.*` would make
`tokens.measured: true` mean two different things depending on which surface
ran.

`receiptUsage.*` is the answer, and Codex and Claude reached it independently.
It carries its own name and its own provenance, never merges with `tokens.*`,
and never enters `summary.tokens`. It is authenticated rather than watched, so
it reports `measured: false` and no counts whenever the receipt set is
incomplete or any receipt fails `verifyReceiptIntegrity`: a partial sum
under-reports a cost while looking exactly like a complete one.

Candidate 2, forwarding worker usage onto fleet stdout so the existing fold
sees it, was rejected with evidence rather than by preference. The fleet path
publishes no worker events at all, so it was a wire-contract expansion taking
on ordering, volume, and compatibility obligations unrelated to accounting,
against a projection whose whole promise is that content crosses once.

Recorded because it is the thing someone will want to undo: the two families
must never be reconciled or presented as interchangeable. `receiptUsage` has
weaker epistemic provenance than the live stream and is not a fallback for it.

### The suite failed for the one reason it exists to never fail for

The first live run failed, and the failure was the suite's, not Clio's. The
repair worker tripped a loop guard, so the scheduler typed the ending
`loop_step_failed` after one verification and one repair. Clio kept every
promise: it detected the spin, killed the worker, sealed an authenticated
recovery receipt, stopped the plan as `onFailure: stop` declares, and named the
ending with the reason that distinguishes "a step broke" from "the bound is
spent". The suite asserted `loop.reasonExhausted`, which is true only for the
two endings that reach the bound, so a model's worker failure read as Clio
breaking.

`loop.reasonDeclared` is the promise that holds across all four endings, and it
catches strictly more than the old assertion did on the endings both can see: a
loop claiming resolved beside a reason saying it never converged, and a summary
naming a reason the scheduler does not type. `loop.reasonExhausted` keeps its
meaning and stays collected. This is not a weakened gate, and a future reader
should not restore the old assertion: it was a false positive that would fail
the suite whenever a local model spins.

### Three proofs passed, one item closed, one dropped

- **P1, directory fsync.** The proof was cheaper than expected: `engine/session.ts`
  already imports `safeResourceWrite` from the module holding the other copy, so
  the shared owner points along an edge that exists rather than opening one.
  Bodies are textually identical once the parameter name is normalized. The
  surviving comment states the rule both copies were half-stating.
- **P2, POSIX shell quoting.** The proof needed was that three different
  consumers want the same semantics and always will, and they do for a reason
  independent of them: all three build a string a POSIX shell parses, where the
  escaping is fixed by the grammar. Exercised for real rather than by
  inspection, including a live ssh to localhost through the actual transport
  path carrying a label containing a single quote. The shared owner documents
  the shape dependency the copies did not: `fleet-preflight` slices the outer
  quotes off, so a bare word for safe input would break it silently.
- **P3, auth storage shapes.** The language service reports two rename
  locations each, all inside the file. The challenge's proposed
  `AuthStorageV1Shape` was **not** adopted: it buries the version mid-name
  against the repository's trailing-suffix convention. `AuthStorageShapeV1` is
  consistent with `AuthStorageData` beside it. The persisted discriminator is
  untouched, exercised with V1, version-less V1, and V2 files.
- **S4, barrel imports: closed, not deferred a third time.** Measured 179
  cross-domain subpath imports against 28 barrel imports, and all five enforced
  boundary rules constrain dependency direction rather than import form. Direct
  subpath imports are the repository's convention. A barrel-only sixth rule
  would widen many barrels, each a public-surface addition justified by nothing
  but style. This is a decision; do not reopen it as a deferral.
- **P4, redundant exports: dropped.** Optional and first to drop by the
  session's own terms. The ~4,000-row inventory is not evidence and was not
  used.
- **P5** produced an architecture proof under `.superpowers/audits/phase2/`
  rather than a move. The finding that matters: the invariants in `dispatch`
  cross the seams a responsibility-labelled split would use. Write-boundary
  attribution and loop unrolling are both properties of a scheduling *wave*,
  computed by the plan compiler and enforced by the scheduler, so splitting
  those two puts the halves of one invariant on opposite sides of a boundary.
  A future split should be argued from the wave contract outward.

### The release cut

`package.json` now reports 0.3.0. Nothing in the source hardcodes a version, so
the bump is mechanical in code; prose was audited claim by claim instead of
swept, and "in v0.2.9" statements are history that stayed. The benchmark
README's pinned tarball filename was the one genuinely wrong number, and it now
reads the name `npm pack` prints so it cannot rot again.

Auditing the README found a real gap: `clio trace` shipped in 0.2.9 and was
documented nowhere under `docs/`. It is now in the command reference.

Left deliberately, and recorded so it is not mistaken for an oversight: the
`docs/html/**` blueprints still say v0.2.9, roughly ninety badges across thirty
files. They are versioned design documents, and advancing the number without
re-reviewing what they assert would claim an alignment nobody checked.

### Measured

Full CI green at 2602 + 4 tests, up from session 7's 2592 by the ten new
fail-closed tests. All four soak suites live and offline against `mini`: clean
5/5 with 242,930 measured tokens, chaos 1/1, boundary 2/2, loop 1/1 now
reporting `receiptUsage.totalTokens` beside a correctly-false
`tokens.measured`. Five-command baseline 5/5. The packed tarball was installed
into a clean directory and run against `mini`; it ships no benchmark fixtures
or test scaffolding and carries every runtime asset. `clio doctor` correctly
reports the state metadata as stale after the bump and `--fix` migrates it,
verified in an isolated state directory.

## Unreleased - v0.3.0 hardening session 7: cleanup, consolidation, and the rest of the soak

A pre-release pass over accumulated evidence. Phase 1's six inventories were
raw candidate generators; a Codex evidence challenge had already rejected 48 of
83 sampled claims. This session converted only the surviving evidence into
work, and recorded what it deliberately did not do.

### An undiscovered context window was a guess wearing a capability's clothes

A llama-swap-style router answers `/props` with `n_ctx: 0` and publishes the
real window in its `/v1/models` row. `probeOpenAIModelCatalog` had parsed that
row all along and `capabilitiesFor` never read it, so the merged capability
fell back to the llamacpp descriptor's 8192 placeholder and `clio targets`
rendered it exactly like a discovered 262144.

The cause was two owners for one question. `capabilitiesFor` had its own
selected-model rule while `probeCapabilitiesForModel` was the exact-id selector
everything else used, and they disagreed, which is why `clio targets` and
runtime resolution could report different windows for the same target. There is
now one owner. Reading the merged probe view rather than the raw one also means
a transient outage no longer shrinks a window Clio had already observed.

What nothing declared is now named. `TargetStatus.contextWindowProvenance`
distinguishes configured, discovered, catalog, and runtime-default; the guess
renders as an unverified runtime default; and `configure` warns as it writes.
No free-text `ctx:262k` parsing was invented: guessing at a router's prose
description would replace one fabrication with another.

Verified live against a stub router with `n_ctx: 0` and a `/v1/models`
`context_length` of 262144, in an isolated `CLIO_HOME`: `ctx 262144`,
provenance `discovered`. Without the row, `ctx 8192 (unverified runtime
default)`.

### The SWE-bench adapter reported the largest number it saw

`tokens_from_events` took a maximum over every event carrying a usage block, so
the republished `agent_end` summary competed with the completed messages and a
turn's segments never summed. Two messages of 700 and 300 reported 700, and an
`agent_end` claiming 999999 reported that. Receipt lookup hardcoded
`~/.local/state/clio/receipts`, so an isolated run read a different Clio's
receipts. It now folds through `clio_usage` like HumanEval and SciCode, and
`--instances-file` makes its wiring exercisable offline, which is what lets the
existing accounting contract test drive it rather than fork.

Terminal-bench was audited and closed with evidence rather than code. It hands
the harness a `TerminalCommand` executed inside the task container, so no
stream exists for it to observe and no parent eval reads its stdout. A zero
there would report thrift nobody measured.

### Soak items 4 to 6

The soak now has three suites, because they gate different things.

`clio-soak-boundary.yaml` runs no model at all. A registry command writes
outside its step's declared `writes`, deterministically, on every run. The
promise gated is not that nothing escaped the allowlist, because enforcement is
detect-and-rollback and never sandboxing; it is that Clio saw what did, named
it, restored what git could restore, and sealed a verdict carrying its digest
and baseline commit. Both endings are covered, including the honest one: a path
left dirty before the snapshot has its prior bytes nowhere but the tree the
step overwrote, so the verdict is `rollback-incomplete`, the tree is left
exactly as the step made it, and the reason is recorded. 2/2 offline in under
two seconds.

`clio-soak-loop.yaml` gates a bounded loop's bound and nothing about the model.
`loop.resolved` is collected and never asserted, so a model that spends every
attempt passes; what fails is exceeding the bound, an unresolved loop reporting
anything other than `loop_bound_exhausted`, or repairs that do not match the
recovery receipts they sealed. Live 1/1: the local model repaired on its first
attempt, so the loop spent two verifications and one repair, sealed one
recovery receipt, and left its two later nodes `unneeded` rather than skipped.

`multi-file-bug` joins the main suite on both surfaces. Its defect is split
across two modules with a correct third composing them, so a repair that reads
only the file the failure names cannot make it green. Live 5/5: both new items
changed exactly two files and modified no test.

One honest gap found and reported rather than papered over: the loop suite's
`tokens.measured` is false, because a fleet worker's events do not cross the
external command's stdout. The suite cannot yet see what a loop cost, and says
so instead of printing a zero.

### Consolidation, and what was left alone

`metadataNumber` and the tools layer's `toPosixPath` each had identical copies
and now have one owner apiece. Neither was a line-count exercise: both encode a
rule that matters and had two places to drift from.

Barrel-import normalization was seeded as safe and was not done. The agents
barrel does not export `AgentAutomationAuthority`, so `execution-plan.ts` could
only be made half-consistent without widening a barrel, and the repository
enforces five specific boundary rules, none of which is "always import through
the barrel". It is recorded as a proof task rather than half-built.

### Deviation

The prompt directed one Codex tmux session started with
`--dangerously-bypass-approvals-and-sandbox`. That launch was refused by the
environment's command policy and was not worked around. Every item here was
implemented and reviewed by Claude alone, including the bounded design
recommendation the prompt assigned to Codex.

## Unreleased - v0.3.0 hardening session 6: the soak, or measuring Clio instead of the model

Every benchmark Clio runs measures the model and only incidentally touches
Clio. None of them fail when Clio breaks its own promises: a run whose receipt
never sealed, whose seal does not authenticate, or whose stream republishes its
own transcript scores exactly as well as a clean one, provided the model got
the answer right. This session built the inverse and ran it.

### The suite

`benchmarks/soak/clio-soak.yaml` runs one seeded defect through the two
surfaces that execute work, the headless main agent and a dispatched worker,
and gates on the machinery. A weak model that never repairs the fixture passes;
a strong model that repairs it fails the moment an invariant breaks. It is a
suite v2 file on the existing `clio eval run --suite` machinery, with no new
command and no new domain.

Three readings stay in three layers and never merge:

| layer | carries | fails the item? |
| --- | --- | --- |
| `verify.measure` | the task outcome (`task.solved`) | never |
| `verify.assertions` | invariants only this surface can answer | yes |
| `thresholds.fail` | invariants every surface answers | gates the suite |

### The metrics

`src/domains/eval/metrics/invariants.ts` reads the promises. Receipt
invariants come from the item's own journal, stream invariants are folded live
off the runner's stdout, and `process.orphanedChildren` reads the pid and
process group off a receipt's attestation rather than walking a process tree.
Absence is never zero and never success: a metric the pass could not compute is
absent, and a threshold on an absent metric fails closed. Every one of them has
a test proving it fails on a corrupted artifact, because a check that cannot
fail is decoration.

Making the readings possible needed three changes to the eval machinery:

- Every eval item now spawns its runner with its own `CLIO_STATE_DIR`. An item
  measures Clio, and a shared state directory mixes sibling processes' runs and
  yesterday's sessions into the reading.
- `workspace.setup` seeds the prepared workspace before the runner, so a
  fixture can pin the baseline commit that the patch metrics and write-boundary
  enforcement measure against.
- `verify.measure` records a task outcome without gating on it. `verify.commands`
  could not express this: a failing verifier fails the item, which is exactly
  how "the model did not solve it" gets reported as "Clio broke".

### Two defects the first runs found

A suite's `thresholds.fail` was parsed, validated, and then decided nothing.
Only a later `eval gate` invocation read it, so the run that broke a declared
threshold still exited zero. `eval run --suite` now evaluates the suite's own
thresholds against the artifact it just wrote, and a gate reaches per-run
metrics so the failure names the run rather than an aggregate.

Separately, a task assertion resolved against a missing metric was passing.
`neq` was the clearest case: an absent metric is not equal to anything, so a
run that measured nothing reported compliance with a check that never ran.

### One Clio defect the soak found

`clio run --agent … --json` forwarded worker events verbatim, so `agent_end`
carried every message of the segment a second time. Each had already crossed
the wire as its own `message_end`. Measured on a two-minute run against the
local KAT-Coder target: 24 KB of `agent_end` republishing the 19 KB of
`message_end` that preceded it, and the ratio grows with the answer. The
main-agent projection had replaced exactly this with a segment summary in
session 4; the dispatch surface never got it. Both wire projections now live in
`json-stream.ts`.

The first version of the stream invariant over-reached: it counted every
`message_update` as a violation, which is true of the main-agent stream and
false of the dispatch stream, where a worker publishes its increments under
that name already slimmed of cumulative snapshots at the worker stdout seam.
The check was corrected to the promise both surfaces actually make, that no
event republishes a growing partial message or a segment's transcript, which is
strictly stronger on the main-agent surface than what it replaced.

### Measured

Verified live and offline against the local `mini` target (KAT-Coder,
llama.cpp). Both surfaces repaired the fixture, and both sealed one root
receipt that authenticated against its own envelope, agreed with its exit
status, reported measured usage, republished nothing, left no attested worker
alive, and touched one file that was not the test. Fixing the dispatch
`agent_end` also made `stream.segmentUsageMatchesMessages` computable on that
surface, where the per-segment and per-message accounts now agree.

Not built: the multi-file, bounded-loop, write-boundary, and compaction
fixtures, and the chaos runner. Each needs its own end-to-end green loop before
it means anything, and the write-boundary case in particular needs a
deterministic way to make a model attempt a write it is not allowed, which the
fixture design does not yet have.

## Unreleased - v0.3.0 hardening session 5: truthful eval accounting, headless continuity, benchmark grading

- Eval artifacts moved to version 4. `summary.tokens` is now a discriminated
  accounting block carrying `measured`, `runs`, and `measuredRuns`, with the
  five counts present only when a run actually reported usage. The stored
  artifact no longer prints a numeric zero for work it could not observe; the
  parser refuses counts beside `measured: false`, a `tokens.total` threshold on
  an unmeasured artifact fails closed, and a comparison against an unmeasured
  side reports an unmeasured delta.
- Added `benchmarks/community/clio_usage.py`, the one fold that closes the
  adapter blind spot. The HumanEval and SciCode adapters run Clio as their own
  child, so a parent `clio eval` observed nothing; they now republish the usage
  they did observe as one aggregate `message_end` line on stdout, and publish
  nothing when nothing was observed. The HumanEval fold also replaced a `max`
  over any event carrying usage, which understated multi-segment turns, and its
  receipt lookup now resolves the state directory Clio itself resolves instead
  of a hardcoded `~/.local/state`.
- Added `clio run --session <id>` and `--continue`. Headless runs had no
  scriptable way to continue a conversation, so session compaction could not be
  exercised end to end by any supported path. Continuation fails closed on an
  unresumable session, and the session id is reported on stderr in text mode.
- SciCode grading is no longer environment-blocked. The HDF5 scoring path
  imports `scicode.parse.parse`, which is not on PyPI and was never installed,
  so every sub-step died on ModuleNotFoundError before executing a line of
  generated code. The grader now installs the package from source, resolves the
  import once as a preflight so an environment gap is reported as blocked data
  rather than as failed science, and defaults its data paths to the
  repository's `benchmarks/data/science-problems` directory.
- SciCode step capture was reading the event stream only when `solution.py`
  was absent, so a run whose agent answers with a code block instead of editing
  a file captured the first step and graded every later step against it. That
  showed up as each step failing with a NameError against its own function.
  Capture now runs every step and accumulates by defined symbol, and
  `run-problem --agent <recipe>` dispatches each sub-step to a worker instead
  of the main agent.
- Measured problem 10 across four configurations. gpt-5.6-luna scored 6/11 with
  clean AssertionError failures; KAT-Coder scored 1/11 through the main agent
  and 2/11 through `--agent coder`, with failures including undefined symbols
  and array-shape errors. The gap is model capability: the harness, the
  grader, and the target artifact are identical across all four. A dispatched
  worker completed without executing any tools, because a SciCode prompt asks
  for a code block rather than a workspace edit.
- Verified live against a local KAT-Coder target: a two-task `clio eval run`
  sealed a v4 artifact with 199,275 measured tokens across 2 of 2 runs, a
  headless `--continue` turn recalled the prior turn's content, and SciCode
  problem 10 graded 2/11 sub-steps passing with zero blocked steps, the
  failures being genuine numerical and symbol errors in generated code.

## Unreleased - v0.3.0 hardening session 4: the main loop, the tool substrate, and the engine seam

Session 1 mapped the hot path. This session re-engineered it: the SDK moved
forward, the engine seam got one owner, the chat loop became a state machine
composed of single-owner modules, notices stopped pretending to be answers,
and the tool adapter collapsed to one code path.

### pi SDK 0.80.6 -> 0.83.0

All three packages moved in lockstep. Two upstream removals drove real
deletions rather than shims:

- The implicit engine default stream function is gone. `createEngineAgent`
  now owns Clio's default and `worker-runtime` constructs through it instead
  of newing the pi `Agent` directly, so there is one construction site.
- pi's global OAuth provider registry (`registerOAuthProvider`,
  `getOAuthProvider`, `loginOpenAICodex`) was replaced upstream by
  per-provider `ProviderAuth.oauth` flows. `src/engine/oauth.ts` now keeps a
  Clio-owned registry adapting those flows, and the `loginOpenAICodex`
  originator special-case is deleted: the 0.83 codex flow owns browser vs
  device-code selection itself. `EngineOAuthProvider.getApiKey` became async
  because pi derives request auth through the async `OAuthAuth.toAuth`.

Payload patching (thinking summary, adaptive thinking, tool-choice
none/named, llama.cpp response schema) was evaluated and deliberately kept:
0.83.0 still exposes no per-round tool-choice or reasoning-summary
pass-through through pi-agent-core.

### The engine boundary owns every pi type

`src/engine/types.ts` defines `EngineModel`, the erased `Model<Api>` view.
`Model<never>` is gone from src and tests along with every
`as unknown as Model<...>` cast it forced at the seam (chat-loop model
synthesis, orchestrator boot, worker runtime, providers catalog, compaction
stream input, capability hints). Provider runtime descriptors take their
shapes from the engine barrel, so no file outside `src/engine/**` imports
`@earendil-works/*` at all. The boundary check's type-only allowlist is
deleted and rule 1 is now total.

### The chat loop is a state machine again

`chat-loop.ts` was 2,664 lines owning at least twelve concerns. It is now
804 lines of public interface plus the numbered submit/cancel flow,
composed from single-owner modules coordinating through one shared
`ChatTurnState`:

| module | owns |
| --- | --- |
| `turn-runtime.ts` | target resolution, model hot-swap, thinking reconciliation, probes, agent construction, run-event enrichment |
| `turn-context.ts` | prompt compile cache, context snapshots, prompt-cache honesty, compaction |
| `turn-recovery.ts` | overflow compact-and-retry, transient retry chain, retry countdown |
| `turn-queues.ts` | steer/follow-up mirror, persisted-echo dedupe, stranded-steer resubmit |
| `turn-persistence.ts` | every session-ledger append and the ledger cursor |
| `turn-middleware.ts` | turn hooks and the reminder buffer |

`runAutoCompact` is the one compaction entry point; the pre-submit trigger,
the preflight overflow guard, overflow recovery, `/compact`, and the
post-tool continuation guard all flow through it. Behavior is unchanged and
pinned by the existing contract tests.

### Notices are typed events, never fake assistant messages

Notices used to be synthetic `message_end` assistant messages, and headless
mode un-aliased them by sniffing `"[Clio Coder]"` and `"[/"` text prefixes.
A notice that forgot its prefix became the turn's answer; an answer that
started with a bracket became an error.

`ChatLoopEvent`'s `notice` variant is now the only notice channel, carrying
a `surface` discriminator (transcript or footer). Headless result derivation
keys on event types and stop reasons only, and `isDiagnosticAssistantText`
is deleted. An interrupted turn reports a nonzero exit with its abort reason
even when partial text landed, and internal errors can never masquerade as
answers.

The shutdown persistence race behind the live-observed
`session.append: no current session` wart is fixed by ordering, not by
catching the throw: `ChatLoop.whenSettled()` resolves when the in-flight
submit fully settles (aborted tool results and their ledger appends
included), and the orchestrator's drain hook awaits it. Domains stop in the
persist phase, strictly after drain.

The orchestrator's effective-autonomy resolution chain, previously repeated
in three closures, is now `resolveEffectiveAutonomy` /
`resolveBaselineAutonomy`.

### One tool adapter, admission off the clone path

`src/tools/agent-tools.ts` is the one adapter: `toAgentTool`, the shared
executor, `resolveAgentTools`, `effectiveToolNames`, `resolveSessionTools`,
and `invokeRegisteredTool`. The orchestrator and the worker resolve their
surface here, so the attested tool signature and the executable surface are
computed by the same narrowing in one file. `src/engine/worker-tools.ts`
keeps only worker-specific construction, and the duplicate
`resolveSessionTools` in `chat-loop-messages.ts` is gone.

Measured per-call overhead found one real cost: `registry.admit()` resolves
effective autonomy on every tool call, and the orchestrator's effective
settings view deep-cloned the whole settings blob each time (0.017 ms per
clone, measured). `getCurrentSettings` now memoizes on the config snapshot
identity plus a generation counter bumped by every session routing or
override mutation.

No tool alias or duplicate identity exists to remove: tools are keyed by the
`ToolName` union with no alias table, and `prepareArguments` normalizers
remain the only leniency layer.

### Boundaries

Rule 1 became total (no pi imports outside `src/engine/**`, type-only
included). Two rules were added and pinned with fixture tests: `src/tools/**`
never imports `src/interactive/**` (the substrate is surface-agnostic), and
the chat loop's turn modules never import `src/entry/**` (the entry point
composes the loop, never the reverse).

### Measurements

Micro-benchmarks (`tests/contracts/tool-admission-cost.test.ts`): 200
admissions derive the settings view once; steady-state per-call admission
stays under 1 ms; a batch of five 120 ms read-class tools completes in
~137 ms end to end where serial would be ~600 ms, with every read tool
declaring parallel execution.

Headless turn latency, this build against the pre-session baseline
(`a8fd1dab`), configured local target `mini` (llama.cpp,
KAT-Coder-V2.5-Dev-IQ4_NL), isolated CLIO_HOME, order-alternated runs:

| measurement | before | after | delta |
| --- | --- | --- | --- |
| tool turn, wall clock (median of 7) | 2681 ms | 2767 ms | +86 ms |
| tool turn, first token (median of 7) | 1744 ms | 1817 ms | +73 ms |
| no-tool turn, wall clock (median of 6) | 1331 ms | 1360 ms | +29 ms |
| client-side only, stub server (median of 14) | 1145 ms | 1184 ms | +39 ms |
| process boot (`--version`, avg of 10) | 53 ms | 48 ms | -5 ms |

One thing did get slower, and it is upstream rather than the refactor. The
+39 ms per process is the `@earendil-works/pi-ai/compat` module graph
growing between versions: importing it cold costs 229 ms on 0.80.6 and
268 ms on 0.83.0, which accounts for the whole client-side delta. Clio's own
code got faster on every axis measured: process boot is 5 ms quicker, the
first provider stream is 9 ms quicker on 0.83.0, and the per-call settings
clone is off the admission path entirely. Trimming Clio's eager pi-ai import
surface is the follow-up that would recover the 39 ms; it was not attempted
here because it touches the engine barrel's export shape.

### Live journeys (configured local target `mini`, llama.cpp,
KAT-Coder-V2.5-Dev-IQ4_NL, isolated CLIO_HOME under /tmp scratch)

1. Plain headless turn: exact reply, exit 0.
2. Tool-using turn: file read, correct codeword, exit 0.
3. SIGINT during a running bash tool: exit 130, drain awaits turn
   settlement before the session domain stops, no `session.append` throw,
   no orphaned children, the tool's side effect never lands.
4. Resume after a prior turn: the codeword is recalled through replayed
   context and the ledger keeps a single tree root.

### Verification

`npm run ci` green. The full suite is green under Node 24.9.0 (2486 tests)
and Node 22.22.3 (2490 tests; the difference is version-conditional cases,
not skips). Boundaries, typecheck, lint, and build all clean.

## Unreleased - v0.3.0 hardening session 1: main orchestrator and tools

One ordinary main-agent turn runs: CLI arg parsing (`src/cli/index.ts`) →
`runClioRun`/`runClioCommand` → `bootOrchestrator` (`src/entry/orchestrator.ts`),
which loads the domain bundle, builds the tool registry
(`src/tools/registry.ts` + `registerAllTools`), and composes `createChatLoop`
(`src/interactive/chat-loop.ts`). Headless turns run through
`runHeadlessMainAgent` (`src/cli/modes/print.ts`), interactive through
`startInteractive`, ACP through `serveClioAcpAgent`; all three drive the same
chat loop, registry, and safety admission. The chat loop resolves the target
per submit (`resolveRuntimeTarget`, fail-loud), compiles the session prompt
once per compile key, preflights context pressure before committing the user
turn, streams via `@earendil-works/pi-agent-core`, admits every tool call
through safety → skill surface → autonomy → before_tool guards, and settles
usage into session snapshots, observability, and the headless run receipt.

### Live-verified defect fixes

- **Replayed resumed session context at boot.** `CLIO_RESUME_SESSION_ID`
  re-pointed the session ledger without replaying history into the chat loop:
  the first submit ran with an empty provider context (a live resumed turn
  denied any memory of the session's own prior tool exchange) and appended its
  user turn with a null parent, growing a second session-tree root that
  silently abandoned the resumed active path. Boot-time resume now mirrors the
  interactive `/resume` overlay: leaf turn id plus rebuilt replay messages,
  degrading to leaf-only when replay construction fails so parenting stays
  correct. Regression: `tests/smoke/resume-replay.test.ts` (fails on the old
  code at the replayed-context assertion).

- **Aborted the in-flight turn on coordinated shutdown.** SIGINT/SIGTERM ran
  drain → terminate → persist without ever aborting the live chat turn, so a
  running bash tool's detached process group survived the CLI as orphans of
  init (reproduced live: `/bin/bash -c sleep 60 && echo done` outlived exit
  130). A drain hook now disposes the chat loop; the agent abort fans out to
  every running tool's AbortSignal and bash-exec signals the group.
  Regression: `tests/smoke/sigint-tool-children.test.ts` (fails on the old
  code with a surviving marker process).

### Live journeys (configured local target `mini`, llama.cpp,
KAT-Coder-V2.5-Dev-IQ4_NL, isolated CLIO_HOME under /tmp scratch)

1. Headless no-tool turn: exact reply, exit 0.
2. Grounded read turn: correct file contents cited.
3. Permitted edit + verify: file changed, re-read confirmed.
4. Read-only autonomy mutation: auto-denied, file untouched, actionable
   denial text.
5. Unknown-tool request: model routed to bash, parked call denied headlessly
   with the truthful no-operator reason; no repair loop.
6. SIGINT during streaming (65 ms shutdown) and during a running tool
   (children reaped post-fix).
7. Resume after a tool exchange: prior context recalled post-fix; single
   tree root.
8. Forced compaction on a resumed session: `compactionSummary` persisted,
   codeword still recalled through the summary bridge.
9. Interactive TUI parity via pty: same prompt answered and persisted with
   the same session-ledger shape as headless.
10. Clean exits on every run above; no leaked workers, prompts, or timers
    observed.

### Tool schema audit

A schema-vs-implementation sweep of every registered orchestrator tool found
the surface almost entirely consistent (read, write, edit, bash, grep, find,
ls, code_nav, context, artifact, tasks, ask_user, credential_present,
monitor, steer, and the dispatch argument contract were clean). Two real
gaps were fixed: `git` and `verify` honored `timeout_ms` and
`max_output_bytes` through the shared safe-exec runner without declaring
them, and `web_fetch` advertised a `markdown` format value the
implementation never distinguished from `auto`. Schemas and descriptions now
state exactly what the implementations accept.

### Verification

Both fix regressions fail on the pre-fix code and pass on the fix. The full
gate (`npm run ci`) and the complete suite ran green under Node 24.9.0 and
Node 22.22.3 with identical totals and no version-specific differences.



Dispatch Primitives v2: the dispatch domain graduates from single-host
workers to a measured, process-safe multi-node fleet, and the workflow layer
above it graduates from agent-only fleets to deterministic code steps, bounded
repair loops, shipped SDLC chains, a queryable run trace, and per-step write
boundaries enforced against the checkout.

### Post-release live verification

- **Made the joint-route latency contract insensitive to host contention.**
  The maximum-universe resolver check remains in the release gate with its
  original 10 ms p95 bound because decision latency is an explicit active-route
  readiness condition, not incidental benchmark trivia. The former 40-sample
  wall-clock measurement could fail when the test process was merely
  descheduled: one loaded release run reported 10.773 ms even though the whole
  test passed quickly in isolation. The contract now discards 100 warmup
  resolutions, takes 200 samples, and measures the process's user plus system
  CPU time for each resolution. That preserves the real performance invariant
  while removing scheduler delay from a correctness gate; simply raising the
  threshold would have hidden both possibilities.

- **Fixed two more handle-free timer liveness defects.** A production timer
  sweep found two awaited operations whose only possible resolver had been
  deliberately unreferenced. A hung shutdown hook could let
  `runWithBudget()` disappear with unsettled top-level await instead of
  returning `false`, and delayed manual OAuth input could exit before opening
  its prompt. Both timers now remain referenced because they are foreground
  deadlines, unlike heartbeat and telemetry timers that are genuinely
  background work. Handle-free subprocess regressions reproduce the old Node
  exit code 13 and pass on Node 22.22.3 and 24.9.0 with the fix. The rest of the
  timer sweep found referenced child, pipe, queue-deadline, or explicit
  keep-alive handles behind every awaited production path.

- **Stopped unrelated retired ledger rows from poisoning current evidence.**
  The first live fleet run completed successfully but automatic evidence
  failed on `runs.json[401]: executionRole missing`: evidence for one current
  run strictly parsed every retained historical envelope before selecting its
  source. Evidence construction now selects raw rows by the requested run or
  session first and strictly parses only those rows, preserving their original
  indices in diagnostics. A current row beside an unrelated legacy row now
  builds and indexes evidence; asking for the legacy row itself still fails
  closed. Generated HumanEval run output is also excluded from Biome's input so
  ignored benchmark artifacts cannot make lint depend on local scratch state.

- **Verified the released fleet workflows against the configured local
  worker.** The `dynamo` target's declared wire models were reconciled with its
  live `kwaipilot_kat-coder-v2.5-dev` default. Live discovery, doctor, and
  worker attestations all named `dynamo`, `lmstudio-native`, and that exact
  model; receipts recorded nonzero token counts and zero local cost with
  `unknown` cost provenance rather than fabricated price data. The scratch
  repositories are under `/tmp/clio-v029-*`; the isolated evidence store is
  `/tmp/clio-v029-evidence/state`, with its trace database at
  `trace.sqlite`. The unreconciled settings had been accepted silently:
  `validateWorkerTarget()` in `src/core/config.ts` checks that a worker target
  id exists and that its model is a string, but does not require that model to
  occur in the selected target's `wireModels`. That validation gap remains a
  reported defect; the live configuration itself is now consistent.

  Deterministic fleet validation rejected both an unknown command id and a
  missing registry with exit 2 before creating state or data directories. A
  repairable `build-test` ran red, dispatched one repair, and then ran green.
  An unfixable registry command ran exactly three checks and two repair workers
  before reporting `loop_bound_exhausted`; its root is
  `fleet-86191c45f94d` and its code-step records are under
  `code-steps/fleet-86191c45f94d/`. The local model produced the same README
  mutation on both repairs, and its last attempt consumed 117,815 tokens while
  repeatedly revisiting blocked tool calls. No assertion or loop bound was
  relaxed.

  Write-boundary root `fleet-ece6ccf63141` preserved the authorized `src/`
  edit, restored `docs/forbidden.txt`, failed with the exact unauthorized path
  and declaration, and sealed a `rolled-back` verdict. Root
  `fleet-056bf98db3b4` sealed `clean`. Root `fleet-f3718c42ac51` changed a file
  that was dirty before the scheduling window and correctly sealed
  `rollback-incomplete`, leaving the model's bytes in place and explaining why
  the operator's prior content was unrecoverable. All three verdicts are under
  `write-boundaries/<rootId>/wave-0.json` in the isolated state directory.

  Two real `sdlc` attempts reached plan and the first commit, whose architect
  supplied no `commitMessage`, so the deterministic fallbacks were
  `clio(fleet-c54939f4c334): sdlc commit-plan` and
  `clio(fleet-b0b3130fdf29): sdlc commit-plan`. Their builders then exhausted,
  respectively, the 50-call worker cap and the repeated-tool loop guard before
  suite or review. Consequently these runs did not live-verify staleness
  revalidation, gate staging/materialization, or authored build/document
  commit messages; no gate artifact was produced, and none is claimed. The
  failure receipts are `receipts/107135nzmzgc.json` and
  `receipts/2k2vhubdyvjn.json` in the isolated state directory.

  The trace CLI exercised runs, phases, follow-tail, processes, and read-only
  SQL during and after execution. The viewer's cursor advanced from row 2231
  to 2232 without a gap or repeat; its waterfall timestamps matched receipt
  `1jh4bzcimsnj`, and its spend data carried 27,551 real tokens, null component
  dollar splits rendered as `not recorded`, and a zero local total. Gate
  evidence was absent for the documented reason above. An operator abort killed
  process group 1436868 and sealed cancellation in
  `receipts/34b70335b6q0.json`, although the worker hit its tool cap during the
  same race. SIGSTOP of process group 1437355 produced stalled receipt
  `ck7iaj6x7u33`, then retry `20clrlt6l1nd` at attempt 1. The resilience
  cooldown intentionally protects new assignments; an admitted retry chain
  uses backoff and `maxRetries`, and the retry's deterministic tool-cap failure
  correctly ended the chain.

- **Keep the Node matrix continuously enforced.** The workflow already runs
  Node 22 and 24, so no workflow rewrite is warranted. Protect `main` with both
  `ci (22)` and `ci (24)` as required checks, disallow direct pushes, and do not
  permit bypasses. That single repository-ruleset change prevents another
  109-commit interval from merging without either supported runtime.

### Added

- **Per-step write boundaries with post-run verification and rollback.** A tool
  permission level says what a step *can* do; it has never said what a step is
  *allowed to change*. `bash` runs anything and a write tool reaches any path, so
  "this reviewer touches nothing" was a sentence in a prompt. Fleet contract v4
  turns it into a declaration and then checks it: each step carries a `writes`
  allowlist of repo-relative path prefixes, an entry ending in `/` covering the
  subtree, and `readonly` is the empty allowlist stated out loud. The boundary
  lives on the step rather than on the recipe. A recipe is identity, and the same
  `coder` legitimately owns `src/` in one workflow and `docs/` in another; a
  recipe-level default would need a merge rule, and every answer to "widen or
  intersect?" is a way to end up with a boundary wider than the contract an
  operator read.

  Enforcement is detect-and-rollback, not sandboxing, and the documentation says
  so plainly: no container, no seccomp filter, no interception of the worker's
  tools. Nothing prevents the write. The orchestrator snapshots the checkout
  before a scheduling window opens, diffs it afterwards against the pinned
  baseline commit using git plumbing over the dirty set, restores every
  unauthorized path, and fails the step with the typed
  `writes_boundary_violation` naming the exact paths and the exact declaration,
  because the expected remedy is usually widening a declaration that was too
  narrow. Comparison is by blob identity rather than by status letter, so a
  commit step that moves HEAD without touching the working tree reads as no
  change at all.

  Rollback restores only what git already has. A path that was already dirty when
  the snapshot was taken has its prior bytes nowhere, so an unauthorized change to
  it is reported as `rollback-incomplete`, the working tree is left exactly as the
  step made it, and the record names the paths and the reason. Deleting an
  untracked file nobody snapshotted is that case. The alternative, reconstructing
  content that was never recorded, is guessing at operator work.

  Attribution is honest about the fact that fleet steps share one checkout. There
  is no per-step worktree in the fleet path, so a change made while two steps ran
  cannot be pinned on one of them. Plan compilation therefore refuses a wave that
  schedules more than one step with a non-empty allowlist, and refuses a wave that
  mixes boundary-declaring steps with undeclared ones; a readonly step may still
  run beside the wave's one writer. Everything else fails closed: a declared
  boundary with no verifier, a non-git workspace, and a declared path that leaves
  the workspace through a symlink are all refused before any spawn. Verdicts are
  sealed under `write-boundaries/<rootId>/` beside the run ledger with their own
  digest and baseline commit, and violations surface where step failures already
  do. Boundaries are opt-in by version: a v3 contract's `workspace` step still
  means the whole checkout, and a `writes` key under an older version is refused
  by name rather than silently ignored.

  What counts as a change is what git reports, so an ignored path is outside
  enforcement; a repository decides what its content is, and this is not the
  place to overrule it. The single subtraction is Clio's own state directory when
  an operator has placed it inside the workspace, because receipts, code-step
  logs, and boundary verdicts are the orchestrator writing its journal while the
  step runs. A demonstration fleet whose registered command edits its allowed
  directory, overwrites a tracked file outside it, and drops an untracked file at
  the root ends with the authorized edit intact, the tracked file restored from
  the baseline commit, the stray file removed, `writes_boundary_violation` on
  stdout naming both paths and the declaration, exit 1, and the sealed verdict on
  disk. That run also surfaced a defect in the code-step slice: a fleet made only
  of deterministic steps asked the reservation authority for an empty
  reservation and was refused. A plan that admits no worker now reserves no
  capacity instead.
- **Builtin SDLC fleets with bounded repair loops.** Clio had the primitives for
  a software-development workflow and shipped none of it. Three fleets now run
  out of the box from `src/domains/agents/fleets/`: `build-test` (builder, suite,
  bounded fix loop), `build-review` (builder, review gate, bounded revise loop),
  and `sdlc`, the full plan → build → test → review → document chain that commits
  each work product separately. A project `.clio/fleets/<name>.md` shadows a
  builtin of the same name, and `clio fleet list` shows which source each came
  from. They name registry command ids rather than invocations, so a repo without
  `.clio/fleets/commands.yaml` gets a hard, named error instead of a green
  placeholder for a phase that never ran.

  The loop is a declared construct, not an inference. A `loop` step carries
  `maxAttempts`, a check (a registered command or a gate agent), and an agent
  repair; the bound is required and capped, and contract validation also refuses
  dependency cycles, ids that collide with the ones a loop generates, and a
  commit whose message source it does not wait for. Compilation unrolls each loop
  into `maxAttempts` conditional verifications and one fewer repair, chained so
  attempt `n + 1` only exists behind repair `n`. The plan therefore stays one
  deterministic hashed DAG (now `ExecutionPlan` version 4, sealing loop
  membership) with whole-plan admission and reservation before the first spawn
  and a separate receipt per attempt; the scheduler's only runtime decision is
  whether a declared node is still needed. A resolved loop reports its remaining
  nodes as `unneeded`, which is neither a skip nor a failure, and spending the
  bound without a pass reports the typed `loop_bound_exhausted`.

  An edge out of a verification is answered by the loop, never by that run's exit
  status. A reviewer that ran perfectly and returned `fail` is a successful run
  and an unmet condition, so reading its exit code downstream would let a rejected
  review flow onward as approval; dependents of an unresolved loop are blocked and
  a stop-policy plan ends there. Agent-checked loops reuse `decideReviewGate`
  rather than growing a second revise mechanism: every cycle stages and
  materializes a `GateDecisionArtifact` with sealed route correlation, and the
  repair attempt receives the gate's structured findings instead of the reviewer's
  transcript. Every repair is `recovery` work and enters the ledger as attempt `n`.

  Staleness is enforced by the scheduler, not by prompt wording. A verification's
  green measures the workspace at the moment it completed; any later workspace
  step that is not itself a verification or a commit invalidates it, and the
  verification runs again before a dependent may treat it as satisfied, bounded by
  `STALENESS_REVALIDATION_LIMIT`. Only deterministic verifications are
  revalidated, because re-running a model gate is a dispatch that has to be
  declared and paid for. In the `sdlc` chain this is the rule that a revision
  landing after the last green suite re-enters the suite before anything is
  committed, so the tree that gets committed is the tree that was both tested and
  approved.

  Commits are code steps. `commitFrom` lists candidate authors newest first, a
  loop standing for its repair attempts, and the message is the first candidate
  that actually ran and answered the new optional `commitMessage` on its terminal
  contract, falling back to a deterministic `clio(<rootId>): ...` line. Registry
  argv binds whole-token `{{name}}` placeholders only, so a supplied value is
  exactly one argv element that no shell ever sees, and an empty diff fails the
  commit rather than recording nothing. The agent proposes the sentence; code
  decides and runs git. A failed run therefore leaves the plan committed and the
  working tree dirty on purpose, which a live `sdlc` run against a toy repo
  reproduces: red suite, repair, green, revise, staleness re-run, and then a
  review that never returned a valid verdict, ending with the code uncommitted.

  Repositories that use the shipped commit step should register a command that
  stages new files, for example
  `argv: [sh, -c, "git add -A && git commit --message \"$0\"", "{{commitMessage}}"]`;
  a bare `git commit --all` cannot record a plan artifact that does not exist yet.
- **Deterministic code steps in fleet contracts and execution plans.** A known
  command is no longer an agent's job. Fleet contracts gain a discriminated step
  kind: `agent` steps behave exactly as before, and `code` steps name a command
  id from a repo-owned registry at `.clio/fleets/commands.yaml`. The registry is
  the only place an invocation is written down, so a contract can say "run the
  test command" without knowing this repo's runner and a model can never author
  a shell string. Fail-closed throughout: an unknown command id, or a code step
  in a repo with no registry at all, fails contract validation before anything
  dispatches, because a green test phase that never ran a test is the exact
  failure this mechanism exists to prevent. Contract schema is versioned rather
  than extended: v1 keeps its original agent-only meaning and a code step
  requires v2, so a reader that cannot run one refuses the whole contract
  instead of executing a partial DAG with its deterministic gates missing.

  `ExecutionPlan` becomes version 3 with a step-kind discriminant. A code step
  is a first-class DAG node outside worker admission entirely: it takes no
  capacity lease, no reservation member, no execution role, and no authority
  grant, and it never reaches route history or the routing quality reducer. It
  is a subprocess, not a route. `maxWorkers` still bounds concurrent model runs
  only, so a deterministic gate never displaces a worker or forces an extra
  wave. The runner is unattended by construction: argv from the registry, fixed
  cwd, a closed environment allowlist rather than the operator's shell, a
  bounded timeout that kills the whole process group, byte-capped capture that
  keeps the tail, no stdin, and no permission prompt. Its result is the new
  typed `code-report` contract (`passed`, `exitCode`, `checks`, `artifactPaths`,
  `outputExcerpt`), validated and sealed exactly like an agent's terminal
  result; no agent recipe and no Scout subtask may declare that kind, and its
  routing quality is always `unmeasured`.

  The point is the failure path. Under `onFailure: continue`, a red code step's
  report still crosses its outgoing edges, so a builder repairs a failing suite
  from the command's verbatim output rather than from a summary of it. Both
  kinds of predecessor now render into the downstream worker's prompt through
  one bounded `dispatch-predecessor-handoffs` message, labeled as data and never
  as instructions. Per-run provenance lands under `code-steps/<rootId>/` in the
  state directory, beside the run ledger rather than inside it: a subprocess has
  no agent, runtime, token, or route facts, and writing zeros into those fields
  would put fabricated route rows in front of every reader of dispatch status.
- **Singular dispatch, briefing separation, and structured terminal outcomes.** `task` is now a first-class singular assignment alongside batch `tasks`; supplying both fails, and briefing-only calls explain that context cannot replace an assignment. Shared and per-task briefing precedence remains explicit, the 12,000-byte canonical value is pinned in the immutable approved plan, and execution ignores later raw-argument mutation. A fifth deterministic outcome code, `worker_final_output_missing`, fails an otherwise successful native or ACP run when event draining produces no nonempty receipt-sealed final output. Partial deltas remain diagnostics and this code suppresses automatic retries without parsing prose.
- **Receipt-integrity v15 and steering provenance.** Successfully written native steers record stable sequence, UTF-8 bytes, SHA-256, send time, and observed acknowledgement without retaining message text. Operator/TUI and model steering share the dispatch-contract path; ACP remains non-steerable. Current receipts seal v15 and the current reader rejects every earlier receipt format. Ledger mismatch checks include steering, routing intent, quality, route decisions, worker identity, and result conformance; orphan recovery adopts only integrity-valid v15 provenance.
- **Canonical worker prompt compiler and agent-owned loop budgets.** Native dispatch now resolves effective autonomy and the final canonical toolkit once, then compiles identity-lite, the shared operating/task contract, sliced tool guidance, matching safety, and one recipe/override persona through the prompts domain. Dynamic project, memory, briefing, pipeline, task, and run-posture messages remain outside stable hashes. Recipe parsing strictly validates the exact `budget: {toolCalls, readReserve, synthesis}` object whenever declared; builtins declare it, Scout uses `18/4/true`, Coder uses `50/5/true`, and a custom source recipe without it receives a concrete operator-default budget at admission. Dispatch transports the clamped phase policy plus the independent operator attempt cap through `WorkerSpec`; native and Claude SDK enforce canonical counting/read reserve/synthesis, coincident Coder `50/50` completes call 50 before graceful synthesis, and Claude Code/Antigravity reject explicit budgets they cannot mediate. Scout citation quarantine, split recommendations, and two corrective provider rounds remain role-specific.

- **Worker transport seam, local/SSH initialization parity, and attestation.** Worker spawning is
  transport-neutral: the WorkerSpec/stdin + NDJSON/stdout protocol crosses
  the wire unchanged through `ssh -T` with a whitelisted environment
  (`CLIO_RESIDENCY=observe`, `CLIO_WORKER_ANNOUNCE=1`); the orchestrator's
  environment never crosses. Workers announce pid/host for a remote kill
  fallback, and a stdin-EOF monitor aborts and force-exits an orphaned
  remote worker so no process is ever stranded. Local and SSH native workers
  both force and consume `worker_announce` as the first event, rejecting a
  missing or mismatched WorkerSpec version before ordinary events. Before any
  model call, the worker also attests protocol, pid/process group, host,
  settings and WorkerSpec digests, runtime, target, endpoint, model, effective
  tool surface, and bounded resource facts; any drift kills the process group.
  Internal `clio worker` is the default remote invocation.

- **Deterministic node registry, process-safe placement, failover, and doctor
  preflight.** `fleet.nodes` in settings declares SSH nodes; a registry
  tracks online/offline/draining state and per-node capacity. Placement honors
  exact pins, then spreads work by durable lease usage and declaration order;
  the cross-process lease authority makes the final capacity decision under
  one state lock.
  Two consecutive channel failures classify a node dead; in-flight runs are
  reaped and their bounded retries reroute with the full hop lineage
  recorded on ledger rows and receipts (`node`, `reroutes`, integrity-covered
  in v15). `clio doctor` runs a durable per-node preflight
  (reachability, version match, project-root path parity, writable state
  dir); admission fails closed on missing or stale records.

- **Detached fan-out with a durable collect barrier.** `dispatch`
  `detach:true` admits and spawns every task, then returns the batch id and
  logical assignment ids while a background drain keeps metering, run tails, and board
  progress flowing. Batches persist in `batches.json` beside the run ledger,
  so a resumed session collects from ledger rows alone. The monitor tool
  gains `mode=wait` (single-run block with a monotonic-clock timeout) and
  `mode=collect` (batch barrier: pending snapshot in flight, full results
  once terminal, batch marked collected). A turn-end nudge surfaces
  completed uncollected batches and goes silent after collection. `wait`
  observes without collecting; collect is the authoritative terminal batch
  operation and the parent contract requires it before synthesis.

- **Truthful terminal evidence rendering and orchestration guidance.** Dispatch
  and monitor now render positive verified receipt integrity separately from
  evidence verification, and render briefing separately from bounded project
  context. A successful Scout receipt is an index: the parent normally spends
  no more than six risk-weighted spot-check calls, never calls those checks an
  independent specialist confirmation, and puts receipt-derived context in
  `briefing`. Loop-guard rejections are not retried syntactically, detached
  batches are collected before synthesis, and read-only report requests end in
  the assistant response rather than an artifact.

- **One ordinary dispatch consumer; synchronous dispatch is auto-wait.**
  Every ordinary single or batch handle launched by the dispatch tool is
  registered immediately with one instance-scoped event owner. That owner
  drains the iterator exactly once, maintains bounded per-run monitor tails,
  publishes fallback progress only when the dispatch domain does not own the
  bus, and exposes one stream-plus-receipt completion promise. Synchronous and
  pipeline paths await completion; detached dispatch returns after durable
  batch registration while the same consumer continues, including when
  registration fails after runs are live. Review and compete intentionally
  retain direct coordinator drains: reviewer/judge output is staged before the
  receipt-facing await so crash recovery keeps its write-ahead edge. The
  interactive operator/TUI can inspect and steer an active synchronous native
  run through the dispatch contract. Because dispatch and steer are sequential
  model tools, the parent model gets mid-run monitor/steer control by choosing
  detached dispatch and using its returned ids. ACP delegation remains
  monitorable but non-steerable because it has no stdin channel.

- **Review gate, compete topology, and plan approval.** `review:{reviewer?,
  max_cycles?}` runs a builder, then a reviewer pinned read-only through a
  new request-level autonomy narrowing (admission clamps to the lower of the
  request and the session, so workers never exceed the orchestrator's
  authority); revise verdicts re-run the builder with findings threaded as
  input data, and exhaustion or failure surfaces as an explicit operator
  decision. `mode:"compete"` builds N candidates (2..4) in scratch git
  worktrees on `clio/compete/<group>/<n>` branches, a read-only judge ranks
  them, full-auto merges the winner, supervised levels preserve exactly the
  winner for the `apply_winner` confirmation, and losers are cleaned on
  every path. Plan-scale dispatch calls (multi-task, compete, remote pin,
  apply_winner) map to one approval ask at supervised autonomy levels with
  the rendered plan artifact as the prompt; full-auto logs the plan hash
  into every receipt instead. Receipts chain the topology through new
  required current-format routing/gate/plan evidence covered by receipt
  integrity v15.

- **Fleet visibility across every operator surface.** Dispatch lifecycle bus
  events carry node id, gate role/cycle, reroute count, and the model
  context window; board cards show node, gate and reroute badges, live tool
  names (arguments never cross the worker stdout seam), and a per-worker
  context meter (warn 80%, critical 95%) extending context-meter.ts. The
  `/fleet` overlay gains a nodes view over the registry and the profile
  node-pin editor; monitor and `clio fleet status` name the node per run.

- **Shadow-mode speculation observer.** The awoc pipeline's intent detector,
  rule solver, and learner semantics observe every dispatch, compute the
  would-be plan on a synchronous rule path (no model calls), and record
  plan-versus-actual accuracy into a bounded rotating JSONL under
  `<state>/speculation/`. Observer-only: disabling it changes nothing.

- **Docs.** `docs/fleet-dispatch.md` (architecture, node setup, preflight,
  placement, topologies, failure semantics, residency-observe default) and
  `docs/fleet-demo-runbook.md` (executable zbook/blade/mini/dragon demo with
  a reviewer-gated CMake/C++ fix and a receipts-only provenance
  walkthrough).

### Added (recon, evidence, and truthfulness hardening)

- **Integrity-sealed receipt verification.** Current receipts carry a required
  `verification` field (`verified`/`unverified`/`not_applicable`/`unknown`
  with a stable basis token) derived at finalization from capability class,
  ACP observability, and validation-tool evidence. Descriptive only: outcome,
  retry, reroute, and the finish gate never read it. Receipts from every
  earlier integrity version are rejected rather than projected as current
  evidence.
- **Evidence-labeled dispatch and monitor output.** Worker text renders under
  a label keyed on the integrity-checked verification state; receipt
  integrity failures render head-anchored banners; deterministic non-evidence
  notices flag failed, cap-exhausted, zero-tool, and citation-free
  reconnaissance. Monitor collect verifies each receipt before labeling and
  fails closed to unknown. The parent spot-check sentence is byte-shared
  across dispatch output, the operating contract, the agent catalog, and
  docs.
- **Scout split recommendations.** A head-anchored, byte-bounded
  `SPLIT RECOMMENDATION` envelope in a scout's answer is parsed fail-closed
  and promoted into transient `dispatchDetails.splitRecommendation`; the
  parent alone decides whether to fan out.
- **Reconnaissance grounding prompts.** Scout must cite live `path:line`
  reads, quarantine unverified leads under `Unresolved gaps:`, and treat
  wiki content as orientation only; the operating contract adds the
  recon-nonevidence qualifier.
- **Receipt-derived eval bridge and bounded live suite.**
  `evidence.verification`, `evidence.firstPassSuccess`, `cost.usd`,
  `dispatch.count`, and `wiki.staleAcknowledged` metrics resolve from sealed
  receipts and the run event stream, failing closed when absent; suites gain
  a clio-run `agent` field and a matrix `maxCostUsd` ceiling
  (budget-exhausted items fail closed). `npm run test:live-eval`
  (CLIO_LIVE_EVAL=1) runs the stale-wiki and decomposition scenarios
  sandboxed and cost-bounded.
- **Worker synthesis reserve.** The tail of the worker tool-call cap is held
  for verification reads and synthesis: a one-shot budget-reserve directive,
  non-read calls steered back with a reason distinct from cap exhaustion,
  and the unchanged hard cap and bounded backstop behind it.
- **Truthful TUI approvals.** Permission-parked tool calls render as
  ⏸ awaiting approval instead of a counting running line, flip back on
  grant, and settle honestly on deny; permission-required metadata carries
  the provider toolCallId for exact segment correlation.
- **Honest monitor arguments and detached-batch nudges.** Single-run modes
  accept singleton `run_ids`, collect documents that it never blocks,
  wait-timeout copy leads with continuation, and batch nudges report
  terminal-state breakdowns derived from ledger envelopes instead of
  claiming success.
- **Proactive, enforced Scout routing.** Explicit broad repository/codebase
	 exploration is routed by the chat harness through one admitted Scout
	 dispatch before the main-model round; the model is not asked to choose the
	 route. The normal dispatch events, Fleet Runs UI, and sealed receipt remain
	 visible, then the main model receives that receipt in a tool-free synthesis
	 round. A failed Scout is reported instead of opening a manual scan loop.
	 Listing the fleet, dispatching the wrong agent, a blocked/error call, or a
	 mixed batch cannot satisfy the route. Terminating artifacts now fire the
	 real `turn_end` boundary.
- **Model-authored Scout routing.** Removed the chat-harness hijack, regex
  intent gate, and middleware block and spot-check state machine. Broad
  reconnaissance dispatch is now chosen by the model under the operating
  contract and Scout catalog description. The read-only threshold nudge
  remains advisory after 9 or more manual exploration calls.
- **Bounded Scout synthesis rather than cap failure.** Scout gets an 18-call
  exploration phase and then a text-only synthesis phase. Lockout
  noncompliance is counted by provider round, so a wide parallel batch cannot
  spend the entire denial backstop. Tool-use planning preambles are no longer
  sealed or rendered as final output, and semantic cap exhaustion no longer
  launches an invisible background retry.
- **Controllable, task-aware Fleet Runs UI.** Dispatch lifecycle events carry
  the bounded task, and the domain event pump publishes live worker progress
  exactly once for attached, detached, batched, and retry runs. The Fleet Runs
  island/board shows task, run ID, active tools, tokens, priced cost, retry
  countdown, and terminal history. Operators can select, steer, and cancel a
  native worker or retry timer; steering distinguishes queued from worker
  acknowledgement, and cancellation immediately renders `cancelling`.
- **Transcript-shaped live eval gate.** The bounded recon suite now runs the
  natural “explore this repo and context” request and requires an authored
  Scout dispatch, while the eval output buffer preserves its terminal tail
  under verbose JSONL. Approval artifacts include and cryptographically bind
  each dispatched task, so routing-only plans can no longer hide the work an
  operator is approving.

### Completed dispatch-routing slices

- **Slice 1 — measurable route quality.** Receipt, gate, and eval evidence is
  reduced by one pure quality authority. Descriptive receipt verification does
  not label correctness; only authenticated correctness-bearing sources do.
  Run-local quality is integrity-covered and later gate/eval labels link by
  receipt digest instead of mutating a receipt.
- **Slice 2 — strict recipes and result contracts.** One versioned frontmatter
  schema owns every recipe. Malformed custom recipes are quarantined and a
  malformed builtin fails startup. Typed result contracts have exact wire
  shapes and bounded repair. Scout citations are structurally grounded in
  this run's observed read spans. `resultContractWasDue` records
  `not-reached` when execution ended before the postcondition, so transport,
  policy, cancellation, and setup failures do not become false quality
  failures.
- **Slice 3 — execution roles and gate routes.** Builder, reviewer, judge,
  researcher, verifier, and recovery are required on requests, plans, ledger
  rows, receipts, candidates, and history keys. Gate deciders use typed
  contracts and default to the builtin verifier. GateDecisionArtifact v2
  seals route correlation; independence is a soft preference only after hard
  filters and quality floors.
- **Slice 4 — ExecutionPlan DAG.** ExecutionPlan v2 is the sole deterministic
  orchestration DAG. It seals stable task ids, dependencies, requested and
  approved authority, capacity waves, stop/continue semantics, and structured
  authenticated handoffs. Whole-plan preflight and reservation happen before
  any worker spawns.
- **Slice 5 — sealed routing intent.** Strict model-facing intent covers
  posture, cost, deadline, quality, capabilities, locality, and failover.
  Candidate envelopes are coordinator-authored, route explanations are
  bounded/redacted, and hard constraints always eliminate before scoring.
- **Slice 6 — process-safe admission.** Durable capacity state v2 owns global
  and per-node expiring leases, priority/FIFO queues, finite queue deadlines,
  retry rebinding, reservation transfer, and TTL-bounded operator drain under
  one cross-process lock. Lease-bound admission fails closed and reclaiming a
  lease requires owner-liveness evidence when a birth token cannot prove
  death.
- **Slice 7 — worker protocol and attestation.** WorkerSpec v3 requires a
  concrete budget and settings fingerprint. The bounded two-lane protocol
  keeps heartbeat and control acknowledgements away from display pressure,
  never drops receipt-bearing frames, and attests the complete approved worker
  identity before any model call. Local and remote aborts target the complete
  process group.
- **Slice 8 — joint route resolution.** One pure resolver enumerates the
  bounded route cross-product, applies every hard filter, computes measured
  estimates, Pareto-ranks admissible tuples, and retains every candidate and
  rejection while bounding only the fallback projection. Route policy is v4.
  Route history v3 aggregates compatible capability evidence and explicitly
  retires older files; tool-surface and endpoint drift invalidate evidence,
  prompt wording and unrelated settings fingerprints do not.
- **Slice 9 — active read-only routing.** Settings name exact active roles and
  postures; both default empty. The same joint resolver and decision artifact
  serve shadow and active modes. `evaluateRouteReadiness` reports every gap,
  including exact-role quality labels, Wilson lower bounds, reliability, known
  cost, fresh route facts, integrity, hard-filter validity, and decision p95.
  Active mode fails closed with no ready tuple and never drifts manual pins or
  `failover: none`.
- **Slice 10 — transactional attempt isolation.** One baseline-pinned worktree
  group belongs to each editing assignment. Every attempt gets a separate
  checkout. Pure apply eligibility checks outcome, receipt integrity, result
  conformance, and quality gate before the repository is touched; protected
  artifacts, baseline ancestry, and destination cleanliness are then rechecked
  on disk. A refused winner is preserved with recovery instructions.
- **Slice 11 — bounded agent automation and Scout escalation.** `agent: auto`
  enumerates audience, authority, tool, skill, result-contract, locality, and
  governance fit as hard constraints, then scores agent/target/model/runtime/
  node as one tuple. Task features affect cold priors only; measured
  role-quality retires them. Automation remains shadow by default and has an
  exact agent/role readiness report. Strict Scout split data compiles to an
  ExecutionPlan only after schema and DAG validation; read-only-to-editing
  transitions require authenticated plan approval or existing full-auto
  authority, share one absolute deadline, and recheck the approved identity,
  contract, cost, and authority before spawning.

### Current durable boundaries

- Receipt integrity: v15 only; earlier receipts are rejected.
- Route policy: `route-policy/4`.
- Route history: v3 only; earlier files are renamed to timestamped retired
  siblings and are not read as evidence.
- ExecutionPlan: v2 only.
- Resolved dispatch plan: v3 only, with a required explicit deadline field.
- WorkerSpec: v3 only, with required budget and settings fingerprint.
- Session metadata: v3 only; earlier session directories must be removed.
- GateDecisionArtifact: v2 only.

The deterministic contract suites cover every named slice case. Live routing
verification uses isolated settings and free local targets; `active-readonly`
seeds integrity-valid fixture evidence through the canonical history writer to
prove activation plumbing, and `agent-auto-shadow` proves that explicit Scout
execution remains unchanged while agent recommendations are sealed.

## 0.2.8 - 2026-07-07

The final 0.2.8 release. It ships everything in the 0.2.8-rc section below
plus the post-rc battle-hardening sprint documented here: measured fixes from
live local-model traces, the multi-model residency rework, and native
shadow-agent fleet routing.

### Added

- **Shadow agents route through fleet profiles.** `/agents` lists shadow
  agents, Settings > Fleet points at worker profiles and bindings, and
  `/fleet` lists bindable native agents, binds a shadow agent to a
  target/model worker profile, and changes a bound profile's model from the
  bindings tab.

### Fixed

- **Co-resident model residency with symmetric protection.** Local inference
  targets are treated as multi-model servers with finite VRAM instead of
  single-model slots. One shared residency reconciler drives llama.cpp
  routers, LM Studio, and Ollama: llama.cpp reads the router's
  `max_instances` and loads into a free slot without evicting anything (a
  scout turn no longer evicts the co-resident coder and its prompt cache);
  LM Studio attempts the co-resident JIT load first and swaps only after a
  will-not-fit failure, so a fresh worker no longer unloads the operator's
  model; Ollama releases only Clio's own stragglers. Protection is
  symmetric: router models tagged `pinned:true`/`role:scout` and every model
  referenced by settings (orchestrator, worker default/profiles, target
  defaults) are never evicted by another Clio stream while an unprotected
  candidate exists. Residency decisions are cached per (target, model)
  within a TTL, and mutations against one server are serialized across the
  orchestrator and worker processes through a state-dir lock file. The
  `CLIO_RESIDENCY=observe` and target `lifecycle: user-managed` opt-outs now
  force observe-only on every runtime path, including llama.cpp routers,
  which previously ignored both.

- **The llama.cpp runtime loads the selected router model.** Resolving a
  model id that is in neither the target's configured `wireModels` nor its
  live catalog now surfaces a `model-not-in-catalog` warning instead of
  passing silently.

- **Deadline timers hold the event loop until they fire or are cleared.**
  Found by the first full CI run of the post-rc sprint: node 22's test
  runner drained the event loop before unref'd timers fired, so the ACP and
  internal-dispatch-deadline contracts hung with "Promise resolution is
  still pending but the event loop has already resolved" (node 24 happened
  to keep the loop alive). The unref pattern was load-bearing in six spots
  where the timer's firing is the only thing that unblocks pending work:
  both ACP transport request timeouts (transport.ts), the internal
  generator dispatch deadline (internal-dispatch.ts), the three dispatch
  tool timeout timers (tools/dispatch.ts), the dispatch drain grace
  (dispatch/extension.ts), and the worker escalation timeout
  (worker-runtime.ts). Every one is bounded and cleared on all resolution
  paths, so ref'ing them can never outlive the work they guard. Periodic
  UI tickers and flush timers keep their unref. CI also gained a `pipx
  install uv` step (ci.yml, release.yml) because the SciCode adapter
  contract grades through uv since 1738c30e.

- **Settle blocked tool display when end event lands under an overlay.**
  P2 root cause: the status reducer swallowed tool_execution_end while an
  overlay phase was visible, and popOverlay restored the stale tool overlay
  and tool_running resumePhase; the fix scrubs the settled tool from the
  status and every stashed overlay frame (state-machine.ts).

- **Loop detector keeps recent attempts and scopes per turn.**
  P3(a) design: retention is windowMs OR last-4-attempts;
  keepLastAttempts=4 is sized so consecutive and single-interleaved spirals
  trip at the threshold while a fix-verify loop (identical check separated by
  two or more calls) stays below it; the detector key is turn-prefixed
  because the ageless floor plus session-long state would otherwise flag one
  identical call per turn across turns. Pinned test "counts the block budget
  per turn, not globally" was minimally edited for this intentional contract
  change (t2 now builds its own streak; per-turn budget semantics unchanged).

- **Exempt session offload reads from the observation pool.**
  P3(c): only the read tool needed the exemption because offload notices
  direct the model to `read` specifically; the exempt reservation is
  untracked but still self-capped per call.

- **Worker subprocesses drain stdout before exiting.**
  P4: drain stdout before exiting worker processes. Write callbacks are
  FIFO, so an empty write's callback fires only after all buffered lines are
  flushed. This ensures large NDJSON lines (e.g., big tool results) are not
  truncated mid-line on process exit (entry.ts, ndjson.ts).

- **Notices no longer emit a synthetic agent_end.**
  P5: emitStreamingNotice was collapsed into emitNotice; run closure is
  guaranteed by pi's handleRunFailure emitting agent_end on abort and
  provider-failure paths, and RunAborted carries abort provenance to the
  status reducer. No pinned tests needed edits.

- **Fix import order in read.ts.**
  Chore: resolved a minor lint warning by correcting the import order of
  isSessionOffloadPath in read.ts.

### Added

- **One-time bash-result nudge names the observe tools.**
  P6: point-of-failure conditioning following the edit-result validation
  nudge (14bfd607); one nudge per session, bounded set, prompt prefix and
  tool schemas byte-stable.

### Deferred

- **Near-duplicate spirals detection.**
  P3(b) DEFERRED: near-duplicate spirals (shrinking read ranges over
  already-returned content) remain invisible; catching them needs result
  content comparison (prefix/substring hashing) beyond the byte-identical
  stagnation detector; no bounded extension was obvious.

### Fixed

- **Worker escalations carry the call's target to the approval overlay.**
  The prior session's Target row (05c543f7) covered only main-agent asks: the
  overlay derives the target from the parked call's args, and worker
  escalations crossed the NDJSON stdout seam with no args, so the operator
  approved or denied a worker's `bash`/`write` blind. The escalation payload
  now carries a `target` string derived at the one place the args exist, the
  worker's `onPermissionRequired` seam in `src/engine/worker-runtime.ts`,
  capped at 200 chars to bound the NDJSON line. The description and
  sanitization logic moved from `src/interactive/permission-overlay.ts` to a
  shared `src/domains/safety/call-target.ts` (`describeCallTarget`, new
  `sanitizeCallTargetText`); the overlay module re-exports both, so its
  public surface is unchanged. The dispatch extension forwards the field into
  the `PermissionRequested` bus payload, and the TUI re-sanitizes it at the
  trust boundary before it reaches `ApprovalRequestView.target`, since a
  hostile worker could otherwise style the overlay that approves it. Pinned
  at all three seams: the worker emit (`worker-steer.test.ts`), the extension
  republish (`dispatch.test.ts`), and the overlay render plus stdout-crossing
  sanitization (`autonomy.test.ts`). Boundary check clean; the engine already
  value-imports safety modules.

- **The dispatch board renders live at its granted width.** The board was a
  pre-rendered `Text` baked at 76 columns inside a fixed 80-column overlay.
  pi-tui clamps overlays to the terminal, and `ClioOverlayFrame` pads child
  lines with an empty-ellipsis clip, so on any terminal narrower than the
  overlay the 76-column cards were cut mid-token with no marker: telemetry
  and model ids read as complete data. New `createDispatchBoardView` in
  `src/interactive/dispatch-board.ts` is a stateless component whose
  `render(width)` formats the store's rows at the width the frame actually
  grants, reading rows and the observability snapshot per paint.
  `src/interactive/index.ts` drops the `renderDispatchBoard` re-bake path
  entirely: the 250ms ticker and the dispatch bus handlers now just request a
  repaint, and the overlay opens at `min(96, columns - 4)` (floor 44) so
  narrow terminals get a near-full-width board and ultrawide ones keep
  readable cards. The empty state centers across the true content width
  (the old `- 4` predated the frame handing in content width). Exercising the
  card at 44 columns exposed that the `status` and `telemetry` rows still
  clipped without a marker ("total 5" for a 5.2k total; a value-less trailing
  "cost"); both now refit by whole units through the same `fitUnits` grammar
  the proof row uses, via a shared `cardUnitsLine`. Pinned by three contracts
  in `tests/contracts/dispatch-board.test.ts` (width obedience at 44/60/76/96
  with no cut escape sequences; rows and proof state read live after
  construction; narrow rows close on a whole unit or ellipsis, never a
  mid-number clip). Verified in the real TUI via tmux: the board opens at 96
  columns on a 200-column terminal and re-renders cleanly at 80.

- **Context meters portray the autocompact reserve and unknown windows
  truthfully.** The proportional meter rendered reserve cells with the same
  filled glyph as consumed context, only dimmed, so an 85%-used window with a
  15% reserve was indistinguishable from a 97%-used one wherever color was
  weak or absent. `contextCategoryGlyph` in `src/interactive/context-meter.ts`
  now assigns the reserve its own `GLYPH.contextReserve` medium-shade block
  (`filled / reserve / free` are three distinct glyphs), which flows through
  the footer bar, the expanded quadrant, the /context-view overlay grid, and
  every legend swatch from the one shared helper. The unknown-percent grammar
  was also split across surfaces (`?%` in the compact footer, `--%` in the
  expanded quadrant, segmented bar, and overlay); a shared
  `formatContextPercent` in `src/interactive/theme/labels.ts` now renders `?%`
  at all four sites, dim in the footers because it is scaffolding for a number
  that has not arrived. Pinned by `tests/contracts/context-meter.test.ts`
  (glyph distinctness, bar/grid/swatch alignment, grammar) and the updated
  segmented-bar assertion in `tests/contracts/footer-redesign.test.ts`.

- **Ultrawide expanded-footer quadrants share surplus width instead of
  starving CONTEXT.** `expandedWideColumnWidths` capped the four columns at
  30/34/36 and gave every remaining cell to ACTIVITY, so a 200-column
  terminal rendered a 91-cell ACTIVITY column of mostly blank space while
  CONTEXT clipped its fill chips, chat chips, and legend at 36. Caps are now
  40 (WORKSPACE), 44 (SESSION), and 56 (CONTEXT) with the same
  CONTEXT-first round-robin, so surplus spills into ACTIVITY only after every
  quadrant reaches its useful size; the context meter grows to 24 cells in
  quadrants at least 48 wide; and the ledger legend packs its category chips
  into as many full rows as the quadrant needs (`ledgerLegendRows`) instead
  of clipping tail categories behind an ellipsis. The helper is exported and
  directly tested (exact allocations at 120/200/240, exact-fill property),
  and the dashboard overflow contract now also runs at 200 and 240 columns.
  Verified with a deterministic render harness at 80/120/200 using a real
  262K ledger with a live reserve.

### Added

- **v0.2.8 Documentation Alignment.** Conducted a thorough documentation pass aligning the entire markdown corpus with v0.2.8 reality. Introduced two new guides: `docs/worker-dispatch-mechanics.md` covering worker subprocess spawning, standard input/output NDJSON protocols, watchdog heartbeats, and permission escalations, and `docs/provider-adapter-cookbook.md` detailing the custom model runtime adapter interface, probing APIs, client factories, and reasoning formats. Corrected and updated all core tools, configs, and TUI design reference files.

### Added

- **Internal generator dispatch deadline.** A live `clio context wiki
  --update` against a local llama.cpp target ground for over an hour with no
  end in sight: the documenter model fell into a blocked-call retry spiral
  (its timeout receipt later showed 17 allowed against 116 blocked calls),
  and nothing bounded it, because loop-guard blocks do not consume the worker
  tool-call cap and a continuously streaming model keeps the heartbeat
  watchdog satisfied. New guardrail `internalDispatchTimeoutMs` (default
  fifteen minutes, env `CLIO_INTERNAL_DISPATCH_TIMEOUT_MS`) arms a wall-clock
  deadline in `src/cli/internal-dispatch.ts`, shared by the wiki documenter
  (`src/cli/wiki-generate.ts`) and the bootstrap scout
  (`src/cli/bootstrap-generate.ts`). On expiry the run is aborted through the
  dispatch contract's timeout convention, so the receipt seals as
  `outcome=canceled` with the timeout in `outcomeDetail`; `.clio/wiki`
  promotion is untouched and staging/lock cleanup behaves as on any failed
  run. Verified live: a 3-minute override aborted a real documenter run on
  the `mini` target at exactly 180s with clean containment. Known remaining
  gap: user-dispatched fleet workers without an explicit `timeout_ms` can
  still spiral on blocked calls indefinitely, since blocked attempts do not
  count toward `workerToolCallCap`.

### Fixed

- **Blocked tool errors now carry the policy's recovery guidance to the
  model.** Live evidence: a `read .env` probe against mini/Qwopus3.6-35B drew
  five blocked calls in one turn because the model retried the same target
  through bash (`cat`, `ls -la`, `stat`) after the read block. The model-visible
  error was only `rejection.short` (`read blocked: read`): the single throw
  seam at `src/engine/worker-tools.ts` (runValidatedToolCall, shared by the
  orchestrator agent bridge and workers) threw `verdict.reason` and dropped
  `rejection.detail` (the policy engine's authored reasons, including
  model-actionable text such as the zero-access bash guidance) and
  `rejection.hints` (hard-block notices) on the floor. New
  `formatModelRejection(reason, rejection?)` in
  `src/domains/safety/rejection-feedback.ts` composes the verdict reason
  (loop-guard substitutions stay first), the detail lines, the hints, and a
  standing `Do not retry this action through another tool; pivot or report
  the blocker.` instruction, deduplicated line by line. Receipts, telemetry,
  and UI notices keep the terse reason: only the thrown tool error changed.
  Contract tests cover the composition (dedupe, loop-guard head, no-rejection
  degrade) and an end-to-end zero-access read through the real registry.
  This complements the workerToolCallCap bound from the prior session by
  shrinking the spiral at its source instead of only bounding it.

- **Blocked tool calls now settle in the interactive transcript.** The
  previously deferred blocked-tool render finding is resolved with the exact
  trigger reproduced in a deterministic replay test. Root cause: a mid-turn
  notice (safety-net block, approval parked, context-engine notice) appends a
  replay-block entry to the chat-panel transcript, so the running tool segment
  no longer lives in the tail entry. The `tool_execution_end` handler then
  called `ensureAssistant()`, which CREATED a fresh empty assistant entry and
  searched only that entry for the tool-call id, so the end event (which pi
  does emit for blocked tools) never reached the stranded segment; the
  `agent_end` settle also walked only the tail entry. Every blocked call
  produces exactly this notice-split, which is why blocked calls specifically
  leaked counting `Running` spinners while successful calls settled. Fix in
  `src/interactive/chat-panel.ts`: a cross-entry `findToolSegment` (backward
  scan, unfinished segments win over finished so a model-reused id binds to
  the live call) now serves `tool_execution_end` and `tool_execution_update`;
  the id-reuse orphan settle at `tool_execution_start` sweeps every assistant
  entry; and `agent_end` settles unfinished segments and clears
  `pending`/`statusLine` across the whole transcript, so no earlier entry
  keeps rendering live thinking or status after the run ends. Blocked calls
  keep the unified error grammar (error glyph plus fixed duration) since the
  result text already names the block; no separate blocked glyph. Four replay
  tests in `tests/contracts/chat-panel.test.ts` pin the notice-split end
  routing, the stranded-orphan settle at `agent_end`, update routing across
  the split, and reused-id settling across entries, each asserting the
  settled transcript renders time-invariant. Verified live against
  mini/Qwopus3.6-35B: five safety-net-blocked calls (`read .env`, three bash
  probes, `credential_present`) each settled to `... ✗ · <ms>` with the
  notice rendered between turns and no counting spinner.

- **Worker IPC amplification fixed with a worker-only stdout event
  projection.** The dispatch worker subprocess forwarded every pi `AgentEvent`
  verbatim to NDJSON stdout (`src/engine/worker-runtime.ts` subscribe sink ->
  `src/worker/ndjson.ts`). pi's `message_update` carries the full cumulative
  assistant message twice: the top-level `message` (AgentMessage) and the nested
  `assistantMessageEvent.partial` (AssistantMessage). Both are re-serialized on
  every streaming delta, so a long worker response amplified stdout
  quadratically. A scratch reproduction reproduced the receipt `2runue8q1v7q`
  postmortem magnitudes: 71.9x for a 1KB response, 530.8x for 10KB, 230.4x for
  44KB, and 2570x for 100KB. No worker-stdout consumer reads either cumulative
  snapshot. The dispatch board reads only `assistantMessageEvent.type` for
  first-token latency (`src/interactive/dispatch-board.ts`); the streamed answer
  and the finish contract are reconstructed from the last assistant `message_end`
  (`src/tools/dispatch.ts`, `src/domains/dispatch/extension.ts`); token
  accounting reads `message_end.message.usage`. The in-process orchestrator
  surfaces that do render `assistantMessageEvent.partial` live (chat-loop, ACP
  server, status state machine) subscribe to their own in-process Agent and
  never cross the worker NDJSON seam, so the fix is scoped to the worker. New
  `src/worker/event-projection.ts` exposes `projectWorkerEventForStdout`, which
  strips the two per-delta cumulative snapshots while keeping
  `type`/`contentIndex`/`delta`; `src/worker/entry.ts` applies it at the emit
  seam before `emitEvent`. Every non-`message_update` event
  (`message_end`/`agent_end` transcripts, `clio_*` events, `heartbeat`, and
  unrecognized events) passes through byte-identical, so unknown-event
  passthrough and terminal reconstruction are unchanged. Pinned by
  `tests/contracts/worker-event-projection.test.ts`, which asserts the strip,
  the retained delta, first-token discriminant preservation, load-bearing and
  unknown passthrough, and a quadratic-to-linear byte property. Verified live: a
  real `clio run --agent debugger --json` dispatch on openai-sub/gpt-5.4-mini
  streamed 313 `message_update` events with zero cumulative `partial`/`message`
  fields, a max `message_update` line of 1623 bytes, and reconstructed the full
  1511-character answer from `message_end`. Remaining follow-up: the
  malformed-stdout-on-abort half of the original finding, where a large NDJSON
  line can be truncated when `process.exit` races buffered stdout, is far less
  likely now that lines are slim but is not eliminated; a stdout
  drain-before-exit is a separate, smaller mitigation.

- **Worker blocked-call spirals now hit the worker cap.** The remaining
  dispatch hardening gap was that rejected attempts were observed for loop
  detection but did not let `workerToolCallCap` become the final verdict when
  policy or the worker permission posture had already denied the call. A weak
  model could therefore keep requesting distinct denied tools forever unless a
  wall-clock timeout was present. `src/engine/loop-guard.ts` now emits the
  stable bound reason `workerToolCallCap reached (N); abort run`, and
  `src/tools/registry.ts` lets that specific guard result override rejected
  attempts with the same `guard_block` blocked verdict shape used for
  admitted guard blocks. `src/engine/worker-runtime.ts` treats that finish
  event as terminal, aborts the worker agent, writes the bound to stderr for
  receipt diagnostics, and exits nonzero. The orchestrator's synthesis
  lockout/backstop behavior is unchanged; the new terminal cap applies to
  dispatched workers. Pinned by a faux-runtime worker contract test covering
  a denied-call spiral and a dispatch receipt test asserting
  `outcomeDetail` names `workerToolCallCap`.

- **Wiki update progress is visible again.** `src/cli/wiki-generate.ts` no
  longer silently drains the documenter worker event stream: it emits compact
  progress events for documenter start, tool start, and tool finish with
  elapsed time while still draining every event for dispatch finalization.
  `src/domains/context/wiki/generate.ts` threads the existing context progress
  sink into the model generator, and `src/cli/context.ts` prints terse stderr
  lines for `clio context wiki --update`. A contract test pins the documenter
  progress stream.

- Fixed receipt accounting for guard blocks. A battletest run surfaced a
  failed documenter receipt with `toolStats.git.blocked=1` but
  `safety.decisions.blocked=0`: the loop guard had blocked a repeated `git`
  call after policy admission allowed it, and `runSpec` in
  `src/tools/registry.ts` returned the blocked verdict with the original
  allow decision attached. Worker finish events then mapped the call to
  `decision: "allowed"`, so receipts counted a blocked tool attempt with no
  blocked safety decision, and the audit ledger's final row for the call
  stayed `allowed`. The guard-block path now follows the same re-shaping
  convention as the skill-surface and autonomy denial paths:
  `guardBlockedVerdict` re-shapes the decision as a block, replaces the
  net-pass reason code with `guard_block`, and writes a blocked audit
  disposition. `emitFinish` in `src/engine/worker-tools.ts` additionally
  defaults a decision-less blocked outcome (`not_visible` verdicts) to a
  blocked decision so the invariant holds at the producer. Pinned by two new
  contract tests in `tests/contracts/loop-guard.test.ts` covering the
  registry verdict shape and the worker finish-event stream that receipts
  aggregate.

- Fixed reasoning-never local model families so catalog `thinking.mechanism:
  none` stays authoritative when live probes or gateway rows report reasoning.
  LM Studio and OpenAI-compatible adapters no longer replay prior assistant
  thinking blocks, request thinking fields, surface thinking stream events, or
  preserve reasoning-token usage for those models.

### Investigated

- **Worker IPC amplification and malformed stdout.** Receipt
  `2runue8q1v7q` was a native llama.cpp worker run canceled after 180s with
  133 tool calls, including 123 `grep` attempts and 116 blocked attempts. It
  recorded about 4.67M total tokens, mostly cache reads, and one malformed
  stdout line. The IPC path forwards every pi `AgentEvent` from
  `agent.subscribe` directly to worker NDJSON stdout, and pi's
  `message_update` events carry both a cumulative top-level assistant message
  and a nested assistant event with another cumulative partial. Synthetic
  sizing shows this shape can be quadratic within a long response: roughly
  68x amplification for 1KB of 20-character deltas, 532x for 10KB, and over
  200x for a 44KB response even with 200-character chunks. The malformed
  stdout line body is not retained by receipts; the most likely cause is a
  large NDJSON line truncated by timeout/exit while `process.stdout.write`
  still had buffered data. I did not change the IPC stream in this hardening
  patch: the safe fix needs a worker-only event projection and backpressure
  aware flush design so dispatch consumers keep their event contract while
  worker stdout stops reserializing cumulative partials. Update: the
  amplification half is now fixed by the worker-only stdout event projection
  described in the Fixed section above; the backpressure/flush half (the
  truncated stdout line on abort) remains a smaller follow-up.

## 0.2.8-rc - 2026-07-02

The toolkit-rework release candidate: the tool surface was redesigned into seven planes
with 19 tools, every OBSERVE tool now closes through one observation envelope,
and grep/find answer tree visibility from a single ignore policy. Two more
workstreams land alongside it. The approvals plane gained one canonical
lifecycle: every permission ask carries a request id from park to resolution,
worker escalations keep their provenance, denials are scoped to one request,
and receipts grade how faithfully each runtime enforced the autonomy level.
The codewiki was rebuilt on schema v4 with a separate agent-authored wiki
layer under `.clio/wiki/`.

### Added

- **The session task board: the `tasks` tool, the open-tasks nudge, and
  `/tasks`.** The dormant `taskLedger` session-entry kind gains its producer.
  A new ORCHESTRATE-plane `tasks` tool lets the agent declare a titled board
  before multi-step work (`action="plan"`), mark exactly one task active as
  its current focus (`start` parks any other active task back to pending),
  and close each task with a receipt: `done` records an evidence note as
  passed validation evidence on the ledger, `block` requires a reason, and
  `drop` cancels. Every mutation persists a full-snapshot `taskLedger` entry,
  so the board replays from the JSONL alone and survives `/resume` and
  `/fork`; every tool result renders the whole board back to the model so
  local models never track state across turns. A `turn_end` middleware
  registration (`nudge.open-tasks`) carries the turn onward through the
  existing request-continuation channel when a tool-calling turn settles with
  pending or active tasks; pure conversation turns, aborted turns, surfaces
  without the tasks tool, and boards where every remaining task is blocked
  never nudge, and the chat-loop's one-nudge-per-turn guard bounds the rest.
  The board surfaces in the expanded footer's Activity quadrant (progress
  plus the active task), in verb-led transcript sublines with a `n/m done`
  ledger tail, and in the read-only `/tasks` overlay showing per-task
  receipts. Narrow worker tool profiles are unchanged; workers on
  `full-agent` get a private in-memory board. Dispatched runs link to the
  live board through the ledger's `activeRunIds` field: the orchestrator
  attaches a run when its child process goes live and detaches it when the
  run finalizes, so the persisted snapshot and the `/tasks` overlay record
  which fleet runs served the board (linkage is process-live and refolds
  empty on replay). Claude SDK/CLI workers map `TodoWrite` to the `tasks`
  tool rather than `artifact`, so a Claude worker's todo updates land on the
  same evidence-carrying board and stay outside a narrowed tool profile.
- **Slash command argument completion.** The editor now completes past the
  command name by walking the same args grammar the parser uses: subcommand
  names complete in first position with their flags as the row hint, declared
  flags complete wherever the grammar still parses flags (spent flags drop
  out, and unmatched tokens fall back to aliases so `--rew` completes to
  `--rewrite`), and closed value sets complete inside a flag's value slot.
  Alias spellings like `/ctx` complete exactly like their canonical command
  while accepting keeps the typed alias. Top-level suggestion hints shrink to
  fit the row: subcommand commands list their subcommand names and flag
  commands elide overflow behind an ellipsis, all within a pinned budget, so
  the old 150-character `/context` pipe chain no longer hard-clips mid-flag.
- **First-turn skills reminder.** Once per session, on the first substantive
  task turn, when model-visible skills exist and the operator has not already
  requested one, middleware injects a single visible line into the user
  message: the skill count, the instruction to list the catalog with
  `context(scope="skills")` on process-shaped tasks, and the exact
  suggest-and-wait reply shape (`Suggested skill: /skill:<name>`). The
  skill-mastery batteries proved local models ignore every ambient prompt
  channel but comply with user-message text; this is that channel, once,
  teaching the same protocol as the listing footer. Loading stays
  operator-gated; nothing changes in `pendingSkillPolicy`.
- **Skill-load denials name the model's next move.** A
  `context(scope="skills", name=...)` call without a pending operator request
  used to be denied with a message that named the gate but no compliant next
  step, and a live demo showed a local model burning three identical denied
  calls in one turn. The plumbing was sound (root cause: plain-language asks
  mint no pending request by design, and the denial taught nothing); the
  denial now says only the operator can activate a skill, not to retry, and
  to open the reply with the `Suggested skill: /skill:<name>` line and wait,
  or continue without skills. The suggestion anchor is one shared constant
  across the listing footer, the first-turn reminder, and the denial.

- **Per-session prompt manifest.** Every prompt compile whose text changed
  appends one record to `prompt-manifest.jsonl` next to the session's
  `current.jsonl`: system-prompt hash, previous hash, token estimate, the
  thinking dial active at compile time, per-section token estimates, and
  per-fragment content hashes. A finished session's stored artifacts alone
  now state exactly which prompt the model received, and two sessions diff
  without recompiling anything. The manifest never stores prompt text.
  Headless receipts already carry `compiledPromptHash` and the
  requested/effective thinking level via `runtimeResolution`; the session
  manifest closes the interactive and section/fragment gap.
- **Eval artifact provenance, suite v2, and public benchmark manifests.**
  `clio eval run --task-file` now stores redacted provenance with Clio version,
  commit, entrypoint, platform, Node version, target, model, thinking level, and
  linked receipt or session paths when they are present. The eval domain also
  supports version 2 suites through `clio eval validate`, `run`, `report`,
  `compare`, and `gate`, with runner kinds for Clio headless runs, context
  indexing, context initialization, and external commands. Reports render as
  text, JSON, Markdown, SWE JSONL, and JUnit XML. Public examples live in
  `examples/evals/`, while private suite seeds and the external-suite workflow
  are documented in `docs/evals-internal.md`. Benchmark adapters now emit
  sanitized `manifest.json` and `summary.json` files per run, and the tracked
  benchmark tree is limited to public adapters plus sanitized result records.
- **Toolkit v2: seven planes, 19 tools.** The surface is organized as OBSERVE
  (read, grep, find, ls, code_nav, context, credential_present), MUTATE
  (write, edit), EXECUTE (bash, git, verify), ORCHESTRATE (dispatch, monitor,
  steer, tasks), RETRIEVE (web_fetch), INTERACT (ask_user), and ARTIFACT
  (artifact).
  Each plane is one policy unit for action class, size posture, details
  schema, and concurrency. Consolidations: `find` absorbs `glob` (same
  pattern dialect, plus `order="mtime"` for recency); `context` absorbs
  `workspace_context`, `docs_search`, and `read_skill` behind
  `scope=workspace|docs|skills`; `verify` absorbs `run_task` and
  `validate_frontend` (`verify()` lists declared checks); `artifact` absorbs
  `write_plan`, `write_review`, and `create_skill` behind
  `kind=plan|review|report|skill`, adding the new terminal `report` kind; and
  `dispatch` absorbs `dispatch_batch` with a `tasks` array and
  `mode=parallel|sequential|pipeline`. The `gateway` name is design-reserved
  for the future MCP/DB proxy and is not implemented.
- **dispatch pipeline mode.** `dispatch(tasks, mode=pipeline)` runs tasks one
  at a time and threads each step's final assistant output to the next step as
  a delimited dynamic prompt message treated as data, not instructions (step 1
  receives none). The threaded text is capped at 12000 characters and the
  receiving run's receipt carries `pipeline` provenance (`fromRunId`,
  `position`, `inputBytes`, `inputTruncated`). A failed step halts the chain
  and later steps are reported as skipped. Threading rides the existing
  dynamic-message channel only, so worker static prompt hashes
  (`staticCompositionHash`) are byte-identical with pipeline mode on or off.
  This changes the `dispatch` tool's parameter schema (the `mode` enum gains
  `pipeline`) and its description, which invalidates provider prompt caches on
  first use after upgrade.
- **dispatch ad-hoc specialists.** Dispatch task objects can now include
  `persona` and `tool_profile` to compose one bounded specialist at dispatch
  time. `persona` replaces the recipe body inside the existing stable worker
  shell (8000-character cap; rejected for shadow and ACP delegation agents),
  while `tool_profile` narrows tools through
  `minimal-local|science-local|full-agent`. Composed runs carry
  `personaOverride.promptHash` on the run ledger and receipt, equal to the
  composed run's `staticCompositionHash`; recipe runs remain byte-identical
  and omit the field. This changes the `dispatch` tool's parameter schema and
  description, invalidating provider prompt caches on first use after upgrade.
- **Worker permission escalation.** A third worker permission posture,
  `workers.onPermission=escalate`, lets a dispatched worker hand a parked
  permission ask up to the interactive operator instead of auto-denying or
  failing. The worker emits `clio_permission_escalated` on its event stream;
  dispatch republishes it on the bus tagged with the run id; the operator
  resolves it in the TUI permission overlay (labeled with the worker's agent
  and run id); and the decision returns down the worker's stdin as a
  `permission_decision` line (the same pipe steers use). Resolution is
  human-only: no model-facing tool can approve a worker permission. A
  `workers.escalation` (`{ timeoutMs, fallback }`, defaults 120000 ms and
  `deny`) timeout fallback guarantees the run never hangs, and headless
  sessions with no subscriber always resolve by that fallback. Each escalation
  and its resolution source is tallied on the receipt's `safety.decisions`
  escalation counters. Existing `deny`/`fail` behavior is unchanged, and no
  tool schema or prompt text changed. ACP delegations are out of scope.
- **One approval lifecycle: canonical request identity and resolution
  provenance.** Every approvable permission ask now mints a `requestId` at the
  approvals plane and resolves exactly once. `PermissionRequested` and
  `PermissionResolved` bus payloads carry `requestId`, `origin`, `axis`, and
  `decidedBy`; audit permission rows record the same fields, so a request
  joins its resolution on one key across the bus, the ledger, and receipts.
  The ACP server bridge emits a resolution for every client grant, denial,
  and timeout instead of leaving dangling request rows, headless auto-denials
  carry the id, and remote ACP server sessions snapshot the autonomy level at
  `session/new` so a mid-session settings change cannot alter an in-flight
  remote session's admission decisions.
- **Worker escalations keep their provenance.** The dispatch republish
  forwards the worker decision's reasons, reason code, rule id, and policy
  source; escalation requests are audited as `status: "requested"` permission
  rows (previously that enum value had no writer); and the permission overlay
  renders from a real approval-request view instead of reconstructing a fake
  safety decision, so a worker ask can finally say it came from a named
  safety-net rail such as command substitution rather than a generic autonomy
  label.
- **Autonomy enforcement grades on receipts.** Worker receipts carry an
  optional `autonomyEnforcement` block grading how the runtime honored the
  autonomy model: `mediated` (per-call evaluation through Clio's net and
  autonomy), `approximated` (posture mapped to external harness flags with no
  per-call mediation), or `bypassed` (`CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`
  dangerous modes), sealed into the v3 integrity digest. Evidence raises a
  warn-level external-bypass finding when a run skipped Clio safety via the
  bypass flag and an info-level approximation note otherwise, and the
  provenance projection surfaces the block in `transcript.md`,
  `trace.cleaned.jsonl`, and compact dispatch output. ACP delegation receipts
  are unchanged.
- **Benchmarks.** A HumanEval community adapter joins the benchmark set, and
  the Python adapters now run through `uv`.
- **monitor and steer.** `monitor(run_id?, mode=list|status|peek|receipt)`
  inspects dispatched runs, including an in-process rolling event tail
  (`peek`) and the stored receipt JSON (`receipt`, 14KB cap).
  `steer(run_id, action=guide|cancel)` sends mid-run guidance over the
  dispatch contract's stdin steer channel (native workers) or aborts a run,
  with `outcome=canceled` recorded on the receipt. Parent-model mid-run use
  requires detached dispatch ids; the operator/TUI can address an active
  synchronous native run directly through the dispatch contract.
- **Observation envelope.** All six sized OBSERVE tools report truncation
  through one notice line with an exact continuation call
  (`[grep: 100/1000+ matches shown (16.0KB of 120KB) | full: <path> |
  next: limit=200]`), offload the full rendering to the session scratch
  directory when the byte cap cuts collected content, and share one 192KB
  per-turn output pool (`CLIO_OBSERVATION_TURN_BUDGET_BYTES`). JSON-format
  tools (code_nav, context docs/workspace) never truncate mid-document: an
  oversize payload is replaced whole by a parseable
  `{"error", "offloadPath", "next"}` stub, and empty results are valid JSON
  with a populated `next`.
- **`/export`.** Writes the session transcript to Markdown at
  `.clio/exports/<sessionId>-<date>.md` (or an explicit path) with all tool
  segments expanded and ANSI escapes stripped.
- **Deep per-tool usage docs.** Rich usage guidance moved out of non-hot tool
  descriptions (now one sentence each) into `docs/tool-usage.md`, retrievable
  section by section through `context(scope="docs")`.
- **Receipt provenance on evidence and dispatch surfaces.** Evidence bundles
  now render a receipt's `pipeline`, `personaOverride`, and escalation-counter
  provenance in `transcript.md` (human sentences), `trace.cleaned.jsonl`
  (structured run rows), and the `clio evidence inspect` output, and a
  timed-out or denied escalation raises a new `escalation` finding. The
  `dispatch` tool appends a compact provenance suffix to each run line and adds
  matching keys to `details.runs[]`. A receipt without these optional fields
  renders byte-identical to before. `docs/observability.md` gains a
  receipt-provenance schema table labeling every new field `experimental`. No
  receipt shape, tool schema, or prompt text changed.

### Added (context wiring)

- **`/context refresh` and `clio context refresh`.** The cheap staleness fix:
  rebuilds the codewiki index and restamps the CLIO.md fingerprint footer
  (gitHead/treeHash/loc) without touching any handbook prose. The stale
  codewiki marker in the compiled prompt now points at `/context refresh`
  instead of `/context-init`.
- **Preload class visibility.** `/context init` output now reports how the
  session prompt will treat project context: `preload: full (N.NkB, N lines)`
  or `preload: synopsis (reason: size|lines)`, warning when a full preload is
  within 10% of the 8000-char/220-line cliff. The same class appears in
  `clio config inspect` (CLIO.md entry detail) and as a `project preload:`
  line in the `/context` overlay.
- **Worker context injection.** Dispatched workers with capability class
  `workspace-edit`, `verification`, or `artifact-write` now receive a bounded
  dynamic prompt message with the project name, conventions, and hard
  invariants from CLIO.md (1500-char cap, conventions truncated first), and
  every worker run (including ACP delegation) receives a one-line
  safety-posture message stating its effective autonomy level. Both ride the
  dynamic prompt-message channel, so worker static prompt hashes
  (`staticCompositionHash`) are unchanged. Read-only and shadow recipes get no
  project message.

### Changed

- **Codewiki v4 rebuild.** The structural codewiki index is smaller and more
  navigable: schema v4 stores per-file hashes, imports, and optional summaries,
  keeps declaration-only symbols, writes compact JSON, and runs one unified
  async tree-sitter-first pipeline with per-file regex fallback and C# coverage
  across the ten-language set. Incremental updates now replace only changed
  indexed paths and rebuild edges, while `.clio/state.json` records
  `codewikiVersion` and uses the mtime-aware fingerprint plus the single
  `isStale` tree-hash predicate for refresh decisions. A new explicit wiki
  layer writes agent-authored `.clio/wiki/` pages with `quickstart.md` as the
  hub, at most eight pages, and `meta.json` carrying git head and content hash;
  generation runs only through `clio context wiki`, `clio context wiki
  --update`, or `clio context refresh --wiki`, with `--status` read-only. Prompt
  markers, `code_nav mode=wiki`, `clio context` digest output, and the welcome
  dashboard now surface codewiki/wiki availability and staleness without
  embedding the artifacts. Existing repositories perform one full re-index after
  upgrade because the new fingerprint format and v4 per-file hash/import
  backfill make old artifacts stale.
- **`system_modify` asks are attributed to the safety net, not the autonomy
  level.** The level-invariant confirm on system-level changes moved from
  `mapAutonomy` into the policy engine as a net confirm rail. Outcomes are
  unchanged at every level on every surface, proven by a pre-committed autonomy
  admission matrix test that passes byte-identical across the move; only
  attribution changes. The overlay, notices, and audit ledger now name a
  safety-net rail instead of the autonomy level, and these asks carry
  `reasonCode: system-modify-confirm` with `policySource: builtin-classifier`
  rather than autonomy-adjacent codes.
- **Denying an approval rejects one request, not the whole queue.** Denying
  the permission overlay now rejects only the presented request and advances
  the queue; the next parked call re-presents instead of being cancelled with
  it. One-shot grants reference the `requestId` they were issued for rather
  than matching the oldest parked call by action class. Cancel-all remains the
  behavior for shutdown, headless runs, ACP transport failure, and non-stall
  timeout paths. Worker escalation tallies may now show more requested and
  denied entries per run where cancel-all previously collapsed them into one.
- **Dispatch refuses `suggest` on approximated subprocess runtimes.**
  Deliberate behavior break: the `claude-code` and `antigravity-code`
  subprocess runtimes now fail closed at autonomy level `suggest` instead of
  silently degrading to read-only. A subprocess cannot park a tool call for
  approval, so `suggest` has no honest mapping there; the runner throws before
  launching the external CLI. Dispatch to a native or `claude-sdk` worker, or
  use `read-only` or `auto-edit`.
- **Settings expose `workers.onPermission=escalate`, and autonomy copy matches
  enforcement.** The settings center now cycles `deny`/`fail`/`escalate`
  (previously the most operator-friendly mode was reachable only by
  hand-editing settings.yaml), the `auto-edit` and `full-auto` value help now
  state what actually runs and what still asks, and the help-center autonomy
  topic describes autonomy as harness-enforced admission across four layers
  (tool surface, safety net, autonomy level, approvals) instead of a
  prompt-initiative knob.
- **TUI design system.** Every interactive surface moved onto one presentation
  system, recorded in `docs/tui-design.md`: one token vocabulary, one glyph per
  meaning, one formatter per quantity, one island frame, one status color per
  region. Per surface:
  - Theme: `highlight` renamed to `action` (orange means Clio is acting), the
    unused `loop`/`effortMedium`/`effortHigh` tokens deleted, every glyph
    centralized in `theme/glyphs.ts`, and a contract test bans raw SGR and hex
    color outside `theme/`.
  - Formats: `formatCompactMs` for every duration, `formatFooterTokens` for
    every token chip, the shared `formatUsd` for money, and
    `abbreviateModelId` keeps whole dash-separated parts so `claude-sonnet-5`
    survives intact.
  - Frames: welcome dashboard, task island, steering queue, and dispatch cards
    share the one `frame()` island recipe with a spaced bold title and an
    optional dim right meta.
  - Transcript: the agent speaks behind a `✦` star, failed turns paint the
    glyph and terminal error text red, the tool subline tail
    (`✓ · 230ms (ctrl+o)`) never splits across wrapped lines, and
    replay/system notices carry dim tags with muted text.
  - Footer pill: live phases show the spinner or a static glyph, never both,
    and the tool label is no longer padded into the badge.
  - Dashboard: all four quadrant tags share one structure color, and running
    fleet work joins queued work under action orange.
  - Dispatch cards: key-value grammar with dim keys, `·` separators, muted
    telemetry, and exactly one status color per card.
  - Overlays: fleet and cost overlays adopt list-group headers, dim table
    headers, tokened status cells, and key-value totals.
  - Selection: list overlays point with a dedicated `❯` chevron, and the
    editor rail's thinking hint reads a two-step dim/muted/reason ramp.
  - Code ink: fenced blocks get quiet syntax highlighting from exactly four
    existing tokens (comments dim, strings success, keywords reason, numbers
    info) for ts/js, json, bash, and python, plus semantic diff coloring;
    unknown fences stay plain.
  - Logotype: the `>C_` wordmark in the two headers composes as dim
    scaffolding around a bold accent `C`.
  - Cost overlay: values align on primary numbers, and the cache-read average
    annotation hangs dim after its value instead of dragging the column.
- **TUI design system, the overlay and dialog surfaces.** The hubs, pickers,
  modals, and dialogs that the first pass left on the old look now speak the
  grammar recorded in `docs/tui-design.md`: the `❯` selection cursor, key-value
  rows with dim keys and muted values, `── label` group headers, registry
  glyphs, one formatter per quantity, and ellipsis truncation. Per surface:
  - Model picker: a design-system table whose header renders dim, whose cells
    each keep their own token so selection never clips the model id, and whose
    health cell states its fact in color across a healthy green, degraded amber,
    and down red ramp.
  - Targets hub: the expanded detail block adopts the key-value grammar with dim
    keys and muted values, the collapsed row quiets its runtime, auth, and model
    cells to muted, and the probe error takes its token from severity.
  - Settings center: the footer separator and the lane divider route through the
    shared `rule()` and `barSep()` helpers, byte for byte.
  - Thinking and resume pickers: the current thinking level carries the active
    mark rather than the running dot, an ended session glyphs `✓` while an open
    one keeps the running dot, and every mark comes from the registry.
  - Tree navigator: rows read state from color with a dim glyph and kind, a
    muted turn id and preview, an accent chevron on the focused row, and a
    timestamp column that measures on visible width so alignment holds.
  - List overlays: the shared chrome points with the `❯` cursor, dims its group
    headers, mutes empty states, draws its detail divider from the frame token,
    and truncates with an ellipsis; the prompts, skills, agents, extensions, and
    help surfaces inherit it and mark their diagnostics with the shared warning
    and error glyphs.
  - Ask-user modal: the question body stays plain while the progress strip,
    status, summaries, and option rows render through the selection grammar and
    the `❯` cursor, with the focused row bold accent.
  - Auth and small dialogs: the auth dialog tokens its status rows, prompts, and
    manual choices; the auth selector and cwd fallback keep SelectList as the
    behavior owner behind design-cursor rows with muted previews; and keybinding
    detail reads as dim labels, muted values, accent key affordances, and the
    shared warning glyph.
  - View overlay: artifact headers render local `HH:MM:SS` timestamps, themed
    metadata, and registry verification glyphs, and dispatch and compaction
    loads reuse the shared token, cost, and model-id formatters instead of raw
    receipt fields.
- **`context(scope="docs")` with no query lists the corpus instead of erroring.**
  Omitting the query used to return `context: scope=docs requires query`,
  costing the model a wasted round before it could search. It now returns the
  corpus listing — the file set plus doc and section counts, the same `corpus`
  shape a search already carries — so the model can pick a search term from the
  index in one call. Bounded (the corpus is a handful of files); a query still
  runs the ranked search as before.
- **Skill awareness across the prompt and tool surfaces.** Four wording-level
  nudges now incline the main agent to surface installed skills: the
  operating contract carries a static Skills passage (skill-shaped tasks,
  suggest `/skill:<name>` or the sequence when skills compose), the Tool
  Contract adds a base line to list skills once for a multi-step task, the
  `context` tool hint says to suggest a matching skill and never load one
  uninvited, and the `context(scope="workspace")` snapshot carries a one-line
  pointer at the skill catalog when skills are installed. The
  `context(scope="skills")` listing header now invites matching against the
  current task and sequencing composable skills. Dispatch side: the fleet
  catalog tells the orchestrator to prefer a recipe whose bound skill
  (`skills=...`) matches the task, and the architect recipe description names
  its cut-it sprint-slicing domain. The operator gate is unchanged
  everywhere: suggestions only, loading still requires an explicit operator
  request. Compiled prompt text changes; local prompt-prefix caches
  invalidate once on upgrade.
- **Battletest harness moved out of the repository.** The battletest release
  suites and legacy oracle now live in gitignored `.superpowers/battletest/`
  local dev scratch.
- **Registry-owned tool prompt hints.** The per-tool guidance sentences in the
  session Tool Contract (code_nav, context, dispatch, ask_user) moved verbatim
  from a compiler if-chain onto the tool registry metadata
  (`ToolMetadata.promptHint`); the compiler now renders whatever hints the
  frozen surface carries, sorted by tool name. Deliberate one-time prompt-text
  change: the ask_user hint moves from last to first among the hints, so the
  compiled system prompt bytes shift once at upgrade and local prompt-prefix
  caches re-prime on the first session.
- **`/context` command hub.** One command now owns both context nouns.
  `/context` with no arguments opens the context-window ledger overlay
  (previously `/context-view`); `/context compact [instructions]` replaces
  `/compact`; `/context init [flags]` replaces `/context-init` with the same
  flags; `/context refresh` re-indexes the codewiki and restamps the CLIO.md
  fingerprint footer; `/context reset [--all] [--confirm] [--confirm-all]`
  replaces `/context-clear` and its confirm prompt now names the exact paths
  deleted and states that CLIO.md is preserved without `--all`. The old
  spellings still parse for one release, hidden from help and autocomplete,
  and print a one-line deprecation notice. Session reset stays `/new`.
- **Ignore coherence.** grep and find answer "which parts of the tree are
  visible" from one shared policy: `.gitignore` is honored natively by rg/fd,
  `.clio`/`.fallow`/`.git` are always excluded, one generated-dirs list
  (node_modules, dist, build, coverage, .venv, ...) is force-excluded, and
  `include_ignored=true` lifts the gitignore and generated layers together on
  both tools. Pointing a tool directly at an excluded directory keeps it
  visible.
- **Spawn hygiene.** rg and fd run with an allowlisted environment, pinned
  cwd, a 30s wall-clock timeout, and SIGTERM-then-SIGKILL teardown.
- **Bash spawn cost.** Every bash call used to source the login profile chain
  (`/bin/bash -lc`): ~10ms per call on a lean profile and hundreds of
  milliseconds with nvm/conda in it. The login environment is now captured
  once per process and reused, so each call spawns a plain `bash -c` with the
  profile-shaped PATH; the shell itself stays fresh per call (no state
  bleed, unchanged kill and timeout semantics), and capture failure falls
  back to the old per-call `-lc`.
- **TUI ledger.** Finished tool calls collapse to one line carrying the call
  signature, outcome counts, bytes, duration, and the offload path when
  truncated; resource reads (SKILL.md, CLIO.md, AGENTS.md, docs/) stay
  collapsed to a labeled line; running tools show live elapsed time.
- **Performance.** glob's full-tree synchronous lstat walk is gone;
  `find(order="mtime")` stats only a bounded candidate set and reports the
  cap in `details.candidates`; grep context lines come from rg's `--json`
  stream instead of a second read.

### Fixed

- **Hard blocks precede damage-control asks, and the built-in path policy
  survives a malformed project policy.** Damage-control ask rules no longer
  bypass hard blocks: the ask rail now runs only after the invalid-policy
  fail-closed block and the full path-policy section, so confirming an
  ask-rule command that targets a zero-access path, or running one under an
  invalid config, still blocks. The path policy is evaluated regardless of
  project-policy validity, so built-in credential protection stays active when
  `.clio/safety.yaml` is malformed instead of failing open for typed
  read/write/edit. The audit writer also drops its per-row fsync (rows stay
  visible in-process through writeSync) and fsyncs on flush, close, rotation,
  and a 5s unref'd interval, removing two fsync stalls from every tool call.
- **Permission-queue robustness.** Seven audit findings closed in one pass. A
  parked main-agent call is re-presented after any overlay closes, so a call
  that parks while a worker-escalation overlay is open no longer hangs. The
  worker overlay opens only for a live escalation, so policy-denied worker
  asks under the default deny posture no longer pop a dead overlay. Parked
  calls subscribe to the run abort signal and a cancelled turn clears the
  queue, so a stale call cannot resurrect later. Requested-audit rows and
  parked notices dedupe by `requestId` across tail re-notifies. A worker abort
  emits a denied escalation resolution so receipt tallies balance. Approval
  request ids carry a per-registry random token so concurrent workers cannot
  collide. The ACP bridge emits a denied resolution for every queued request
  before a cancel-all on no-session or transport failure.
- **Safety path checks canonicalize through symlinks.** Path-policy and
  protected-artifact evaluation resolve symlinks before matching, unsupported
  subprocess permission mediation modes are rejected instead of silently
  approximated, and compaction and usage-report edge cases around the same
  paths are hardened.
- **The compact ctx ledger row joins the kv grammar.** Its `ctx` key reads
  dim and the percent muted, and the pre-measurement `?%` placeholder reads
  dim instead of rendering as bare text.
- **The loop guard forces a final answer instead of killing a turn that already
  holds it.** A live session asked how CLIO.md bootstrapping works; the model
  ran nine successful retrievals (the exact answer landed four times) and then
  fixated on one identical grep. At the second loop block the guard hard-
  cancelled the turn, so a turn holding the answer ended with a message telling
  the operator to re-prompt. Reaching the per-turn block budget no longer
  cancels: it locks tool use for the rest of the turn and denies every further
  call with a synthesize-now directive, so the model produces a final answer
  from what it gathered. Only a bounded backstop (two post-lockout tool calls)
  falls back to the existing hard stop with its closing message, so a model
  that keeps calling tools instead of answering is still bounded. The behavior
  is identical across the interactive TUI, headless `clio run`, and ACP: the
  guard drives it over the bus with a new `lockout` disposition, and only the
  `stop` disposition cancels. Detection thresholds (three identical calls in
  30s, two blocks per turn) are unchanged; the per-turn tool-call ceiling
  already had this shape (soft budget locks, hard ceiling stops) and is
  untouched.
- **A loop block confronts the model with its own result.** When the guard
  blocks an identical call that already returned a successful result earlier in
  the run, the block reason now says so explicitly — "this exact call already
  succeeded N times; its result is already in the conversation above, re-read
  it before calling tools again" — instead of only asking for a new strategy.
  For a weak local model that anchor is the strongest available nudge: it
  points at the answer it already has. The guard records successful results per
  canonical call fingerprint through an after-tool touchpoint (no threading of
  result bodies through the middleware contract); a call that only ever errored
  gets no false "already succeeded" claim.
- **TUI ledger: blocked tool calls settle, and the running-tool timer owns its
  start.** In the loop-guard incident the TUI showed a blocked grep as a live
  `· 8.3s` line that never settled while the status spinner read
  `Running tool: grep · 19s` — both timers counting time that was not this
  call's runtime, and one call left orphaned while an identical one settled
  normally. A tool call whose `tool_execution_end` never arrives (admission
  block, mid-batch abort, or a model that reuses a tool-call id) now settles to
  the same error line grammar as any failure (`✗ · <its own ms>`): the ledger
  settles the orphan when the run ends or when the id is reused, never leaving a
  counting line. The status footer's `running tool · Ns` timer now counts from
  the call's own `tool_execution_start` rather than from turn start, and the
  running-tool spinner clears the moment the model resumes generating, so it
  never claims a tool is running while nothing executes.
- **The once-per-session skills reminder no longer burns on "hi".** The
  registration's docstring promised the reminder fires on the first
  *substantive* task turn, but the implementation marked any first turn spent —
  so a session that opened with a bare greeting spent its single reminder on
  the greeting and the real task never saw it. A greeting turn now carries the
  shot to the first real task turn instead. The substance test is a small pure
  exported function (`isSubstantiveUserTurn`, table-driven tested) that is
  conservative toward firing: only a short message whose every token is a bare
  greeting/acknowledgement is skipped, so any real task word makes the turn
  substantive. Substantive-first sessions behave exactly as before; the
  reminder still fires at most once per session, never after a substantive turn
  has already passed, never when a skill request is already pending, and never
  on a resumed conversation with history. The reminder text is unchanged.
- **Bash can no longer create files outside the session workspace unnoticed.**
  A full-auto battery run recorded the escape: with the session cwd in a
  fixture copy, `mkdir -p /abs/path && cd /abs/path` built a whole project at
  the clio-coder repo root, because write-target extraction knew redirects,
  `tee`, `cp`/`mv`, and `sed -i` but not directory creation, and nothing
  tracked `cd`. Extraction now covers `mkdir`/`touch` operands and `ln`
  destinations, and any `cd`/`pushd` whose directory resolves outside the
  workspace escalates the command through the same `system_modify` confirm
  gate as an out-of-workspace write target (a `cd` outside re-bases every
  relative path that follows it). The bash tool also pins its `cwd` argument
  inside the session workspace in the tool itself, mirroring the admission
  check, so a directly invoked tool cannot spawn outside either.
  Inside-workspace commands are classified exactly as before. The
  finish-contract inherits the same extraction, so directory creation now
  counts as a turn mutation.
- **Silent double-resident local models are dead.** The residency reconciler
  used to back off to observe-only whenever a resident model was not
  attributed to Clio in-process, so batteries and multi-process runs loaded
  a second large model on top of the operator's resident one and the box
  silently crawled. Policy now: when the requested model is not resident,
  Clio swaps, unloading the resident model with a warning-level recorded
  transition notice (LM Studio and Ollama); when the requested model is
  already resident, extra residents are left alone but reported as
  degraded-inference warnings. `CLIO_RESIDENCY=observe` remains the
  multi-tenant opt-out. llama.cpp router targets get a fire-and-forget
  observer that records the router's own server-side swaps (and double
  residency) through the same notice channel. Headless runs now mirror all
  runtime notices to stderr (they previously had no subscriber, which was
  the silent path). `clio targets --probe` notes gain a `resident:` summary
  from the per-model load states local runtimes already report.
- **Reasoning-off models can no longer be made to think by the dial.** The
  Qwopus Coder-MTP families are thinking-off by design (creator's card) and
  mini's llama.cpp router serves them with `enable_thinking: false`, yet
  `--thinking low` produced reasoning tokens: the catalog marked them
  `reasoning: true` with an `on-off` mechanism, so two per-request paths
  (pi-ai's qwen-chat-template kwargs and Clio's thinking payload) flipped
  `enable_thinking: true` over the server default. The catalog now gives
  every blessed local family a reasoning class derived from its thinking
  mechanism: `never` (Coder-MTP: `reasoning: false`, mechanism `none`; the
  dial clamps to off at every level and no request field is sent),
  `switchable` (Qwen3.6 hybrids, per-dial `enable_thinking`), or `always`
  (Ornith: cannot be silenced). New `qwopus3.6-27b-coder` and
  `qwopus3.5-9b-coder` families keep the 27B/9B Coder ids from falling
  through to reasoning-capable families. When the requested dial cannot
  apply (never-class model at low, always-class at off, on/off coercion),
  one visible notice line now fires where the dial takes effect, and
  receipts carry the reasoning class plus the notice in
  `runtimeResolution.thinking`. Verified live on mini: dial low now yields
  zero reasoning tokens with the clamp notice, dial off unchanged.
- **Clio source-tree awareness no longer leaks into nested repositories.**
  `detectClioCoderRepo` walked every ancestor directory, so a session whose
  cwd was any project nested under a clio-coder checkout matched the
  clio-coder root above it and received the "# Clio Source Tree … own source
  tree" prompt section, confusing models about which codebase they were in.
  The upward walk now stops at the first directory containing `.git` that is
  not the clio-coder root: only a cwd whose own repository is clio-coder gets
  the awareness fragment.
- **Loop guard: the post-budget retry spiral is dead.** Crossing the soft
  per-turn tool-call budget used to short-circuit the guard before the
  identical-call detector, so a weak local model that retried its blocked
  call verbatim could only die 15 calls later at the hard ceiling, and the
  directive it received ("narrow to a single concrete next step … before
  calling more tools") was unfollowable because every further call in the
  turn was also blocked. Detection now runs before the budget check, so
  verbatim retries trip the detector and interrupt after two blocks, and the
  soft-budget directive states plainly that all further calls this turn are
  blocked and to reply with a text summary. The per-turn soft budget default
  rose from 25 to 60 (hard ceiling 75): it is a backstop against
  distinct-call spray, not a ceiling on legitimate deep work such as a
  repo-wide audit.
- **Loop-guard interrupts leave a clean transcript.** The closing "loop guard
  stopped this turn" message is shown live at cancel but persisted only after
  the aborted run's in-flight tool results settle, so the session ledger
  always replays as tool calls, then results, then the closing text; strict
  chat templates reject the old interleaving. The empty aborted assistant
  messages the abort leaves behind are suppressed in both the ledger and the
  live transcript instead of rendering as duplicate "[aborted] Request was
  aborted." noise.
- **Tool profiles enforced on external CLI worker runtimes.** A worker
  dispatched with a narrowing `tool_profile` (e.g. `minimal-local`) on the
  `claude-sdk` runtime could still run out-of-profile tools such as `bash`,
  because the SDK runtime ran its own builtin preset and never consumed the
  admitted `allowedTools` surface (only the native worker registry did). The
  SDK runtime now enforces the admitted surface authoritatively at the Clio
  mediation layer (out-of-profile calls are denied before the safety net, with
  a `tool-profile` reasonCode) and also translates the surface into the SDK's
  `disallowedTools` option as defense in depth. The black-box `claude-code` and
  `antigravity-code` runtimes, which cannot mediate per-tool calls, now refuse a
  narrowing `tool_profile` instead of silently running their full surface.
- **Dispatch pipeline halt evidence.** When a `mode=pipeline` dispatch stops
  after a failed step, the error result now keeps the completed and failed run
  summaries plus their receipt paths in `details.runs`, so the orchestrator
  still receives receipt-backed evidence for the partial chain.
- **One compaction threshold.** The context ledger overlay and the persisted
  context snapshots now fall back to the shared auto-compact default (0.8)
  instead of a local 0.85, so `/context` reserve/free math and the
  auto-compact trigger can no longer disagree when no threshold is configured.

### Removed / BREAKING (no compat shims)

- Guardrail env vars were renamed and repointed at settings. The new
  `guardrails:` settings.yaml section (`turnToolCallBudget`,
  `workerToolCallCap`, `maxDispatchRuns`, `readMaxBytes`,
  `observationTurnBudgetBytes`) is the durable home for the loop-guard
  budgets, tool byte caps, and dispatch ledger cap, resolved env > settings >
  default in `core/guardrails.ts`. `CLIO_MAX_TOOL_CALLS` is now
  `CLIO_WORKER_TOOL_CALL_CAP` and `CLIO_ORCH_MAX_TOOL_CALLS` is now
  `CLIO_TURN_TOOL_CALL_BUDGET`; the old names are ignored. The run-scoped CLI
  overrides (`--max-context-tokens`, `--kv-cache-mode`, sampling flags) now
  travel in one typed JSON env var, `CLIO_RUN_OVERRIDES`
  (`core/run-overrides.ts`), and the per-option vars
  `CLIO_MAX_CONTEXT_TOKENS`, `CLIO_KV_CACHE_MODE`, and
  `CLIO_SAMPLING_OVERRIDES` are gone. Every env var the runtime reads is now
  documented in `docs/environment-variables.md`.
- Tool names `glob`, `workspace_context`, `docs_search`, `read_skill`,
  `run_task`, `validate_frontend`, `write_plan`, `write_review`,
  `create_skill`, and `dispatch_batch` are gone; see the consolidations above
  for the replacement call shapes. `grep`'s `ignoreCase` argument is renamed
  `ignore_case`; `find`'s default limit is 500; `docs_search`'s `file` filter
  was dropped in the context consolidation.
- Details payloads changed: OBSERVE tools return `details.observation`
  (replacing `details.truncation`, per-tool `resultSize`,
  `matchLimitReached`, `entryLimitReached`, `resultLimitReached`, and
  `observationBudget`); dispatch returns
  `{mode, runIds, receiptCount, failedCount, runs[]}` and no longer surfaces
  `batchId` or single-run `runId` details; git and verify script checks
  return `{command, cwd, exitCode, durationMs, timedOut, outputCapped}` with
  `command` as a joined string; artifact returns `{kind, paths}` or the
  skill-store shape.
- The `CLIO_READ_TURN_OBSERVATION_BUDGET_BYTES` environment variable is
  replaced by `CLIO_OBSERVATION_TURN_BUDGET_BYTES`, which now covers every
  OBSERVE tool, not just read.
- Skill `allowed-tools` narrowing now exempts `context` and `ask_user`
  (previously `read_skill` and `ask_user`); skills declaring deleted tool
  names in `allowed-tools` block their own workflows until renamed.

## 0.2.7 - 2026-07-02

A skills-and-accountability release: the marketplace catalog grew five
reviewed skills and gained executable evals, enforced tool surfaces, and
supply-chain integrity checks; credential handling got a real damage-control
net; and every dispatch run now leaves forensic evidence behind.

### Added

- **Five marketplace skills.** `scientific-debugging` (falsifiable hypotheses
  across fault classes, cheapest test first, evidence-cited verdicts before
  any fix), `experiment-protocol` (thresholds, tolerances, environment pins,
  and input checksums pre-registered into the repo validation contract before
  any measurement), `design-council` (a bounded multi-perspective debate run
  through read-only dispatched workers, with receipt-linked synthesis and
  early termination on consensus), `credentials` (presence checks without
  value exposure, hidden-input terminal collection, and a leak containment
  sequence), and `workflow-distiller` (reconstructs a just-run workflow from
  the session record, interviews one question at a time, checks overlap with
  installed skills, and gates `create_skill` on an approved design). All
  carry catalog provenance and RED-GREEN `evals.md` scenarios.
- **Executable skill evals.** `clio skills eval <name|path>` (experimental)
  runs each `evals.md` scenario as a baseline headless turn without the
  skill, a treatment turn with it, and a judge turn scoring every Expected
  bullet from the two transcripts. Scenario fixture commands are real shell
  from the skill author and execute only behind `--trust-fixtures`. Exit 1
  means a rubric bullet failed; exit 3 means verdicts stand but the evidence
  archive write failed. `--json` emits one experimental-schema JSONL row per
  bullet, and results land as a standard eval evidence bundle with a
  `skill-eval.json` sidecar registered in `overview.json`.
- **Skill tool surfaces are enforced.** `allowed-tools` / `disallowed-tools`
  frontmatter now blocks out-of-surface calls at tool admission (audit reason
  `skill_surface`) from activation to end of turn (main agent) or end of run
  (recipe workers), on the interactive, headless, and dispatch surfaces
  alike. Denials win across skills; narrowing never grants anything the
  safety net would refuse; `read_skill` and `ask_user` stay admitted.
- **Skill supply-chain integrity.** `skills/registry.yaml` pins the
  provenance-stripped sha256 of every catalog skill, so install-lifecycle
  stamps are not drift while content and registry-identity edits are.
  `clio skills install` preserves `registry-id` through installation, keeping
  activation drift checks alive on installed copies. `npm run skills:pin`
  refuses to pin a catalog missing required frontmatter, `audit: pass`, or an
  `evals.md`, and `npm run skills:check` fails CI on any pin drift.
- **Credential damage control.** Clio's own `credentials.yaml` store is
  zero-access by default; bash reads of zero-access paths are blocked with
  reason `secret_path_bash` (the exit-code-only `grep -q "^NAME="` presence
  form still passes); and evidence bundles redact secret-shaped values (PEM,
  AWS, GitHub, Slack, Google, OpenAI-style tokens, JWTs, generic assignments)
  from every export surface at build time, recording a `redactionCount` in
  the overview. The new read-only `credential_present` tool reports boolean
  presence of a key in the environment or an env-style file, never the value,
  and distinguishes a missing file from an absent key.
- **`clio usage report`** (experimental, read-only) analyzes receipts,
  session ledgers, audit rows, the evidence index, memory, and installed
  skills across sessions: top tools, normalized bash command shapes, skills
  activated versus never activated, recipes used, and failure tags, plus an
  opportunities section that cites evidence ids on every suggestion
  (recurring bash shape with no skill activation, near-identical dispatch
  prefixes, recurring failure tag with no memory record).
- **Headless main-agent accountability.** `clio run` turns write
  integrity-covered receipts (`agentId: "main-agent"`) beside dispatch
  receipts, and `--json-events terminal` emits a compact JSONL stream of
  session, turn, agent, message-final, and tool-boundary events for
  automation (the default `--json` stream is unchanged).
- **Forensic evidence on every dispatch run.** Run completion auto-builds the
  evidence bundle under `<dataDir>/evidence/run-<id>/` plus a compact row in
  `<stateDir>/evidence-index.json` (failure-cause tags, first-pass success,
  finding count), best-effort and non-blocking, flushed on shutdown so
  one-shot dispatches still persist. Receipts carry a `findingsSummary`
  folded into a v3 integrity digest (v1/v2 receipts still verify; there are
  no migrations).
- **Validation rigor.** A single `rigor` attribute (`normal` | `high`)
  resolves from `CLIO_RIGOR` over a repo-derived default (`high` when a
  validation contract like `.clio/validation.yaml` or `VALIDATION.md`
  exists). At high rigor an unvalidated completion claim is re-prompted to
  run a verification command or state what could not be verified.
- **Evidence-linked change manifests.** `clio evolve manifest
  validate|summarize` resolve every `evidenceRefs` entry against the local
  evidence store and fail on dangling refs (the `exploratory-1` exemption
  stands). Gating high-authority self-edits (Slice 5b) is deferred and
  documented in `src/domains/evolution/SELF_EDIT_GATE.md`.
- **/view accountability panel.** The overlay opens with the session's
  rolling first-pass-success rate and a failure-cause tag histogram, read
  from the evidence index sidecar.
- Local model catalog: the `gemma-4-31b-it-qat-mtp` 262K MTP build and the
  `qwopus3.6-35b-a3b-coder` orchestrator get their own families so the
  longest-substring resolver stops routing them to wrong profiles.

### Changed

- The npm package shrank from 3.91 MB to 0.93 MB (source maps, benchmarks,
  banner images, and repo scripts no longer ship), gated by
  `scripts/check-release.mjs` (entry-only shebangs, forbidden files, required
  runtime resources, size budgets) inside `ci:release`. Releases are
  tag-driven via `.github/workflows/release.yml`, which verifies the tag
  against package.json, runs the full gate, and attaches the tarball to a
  GitHub release; the npm publish step is disabled until stable v0.3.0.
- The hosted CI matrix runs the full suite once per lane instead of twice on
  Node 24, cutting roughly a third of that lane's wall clock.
- Pinned pi SDK packages upgraded from 0.79.10 to 0.80.3.
- The `intelligence` domain is parked (types-only no-op removed from the
  domain load list; source retained with a `PARKED.md`).
- `docs_search` became a deterministic self-documentation retriever with
  breadcrumbed headings, controlled vocabulary expansion, BM25-style scoring,
  and structured citations.
- The CLI states its Node `>=22.19.0` floor with a clear error instead of
  failing arbitrarily on older Node, and the docs set (observability, safety,
  evidence, validation, evolution, commands, skills, extensions, lifecycle)
  was verified against the shipped implementation.

### Fixed

- `npm run skills:pin` fails loudly on malformed frontmatter instead of
  silently pinning folder names, and pin drift is a CI failure.
- `create_skill` emits validated `requires: [skill:<name>]` frontmatter, so
  generated skills arm the loader's unmet-dependency warning.
- `ask_user` stays interactive-only by decision; the headless gap is
  documented in `clio run --help`.
- Dispatch fails fast on deterministic model-residency misses instead of
  burning retries; finalization failures seal a failed row and receipt
  instead of leaking a stuck `running` entry; receipts wait (bounded) for
  event consumers to drain; ACP delegated runs share native finish semantics
  and no longer double-count usage.
- Headless and ACP runs stop on loop-guard interrupts like the TUI does; a
  guard stop writes a visible closing message and audits under a distinct
  `loop_guard` source; the identical-call detector trips at three repeats;
  and the orchestrator enforces a per-turn tool budget (default 25 soft,
  `CLIO_ORCH_MAX_TOOL_CALLS` to override, hard interrupt at +15).
- A turn ended by `write_plan`/`write_review` (`terminate: true`) now writes
  a terminal ledger entry and exits 0 headlessly; previously the artifact was
  written but the run reported "no assistant response" with exit 1.
- Bare `/skill` opens the Skills Hub on first Enter instead of silently
  committing the first autocomplete match.
- The finish-contract advisory no longer flags purely informational answers
  as unvalidated work claims.
- The `llamacpp` SSE parser counts skipped malformed frames with one stderr
  diagnostic per stream; marketplace install reports config-dir resolution
  failures instead of continuing silently; first-run `settings.yaml`
  includes `workers.onPermission`.
- Lifecycle: `uninstall-local.sh` runs on stock macOS bash 3.2 (no
  `mapfile`, `set -u`-safe arrays); `skills/install.sh --user` resolves the
  loader's real `<configDir>/skills` root under `CLIO_HOME` and on macOS;
  `install-local.sh` warns when another `clio` on PATH shadows the fresh
  link; the live-turn harness scripts resolve the state dir correctly.

### Upgrade notes

- No migrations. Receipts sealed under v2 still verify; new receipts seal at
  v3.
- The provenance hash scheme changed (registry identity now counts as
  content), so `clio skills update` can report `local-changes` for catalog
  skills installed under 0.2.6 even though you never edited them; rerun with
  `--force` to refresh the copy and its stamp.

## 0.2.6 - 2026-06-24

Clio Coder 0.2.6 is a hardening and self-orientation release. It fixes model
residency so a single VRAM-aware reconciler drives load and evict for every
manageable local runtime from both the interactive and headless paths, replacing
the fragmented logic that could overflow VRAM on a dispatched run. It promotes
the customization substrate into first-class surfaces: layered project settings,
path-scoped project rules that activate from working context, a budgeted operator
profile, user-defined and receipted middleware hooks, and a `clio config inspect`
graph that explains why Clio behaves the way it does. It adds self-orientation so
Clio can answer questions about itself from its own shipped documentation through
the `docs_search` tool and the `clio docs` viewer. The release also hardens the
test and CI lanes with coverage and deterministic repeat runs, adds a SciCode
scientific-coding eval adapter, and refreshes the guides and HTML blueprints.

### Added

- Phase 1 (model residency): a `runtime.notice` event-bus channel and an
  operator-facing notice taxonomy (`will-not-fit`, `about-to-evict`,
  `foreign-backoff`, `stress`) emitted by the new VRAM-aware residency
  reconciler. Notices are informational and never cancel a turn; the
  interactive layer renders them and the worker writes them to stderr.
- Phase 2 (user hooks): extensions and the project can declare conservative,
  receipted middleware hooks on top of the existing effect machinery. Hooks are
  read from `.clio/hooks.yaml`, `.clio/hooks.local.yaml`, and an installed
  extension's `hooks.yaml`, and are limited to three closed kinds: `prompt` (one
  injected reminder), `effect` (one existing closed middleware effect), and
  `command` (an explicit argv run with no shell, under the workspace, with a
  timeout and bounded output). Each hook carries source attribution and a
  content hash, every execution writes a `HookReceipt` to a capped log persisted
  through safeResourceWrite, and a malformed hook is rejected without aborting a
  turn. Hooks register after the safety guards and can only add effects; the
  safety policy stays authoritative and a hook cannot grant a permission safety
  would deny.
- Phase 3a (scoped settings): `.clio/settings.yaml` (committed) and
  `.clio/settings.local.yaml` (gitignored) now layer on top of user settings,
  with precedence built-in < user < project < project.local < CLI flags. The
  effective config domain applies the layers, each key is attributed to the
  layer that set it, objects deep-merge while arrays and scalars replace, and
  credential-bearing keys are stripped from project layers with a diagnostic so
  secrets never live in committed configuration.
- Phase 3b (path-scoped rules): `.clio/rules/**/*.md` load deterministically by
  id for prompt-cache stability. A rule with no `paths:` frontmatter is
  unconditional and loads with project context; a path-scoped rule activates
  only when a matching file is already in working context. Every rule carries a
  content hash and a token estimate for context-ledger accounting, and rule
  frontmatter can contribute `context.excludes` globs.
- Phase 3c (operator profile): a structured, budgeted operator profile
  (`<configDir>/profile.yaml`, overridable per project at `.clio/profile.yaml`)
  renders as one capped prompt section covering response posture, validation
  preference, commit-message style, and optional local-only paths. Every field
  is a closed enum or bounded list; durable learned preferences stay in approved
  memory rather than this file.
- Phase 3d (config inspect): `clio config inspect [--json]` prints the
  effective-customization graph, the "why is Clio behaving this way" surface. It
  reports per-key settings sources, loaded CLIO.md, path-scoped rules, skills and
  prompt roots, extensions, safety autonomy, memory, user hooks (with precedence
  winners and losers), and the operator profile, each with scope, source path,
  hash, trust, precedence, reload class, and context cost where it enters the
  prompt.
- Self-orientation surfaces: a `docs_search` read tool and a `clio docs`
  viewer let Clio answer how it works, how it is configured, and how agents are
  triggered from its own shipped documentation. The `docs_search` tool runs
  model-free term-frequency retrieval over the bundled `docs/*.md` set, splits
  each file into heading-delimited sections, scores them with a heading-match
  boost, caches the parsed index in-module, and returns the top sections as JSON
  with file, heading, snippet, and score so every answer carries a cited
  passage. The `clio docs [topic]` command serves the bundled `docs/html`
  blueprints over a Node built-in static server bound to 127.0.0.1 on an
  ephemeral port with `--no-open` to suppress the browser; it keeps no state,
  runs no daemon, and reaches no external network. Packaging now ships
  `docs/html/**` so the viewer works from an installed package.

### Changed

- Phase 0 (lint cleanup): converted 13 null-guard conditionals to optional
  chaining, clearing every `lint/complexity/useOptionalChain` warning. The
  sites span the interactive chat loop and panel, session context accounting,
  the compaction token scan, provider auth storage and credentials, the Claude
  SDK runtime result reader, the CodeWiki indexer, and the context benchmark
  script. Each transformation preserves the original null-versus-shape
  semantics: a falsy base still triggers the guard, and multi-clause conditions
  optional-chain every property access so correctness does not depend on
  narrowing propagating through `||`. No runtime behavior changes.
- Phase 1 (model residency): one runtime-agnostic residency reconciler
  (`src/engine/apis/residency.ts`) now decides model load and evict for every
  manageable local runtime from the shared stream path, so the interactive and
  headless paths reconcile identically. It evicts only Clio-loaded models, backs
  off to observe-only when a foreign-loaded model is present, and is VRAM-aware:
  it weighs the requested footprint against free VRAM where the runtime exposes
  it and declines a load that still will not fit after reclaiming Clio-loaded
  VRAM. Residency defaults to Clio-managed for manageable runtimes with one
  explicit opt-out, `CLIO_RESIDENCY=observe`. The LM Studio `gpuStrictVramCap`
  no-spill guard stays; an oversized load now surfaces a `will-not-fit` notice
  instead of a bare SDK error.

### Fixed

- Phase 1 (model residency): the headless and worker activation path never
  reconciled Ollama residency, so a dispatched run could leave a previously
  pinned model resident and overflow VRAM when a second model loaded. Both
  paths now reconcile through the single reconciler.

## 0.2.5 - 2026-06-23

Clio Coder 0.2.5 adds first-class support for Argonne ALCF inference targets
without moving the integration into pi-ai. The release keeps the scientific
site-specific behavior inside Clio's engine/provider boundary: Clio registers
the ALCF Globus OAuth provider, resolves bearer tokens for authenticated
probes, discovers Sophia/Metis endpoints, and adapts strict OpenAI-compatible
payloads for the ALCF gateway.

### Added

- Added the `alcf` runtime for Argonne ALCF Sophia/Metis inference targets over
  Globus OAuth, including authenticated model discovery through the ALCF
  catalog and running-job endpoints.
- Added a Clio-owned ALCF OAuth provider registration for the Globus native
  paste-code flow, with the ALCF gateway scope and identity-domain guidance
  kept in `src/engine/alcf-oauth.ts`.
- Added ALCF model metadata for the Llama 4 Maverick and Scout gateway models,
  plus documentation covering login, target setup, probing, and the gateway's
  strict payload behavior.
- Added mocked contract coverage for ALCF OAuth grant selection, ALCF runtime
  discovery/synthesis, and OpenAI-compatible reasoning payloads against
  strict gateways.

### Changed

- Provider probes can now receive a resolved OAuth bearer through
  `ProbeContext.authToken`, so authenticated runtime discovery works from both
  `clio configure` and live provider probes without embedding site-specific
  token logic in pi-ai.
- OpenAI-compatible runtimes can opt out of `chat_template_kwargs` while still
  preserving top-level `reasoning_effort`; the ALCF runtime uses this for
  strict gateway compatibility.

## 0.2.4 - 2026-06-23

Clio Coder 0.2.4 brings agent fleet management on top of an internal hardening
pass. It adds agent-to-profile bindings and a multi-mode `/fleet` overlay,
isolates the dispatch test suite from the real run ledger, pins
previously-unasserted dispatch invariants, makes receipt digests deterministic
across hosts, and refreshes the engine and SDK dependencies.

### Added

- Agent fleet management: agent-to-profile bindings, a multi-mode `/fleet`
  overlay for profiles and bindings, fault-tolerant dispatch, and profile CRUD.

### Fixed

- Dispatch contract tests never isolated `CLIO_STATE_DIR`, so `extension.start()`
  read and rewrote the developer's real run ledger. Because `persist()` caps the
  ledger to 1000 rows, a single test run could truncate real history. Tests now
  isolate state per-test through `tests/harness/dispatch.ts`, and the same leak
  is closed in worker-steer. The contracts lane dropped from 13.7s to 7.1s while
  gaining 15 tests.
- Receipt digest ordering was locale-dependent. `snapshotToolStats` now orders by
  UTF-16 code unit instead of `localeCompare`, so digests match across hosts.
- Restored a green Biome check on the baseline.

### Changed

- Targets: dropped the `disconnect` verb, guarded chat use during a run, and
  added a fleet-default action.
- Pinned previously-unasserted dispatch invariants, each sabotage-verified: the
  ledger ring cap, global sort before cap, merge disk-preservation with
  memory-wins, adopt dedup/sort/no-op, orphan recovery for abandoned rows and the
  no-`cwd` skip, tool-stats outcome buckets and `countToolCalls`, and the
  `runStatusForOutcome` map with its `stopReason` suffix.
- Added a `collectReproducibility` dependency-injection seam for tests. The
  production default is unchanged.
- Renamed the share/archive export include flag to `hasExplicitInclude`.
- Refreshed dependencies. The pi engine (`@earendil-works/pi-agent-core`,
  `pi-ai`, `pi-tui`) moved to 0.79.10, the Claude Agent SDK to 0.3.186, the
  Anthropic SDK override to 0.105.0, Biome to 2.5.1, TypeBox to 1.3.0, undici to
  8.5.0, uuid to 14.0.1, and tsx to 4.22.4. `@types/node` stays on the 24.x line
  to match the Node `>=22.19.0` support floor, and `web-tree-sitter` stays at
  0.20.8 because the `tree-sitter-wasms` grammars are ABI 13 while 0.25 and later
  require ABI 14.

## 0.2.3 - 2026-06-17

Clio Coder 0.2.3 is a TUI command-surface sprint. It moves the interactive
experience away from transcript dumps and one-off command handlers toward a
small registry-backed command set, reusable full-screen overlays, and footer
notices that keep operational feedback out of the chat transcript.

The release also consolidates model targets, skills, settings, and
observability into single-purpose hubs. Several old slash commands are retired
because their behavior now lives in richer surfaces: `/targets`, `/skill`,
`/help`, and `/view`.

Autonomy is now an enforced part of tool admission. The release separates the
always-on safety net from the autonomy level that decides whether approved
tool calls run, ask, or stop, and it applies that mapping across chat,
workers, headless runs, and ACP delegations. Operator notices name the
deciding axis, so read-only denials, approval parks, and safety-net blocks no
longer look like one generic safety failure. Full-auto gained sequencing
operators while command substitution and destructive command forms stayed
behind explicit rails.

The configuration and lifecycle surface was rebuilt from first principles.
`settings.yaml` is a machine-owned file validated against one strict schema
with exact-path errors and written only through a locked single-writer path.
Clio's model-provider vocabulary is `target` everywhere, including persisted
receipts, run ledgers, and session metadata. Machine-produced state moved into
its own XDG state root alongside config, data, and cache, and the lifecycle
verbs were made honest: doctor only reports, reset levels map one-to-one onto
the roots, and uninstall removes everything it installed.

The release also stands up a model-free context engine and reopens external
runtimes after 0.2.2 retired the CLI-subprocess era. `clio context-index` builds
a deterministic multi-language codewiki through web-tree-sitter grammars and
answers structural `code_nav` queries without a model call, now covering C#
alongside the existing nine languages. Subscription and delegation runtimes
return as first-class targets: an `anthropic-max` OAuth runtime, `claude-code`
and `claude-sdk` workers that drive the user's Claude Code on their
subscription, a Claude Code delegation path over ACP, and an `antigravity-code`
worker that drives Google's `agy` CLI. Each maps Clio autonomy onto the
runtime's own permission surface and keeps the always-on safety net in front.

### Added

- Added a Claude Code delegation path over ACP. Clio drives the user's Claude
  Code through `@zed-industries/claude-code-acp` (the `claude` CLI has no ACP of
  its own; the adapter bridges the Claude Code SDK and runs on the user's Claude
  Pro/Max subscription), reusing Clio's existing ACP delegation client and tool
  mediator. The settings template ships a commented `claude-code` delegation
  recipe. The ACP tool mediator now infers the Clio tool from the permission
  request's `rawInput` shape (`command`→bash, `file_path`+mutation→edit,
  `file_path`→read, `pattern`→grep, `url`→web_fetch) so agents that omit the ACP
  tool `kind` — claude-code-acp among them — still have their shell, write, and
  edit calls classified and safety-gated instead of blanket-denied.
- Added an `anthropic-max` runtime that powers Clio with a Claude Pro/Max
  subscription over OAuth, mirroring the `openai-codex` subscription runtime. It
  is an `anthropic-messages` HTTP runtime authenticated by a subscription OAuth
  token rather than an API key; pi-ai runs the login/refresh flow and switches to
  Bearer auth automatically. A new optional `RuntimeDescriptor.oauthProviderId`
  bridges the runtime to the pi-ai `anthropic` OAuth provider so it shares
  credential storage with that provider while keeping a distinct registry id from
  the api-key `anthropic` runtime, which is unchanged. `clio auth login` and the
  configure wizard print an `authNotice` flagging that subscription use outside
  Anthropic's first-party apps may not align with their terms, making it an
  explicit opt-in. The runtime is selectable as both an orchestrator and a worker
  target.
- Added `claude-code` and `claude-sdk` worker runtimes that drive the user's
  Claude Code on a Claude Pro/Max subscription as a Clio worker. `claude-code`
  spawns the `claude` CLI as a subprocess (`claude -p --output-format
  stream-json`, parsed as stream-json); `claude-sdk` drives
  `@anthropic-ai/claude-agent-sdk query()`. Both authenticate through the local
  `claude` CLI login, carry the same Claude model set, and mediate Claude's own
  tool calls against Clio's autonomy level and always-on safety net through a
  shared tool-safety bridge. Autonomy maps onto Claude permission modes:
  `read-only` runs `plan` mode restricted to read-only tools, `suggest` runs
  `dontAsk` over the same read-only set, `auto-edit` runs `acceptEdits`, ungated
  `full-auto` runs `default`, and only `full-auto` plus
  `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` reaches `bypassPermissions`. Both are
  selectable as worker/dispatch targets.
- Added `antigravity-code`, a subprocess worker runtime peer to `claude-code`
  that drives Google's Antigravity CLI (`agy --print`), bringing Gemini 3.x and
  hosted Claude/GPT-OSS models with up to ~1M tokens of context to the worker
  fleet. Clio spawns the binary, streams its plain-text output as assistant text
  deltas, and maps autonomy onto agy's coarse permission flags: `read-only` and
  `suggest` run `--sandbox`, `auto-edit` and ungated `full-auto` defer to agy's
  own `settings.json`, and `full-auto` plus `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`
  opens `--dangerously-skip-permissions`. Because `agy --print` emits no
  structured event stream, Clio cannot mediate individual agy tool calls, so the
  runtime is a worker/dispatch target only, never an orchestrator. It reuses the
  existing Antigravity login and stores no Antigravity credentials.
- Added `clio paths [--json]` as the read-only source of truth for Clio's
  resolved config, data, state, and cache directories. The local uninstall
  script and live session-reporting scripts now ask the built CLI for those
  paths first, with their embedded resolution blocks reserved for a missing or
  broken dist.
- Added a fourth on-disk root for machine-produced state, resolved through one
  documented order: platform defaults (XDG on Linux, including
  `XDG_STATE_HOME`), then `CLIO_HOME/{config,data,state,cache}`, then the four
  specific `CLIO_*_DIR` variables winning over everything. Sessions, audit
  logs, receipts, run ledgers, recent models, install metadata, interviews,
  and scratch space live under state; user agents live under config; the
  marketplace cache lives under cache; data keeps memory, evidence, and evals.
- Added `uninstall --remove-binary`, which removes the launcher only when the
  symlink actually resolves to Clio's dist, and keeps foreign symlinks or real
  files with a stated reason.
- Added a declarative slash-command registry. Command parsing, usage lines,
  autocomplete, and the command reference now derive from one spec with aliases,
  flags, positionals, subcommands, repeatable values, and command-owned value
  placeholders.
- Added the shared `ListOverlay` kit for grouped, filterable browse surfaces
  with Esc-clears-then-closes behavior, wrap-around selection, live footer
  hints, and optional markdown detail panes.
- Added full-screen overlays for `/help`, `/agents`, `/prompts`, and
  `/extensions`. `/help [query]` opens the Help Center pre-filtered, and
  `/prompts` can insert a selected prompt invocation into the editor.
- Added the `/targets` target hub with compact target rows, in-place details,
  active/health sorting, selected-row actions, serialized async auth/probe
  actions, and success-level footer notifications.
- Added the `/skill` Skills Hub with installed project/user groups, a live
  GitHub marketplace backed by the repository `skills/` tree, lazy SKILL.md
  detail loading, 24-hour disk caching, offline fallback to stale and pinned
  marketplace data, and in-place marketplace install.
- Added the `/settings` Settings Center with Autonomy & Safety, Orchestrator,
  Fleet, Budget, Compaction, Retry, and Terminal sections, a two-lane desktop
  layout, a stacked narrow layout, row descriptions, config paths, current
  values, and refresh-in-place behavior on config changes.
- Added a builtin stalled-turn nudge for assistant turns that announce work,
  make no tool calls, and stop normally. It injects one continuation reminder
  through middleware, lets human steering win over pending nudges, and warns
  instead of looping after a second stall.
- Added `test:file` as a fast one-file verification lane backed by
  `node --import tsx --test`.
- Added `/view`, a full-screen observability viewer for run receipts, dispatch
  metadata and outputs, durable tool outputs, and compaction summaries. It has
  a grouped/filterable artifact list, a pager-style content pane, lazy
  token-fenced loading, cached markdown rendering, JSON pretty-printing under a
  10 MB cap, 50k-line truncation, selected-receipt verification, path notices,
  Tab focus switching, `/view <id-or-filter>`, and `/view verify <runId>`.
- Added sprint closure contract coverage that locks the exact v0.2.3 slash
  command registry and fails if a retired slash command returns.
- Added a loop guard for the interactive orchestrator. Verbatim-repeated tool
  calls are blocked at the registry admission seam with recovery feedback the
  model can act on, surfaced as footer warn notices over a new
  `safety.loopBlocked` bus event, and the turn is cancelled after three blocks.
  Workers keep their own in-process guard and are never observed twice.
- Added indentation-tolerant edit matching. When an exact and a normalized
  match both fail, a final stage matches line sequences ignoring leading
  whitespace, enforces uniqueness, and reindents the replacement to the file's
  own prefix.
- Added scratch offloading for truncated tool results. The full original
  output is written to `<dataDir>/scratch/<sessionId>/<toolCallId>.txt`, the
  truncation hint carries the path, and the model can read the remainder with
  offset and limit. Write failures degrade to plain truncation.
- Added a working middleware rule engine. Hook evaluation is a pure in-process
  fold over rule definitions that pair declarative rules with effect payloads
  and exact tool-name scoping, with a registration seam on the bundle and
  payload resolution by rule id when workers reconstitute snapshots. Zero
  builtin rules ship.
- Added operator notices for previously invisible bus events: budget alerts
  with spend and ceiling, restart-required setting changes naming the paths,
  and safety-net blocks naming the rule and policy source that fired. Domain
  lifecycle joins the opt-in bus tracer and domain load failures write a
  structured stderr line before boot aborts.
- Added bounded worker diagnostics. A crashed or garbage-printing worker keeps
  a 4KB stderr tail and a malformed-stdout count that reach the run receipt,
  the dispatch failure detail, and the dispatch board.
- Added the unified middleware hook layer. Five lifecycle events (before_tool,
  after_tool, turn_start, turn_end, on_compaction) evaluate coded registrations
  beside declarative rules in one ordered, error-isolated, budget-measured
  pass. Both loop guards merged into one registration, protected artifacts and
  dispatch dedup left the registry for registrations, the orchestrator
  callbacks became after_tool observers, the finish contract and tool-prose
  assessor became turn_end registrations, and `inject_reminder` delivers
  buffered reminders into the next model request as one visible persisted
  system-reminder block. Hook diagnostics publish on a typed
  `middleware.hookFailed` channel rendered as warn notices. The registry's
  control seams dropped from seven to two.
- Added typed bus payloads. Every channel has a payload interface derived from
  its real emit sites, `BusPayloadMap` makes emit and subscribe generic over
  the channel, and a contracts tripwire fails when any channel lacks an
  emitter or subscriber.
- Added live agent steering. Enter while a run streams now lands the typed
  correction between tool batches through the engine's steering queue, while
  alt+enter keeps after-run follow-up semantics in a typed Steering Queue
  panel. Workers accept steer messages over their existing stdin line protocol
  with `clio_steer_received` acks, `dispatch.steer(runId, text)` joins the
  dispatch contract, and `@<agentId> <text>` in the editor routes a steer to a
  running worker by agent id or runId prefix.
- Added receipt tool-activity records. Receipts carry calls, successes,
  failures, blocks, and whether any mutating call succeeded; a run that
  finishes succeeded without a single successful tool call gets a factual
  outcomeDetail note visible on the board, in fleet status, and in the
  dispatch tool heading.
- Added durable customization writes. Memory records, extension state, skill
  overwrites, settings, and share imports share one atomic
  write-fsync-backup-rename helper, and share-archive import preflights every
  entry, rejecting absolute paths, dot-dot segments, and symlink escapes with
  zero writes on rejection.
- Added parked-call loop observation. Denied or cancelled permission-parked
  calls are observed by the loop guard, so a headless model retrying a denied
  call gets recovery guidance instead of looping until timeout.
- Added `clio context-index`, a model-free Stage 1 indexer that writes the
  `.clio/codewiki.json` codewiki and `.clio/state.json` fingerprint, then prints
  source coverage and a deterministic structural hash. `--json` emits the same
  data machine-readably for CI and benchmarks.
- Added a deterministic multi-language codewiki built through web-tree-sitter
  WASM grammars for TypeScript, JavaScript, Python, Go, Rust, C, C++, Java, and
  Ruby, with a regex fallback for trees the grammars do not parse. The v3 schema
  records files with roles, symbols with kinds and signatures, and import edges
  as internal file links or external modules, and the same tree always produces
  the same structural hash.
- Added `code_nav` lookups over the v3 codewiki with six modes: `symbol` finds
  declaring files, `path` matches by glob, regex, or substring, `entries` lists
  likely entry points, `outline` lists a file's symbols, `deps` lists a file's
  imports, and `dependents` lists its importers. Every mode reads the persisted
  index without a model call.
- Added C# as a recognized source project type. Whole-tree language detection
  counts `.cs` sources and `*.csproj` manifests, the codewiki indexer indexes
  `.cs` files and registers `.csproj` files as config, and the bootstrap
  project-type label reports C#.

### Changed

- Changed `settings.yaml` loading to one strict schema. Unknown keys, stale
  setting names, and type or enum violations now fail validation with exact
  key paths instead of passing through legacy normalizers or compatibility
  readers, and doctor reports the same errors read-only.
- Changed `settings.yaml` into a machine-owned file written through the locked
  single-writer update path. Programmatic writes serialize the current schema,
  concurrent writers merge against the freshest file, and the old
  `settings.yaml.bak` sidecar is no longer created.
- Changed Clio's model-provider vocabulary from endpoint to target across
  configuration, agent recipes, dispatch requests, session metadata, run
  ledgers, receipts, `/view`, fleet status, and evidence output. Because this
  is pre-release state and local installs are expected to be wiped between
  schema cuts, Clio does not migrate old endpoint-shaped receipts, runs,
  sessions, or agent files.
- Changed doctor to be read-only end to end: plain `doctor` writes nothing and
  creates no directories, and `--fix` repairs structure only, never rewriting
  a settings file whether it is valid or invalid.
- Changed reset levels to map one-to-one onto the on-disk roots: `--state`
  (the default), `--data`, `--cache`, `--auth`, `--config`, and `--all`, with
  no level touching a root it does not name. Uninstall removes all four roots
  unconditionally.
- Changed `clio upgrade` to ship with an empty migration registry. The
  mechanism stays as product infrastructure, but migrations targeting
  pre-0.2.3 shapes were deleted; real migrations will be authored against
  current shapes once a public user base exists, and any future
  settings-writing migration must hold the single-writer lock.
- Changed `install.json` to write `installedAt` exactly once at first install
  and stamp `upgradedAt` when the version, platform, or node runtime changes.
- Changed the visual blueprint pages under `docs/html/` to be regenerated from
  the markdown documentation as the source of truth, covering all nineteen
  subsystem blueprints for this release.
- Changed the safety level setting into an enforced `autonomy` level with an
  always-on safety net. The persisted setting is now `autonomy`, `/settings`
  shows Autonomy & Safety, dashboards, help, and notices distinguish
  `[autonomy]`, `[approval]`, and `[safety-net]`, and `read-only` became the
  floor level with its own prompt fragment.
- Changed tool admission to evaluate the safety net before the autonomy
  mapping in every execution context. Level-independent blocks and confirm
  rails still apply first, then read-only denies mutations with
  propose-instead guidance, suggest parks mutations, auto-edit runs writes and
  recognized commands while asking for unrecognized bash, and full-auto runs
  unrecognized bash while unknown actions still ask.
- Changed shell-operator handling to let autonomy decide sequencing operators
  while keeping command substitution behind a confirmation rail at every
  level. Pipes, `&&`, `;`, and redirects now become unrecognized commands that
  full-auto can run, and damage-control rules explicitly cover deletion and
  truncation forms such as `find -delete`, `rsync --delete`, `shred`,
  `truncate -s 0`, and `:>`.
- Changed `run_task` admission to allow any declared verification-family
  script instead of a fixed six-script allowlist. Rejections now distinguish
  undeclared family scripts from non-verification scripts and point the model
  to the right next action.
- Changed codewiki mutation observation so successful edit paths batch off the
  `after_tool` middleware hot path. Middleware budget notices now warn once
  per registration and hook while telemetry still records every exceedance.
- Changed `code_nav` mode=symbol to return each match's path, line, kind, and
  signature alongside the declaring files, so a caller gets the exact definition
  site from the index instead of following up with a grep for the line.
- Changed project-language detection to read a whole-tree source census instead
  of root manifests alone, so nested, polyglot, and single-file repositories
  resolve to a real language and index their source rather than falling through
  to `unknown` with zero coverage. Conventional backend entry filenames such as
  `server.*` now register as entry points alongside `index`, `main`, `cli`,
  `bootstrap`, and `__main__`.
- Changed model discovery so a live provider catalog is authoritative once a
  target has returned one: stale configured or default model names stop
  resolving after the provider removes them. One shared discovery path now
  feeds the resolver, `clio models`, `/model`, `/settings`, `/scoped-models`,
  and `/targets`. `clio models` probes live by default (`--offline` skips the
  probe), the `/model` overlay auto-refreshes catalogs on open, and probes
  carry per-model load state from OpenAI-compatible `/v1/models` (llama.cpp
  router states such as loaded, loading, unloaded, and failed) surfaced as a
  state column, overlay detail, and `/targets` model preview.
- Enriched Clio's identity with the CLIO acronym (Context Layer for
  Input/Output), the Greek muse of history namesake, her standing as the
  first female agentic coder, and provenance from the Gnosis Research Center
  at Illinois Tech under PI @akougkas. The system-prompt fragment, fallback
  identity prompt, bootstrap self-description, TUI banner, and CLI help text
  carry the same story.
- Replaced bracket-prefixed command output dialects with a themed single-line
  notice channel for info, success, warning, and error messages.
- Replaced hand-written overlay footer text with `buildHint`, including
  canonical key casing, browse/commit Esc verbs, and middle-first elision.
- Standardized user-facing vocabulary on "target" while leaving persisted ids
  under the existing endpoint-shaped settings fields.
- Changed `/targets` so Enter only expands/collapses details; target activation
  and auth/probe work happen through explicit selected-row keys.
- Changed `/skill` so Enter inserts `/skill:<name>` for task completion, while
  marketplace installation is an explicit selected-row action.
- Changed `/settings` to delete read-only rows for worker profiles, endpoint
  counts, and keybindings. Targets are managed in `/targets`, and keys are
  documented in `/help`.
- Changed observability workflows so the transcript remains compact and `/view`
  carries detailed inspection, verification, and backing-path lookup.
- Changed `/tree` Enter to switch to the highlighted turn id. The visible
  transcript and chat-loop replay are truncated through that turn, and the next
  append point follows the selected turn instead of the session id.

### Fixed

- Fixed three high-severity esbuild advisories (GHSA-gv7w-rqvm-qjhr,
  GHSA-g7r4-m6w7-qqqr) reported across the direct dependency, tsup, and tsx
  (esbuild 0.17.0–0.28.0). An `overrides` entry pins esbuild to the patched
  0.28.1 and the direct dependency is bumped to match, so a single esbuild
  dedupes across tsup, tsx, and bundle-require without the tsup 6.5.0 downgrade
  that `npm audit fix --force` would impose. `npm audit` now reports zero
  vulnerabilities and the bundle output is unchanged.
- Fixed the Claude worker `clio_tool_finish` telemetry reporting a contradictory
  `reasonCode: allowed` on autonomy-axis denials. The event copied the safety
  policy's own reason code, which describes the net pass, so a read-only write
  block emitted `decision: blocked` next to `reasonCode: allowed`. Autonomy
  denials now carry an explicit `autonomy:<level>` reason code in the worker
  event, matching the native tool registry and the audit log.
- Fixed a codewiki build abort when a tree-sitter grammar crashed on a single
  file. Some web-tree-sitter grammars throw inside `parse` on otherwise valid
  input, and the unguarded call let one file abort indexing for the whole
  repository. Extraction now degrades to no symbols for the offending file and
  the rest of the tree still indexes.
- Fixed the audit log recording non-final outcomes as final. Engine rows are
  now `classified`, the tool registry writes `denied` and
  `permission_requested`, and a confirmed grant produces the single final
  `allowed` row, so the log states what actually happened to every tool call.
- Fixed `clio evidence build` reporting clean ACP delegation receipts as
  corrupt. The runtime kind is digest-covered and is now preserved as written
  instead of being coerced to `http`, which recomputed a different integrity
  payload.
- Fixed `context-clear` leaving `.clio/proposals/` behind; it now clears
  proposals alongside codewiki, state, and handoffs.
- Fixed `/run verifier --target ... <task>` swallowing target flags into the
  task when flags appeared after the agent name. `/run` now extracts declared
  trailing flags before the first task token while other rest-positional
  commands keep byte-identical parsing.
- Fixed dispatch workers using stale configured model ids when the live
  catalog exposed only an alias. Worker dispatch now canonicalizes exact,
  unique separator-prefix, and case-insensitive matches before launching the
  worker.
- Fixed `/tree` turn selection so rows are action-honest: turn rows now act on
  turn ids, not the current session id.
- Fixed `/tree` footer hints by removing delete actions that could never
  succeed from a turn-row overlay.
- Fixed `/tree` switch failures and unavailable-session handling to use typed
  footer notices instead of raw stderr.
- Fixed stale command references in user-facing docs so the post-sprint
  command set points users to `/skill`, `/targets`, `/help`, and `/view`.
- Fixed fuzzy-matched edits rewriting the whole file in normalized form.
  Smart quotes, unicode dashes, and trailing whitespace far from the edit site
  were silently mutated; matches now map back to original line spans and bytes
  outside the replaced spans are untouched.
- Fixed middleware snapshot contracts reporting every enabled matching rule as
  fired; `ruleIds` now lists exactly the rules that emitted effects.
- Fixed dispatch terminal presentation losing the outcome taxonomy: canceled
  runs now show as aborted, stalled as dead, timed-out with a timeout detail,
  heartbeat-dead rows are no longer downgraded by terminal events, ACP
  terminal payloads keep the input/output token split, and failed dispatch
  tool results stop headlining as "completed".
- Fixed leaked bus subscriptions in the context and prompts domains; both now
  retain their unsubscribes and call them on stop.
- Fixed the status controller collapsing every abort into one hardcoded path;
  turn summaries now carry abort provenance (dispatch abort, dispatch drain,
  or stream cancel with its reason).
- Fixed fuzzy edit matching laundering the model's typographic typos into
  files. Replacements are spliced against the original span so unchanged
  bytes keep the file's own quotes and unicode; only the genuinely changed
  middle takes the model's bytes.
- Fixed evidence verification silently failing every modern receipt. The
  parsers dropped post-v1 fields before recomputing digests while
  `evidence build` printed ok unconditionally; clean receipts now verify and
  corrupted ones print the integrity failure and exit nonzero.
- Fixed `fleet status` zeroing the input/output token split that receipts
  carry.
- Fixed the Skills Hub rendering with dead keys: the hub had never joined the
  overlay key-routing union, so every keystroke fell through to a
  key-swallowing branch. The routing seam is now contract-tested for all five
  list overlays.
- Fixed silently ignored `--skill` paths: missing or invalid explicit skills
  now fail with the loader's diagnostic and exit 2 before any model call.
- Fixed `clio models` claiming no targets were configured on an empty search
  and letting long model ids collide with the caps column.
- Fixed `/view` missing receipts written by concurrent processes until
  restart; every listing now merges a fresh disk read.
- Fixed filtered Esc closing shared list overlays instead of clearing the
  filter first, and added completion notices for `/targets` probes and
  `/settings` changes.

### Removed

- Removed every legacy settings normalizer and compatibility reader, the
  endpoints/targets duality (the canonical key is `targets`), the
  `state.recentModels` settings key, and the `--keep-config`/`--keep-data`
  uninstall flags whose platform-conditional path kept data behind on macOS.
- Removed handoff seeding from `context-init`. Bootstrapping a repository writes
  `CLIO.md` and the codewiki only and no longer plants a starter
  `.clio/handoffs/` file that pointed later sessions at an index they had not
  built yet.
- Removed the `/status` slash command. Live status moved into footer/dashboard
  surfaces and command output notices.
- Removed the `/hotkeys` slash command and the static `SLASH_HOTKEYS` table.
  Key help now comes from `/help` and each overlay's live footer hint.
- Removed the `/skills` slash command. The Skills Hub is `/skill`; colon
  invocation aliases such as `/skill:<name>` and `/skills:<name>` remain.
- Removed `/connect` and `/disconnect` as standalone slash commands. Target
  auth actions now live on the selected row in `/targets`.
- Removed `/receipts` and its old overlay. Receipt browsing and verification
  live in `/view` and `/view verify <runId>`.

## 0.2.2 - 2026-06-11

Clio Coder 0.2.2 is the largest harness revision since the v0.2.0 community
alpha. It retires the CLI-subprocess runtime era: Clio now drives
HTTP/native/pi-ai-backed targets directly, and external coding agents
integrate through Agent Client Protocol (ACP) delegation instead of hidden
subprocess shims. The release also hardens skill activation, introduces a
curated skills catalog, and upgrades `CLIO.md` into a full project rulebook
that future sessions can rely on.

The local-inference hot path was rebuilt around prompt-prefix stability: one
compiled system prompt and one deterministic tool surface per session, bounded
tool results, single-threshold compaction, and per-call timing and cache
telemetry persisted in the session ledger. On a single-slot llama.cpp backend
this turns repeated full-prompt prefills into cache reads; the measured
first-turn gap on the same hardware dropped from roughly a minute to about a
second once the prefix is resident. Concurrent Clio processes are now safe on
one machine: live routing is session-owned, and the shared settings file is
written through field-level patches under an advisory lock.

### Added

- Added the Context Engine featuring context window resolution, per-model probe capabilities, unified character-based token accounting, per-turn context snapshots, and a persisted snapshot ledger.
- Added single-threshold context compaction with a cheap stale-observation masking pre-stage, LLM summary fallback when pressure remains above threshold, manual `/compact`, and overflow recovery.
- Added bounded tool-result handling with a 6KB source cap, an 8KB shaping backstop, 16KB summary-kind tool policies, continuation hints, and a 20KB `ask_user` policy.
- Added per-turn performance telemetry for assistant calls: TTFT, API duration, prompt-cache input/read/write counts, backend cache verdicts, and expected-cold reasons.
- Added session-owned live routing so multiple Clio processes can run against
  the same configuration safely. Each interactive or ACP process seeds its
  routing from `settings.yaml` at boot; routing changes (`/model`, `/settings`,
  Alt+L, Alt+J/K, Shift+Tab, `/thinking`, `/scoped-models`) apply to the
  session immediately and write through as defaults for future sessions, while
  external settings writes update defaults only and surface a divergence
  notice. Recently selected models moved to `state/recent-models.json` in the
  data dir (legacy `state.recentModels` migrates on first read), and saved
  settings writes go through field-level patches under an advisory file lock.
- Added a live measurement harness: `scripts/live-turns.mjs` drives the real
  TUI through tmux for reproducible multi-turn sessions, and
  `scripts/turn-report.mjs` renders per-call timing, token, and cache-verdict
  forensics from the session ledger.
- Added an event-driven `/context-view` overlay visualizer, a context meter, and compact footer telemetry.
- Added `clio acp`, a stdio Agent Client Protocol v1 server surface for ACP
  frontends. The server maps Clio chat events, tool-call updates, cancellation,
  usage metadata, cwd-aware session creation, and optional session close support
  into ACP-shaped JSON-RPC messages.
- Added ACP delegation support for configured agents. Dispatch can spawn an ACP
  peer, initialize a session, send the delegated task with Clio prompt context,
  mediate `session/request_permission` through Clio safety policy, stream mapped
  agent events, and record ACP session/usage metadata in receipts.
- Added contract and smoke coverage for ACP event mapping, permission mediation,
  stdio delegation, `clio acp` serving, strict ACP v1 initialize/update shapes,
  stop-reason normalization, and cancellation.
- Added richer skill compatibility and activation behavior: normalized skill
  loading, project/user compatibility roots for Agent Skills, Claude, Codex,
  OpenCode, and Copilot-style layouts, slash-command parity, runtime-option
  propagation to workers, and upgraded `read_skill` / `create_skill` tooling.
- Added a curated skills marketplace under `skills/` with the first wave of
  approved skills (`context-prime`, `context-handoff`, `clio-dev`, `clio-test`),
  an `install.sh` bridge that links a catalog skill into a runtime discovery
  root (`.clio/skills` or the user config skills dir), and a provenance
  frontmatter convention (`registry-id`, `source-url`, `version`, `audit`) that
  distinguishes maintainer-approved skills from local runtime skills. The
  catalog is not a discovery root, so nothing auto-loads; skills activate only
  on explicit install. `clio-test` documents the real v0.2.2 harness
  (contracts/smoke/boundaries) and the build/config hot-reload loops.
- Added custom-section support to `CLIO.md` parsing, serialization, bootstrap
  generation, and project-context rendering. `/init --generate` can now preserve
  compact architecture boundaries, workflow traps, retrieval strategy, generated
  artifact policy, and failure modes instead of flattening everything into six
  bullets.
- Added Clio-source-tree awareness to the prompt harness. When Clio is running
  inside her own repository, the model is told that TUI, skills, agents, tools,
  prompts, context/bootstrap, and harness changes are ordinary local source work
  when requested, while publishing, pushing, releases, PRs, and registry
  contribution still require explicit user intent.
- Added deterministic local source install and uninstall scripts. `npm run
  install:local` links `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio` to the built
  checkout, and `npm run uninstall:local` removes that symlink plus selected
  Clio state with dry-run and settings/auth preservation options.

### Changed

- Simplified Clio Coder to a single, unified operating posture, removing old advice, default, and super modes along with the legacy mode matrix.
- Integrated ACP delegation agents as first-class workers and restricted shadow agent delegation to external ACP workers.
- Hardened permissions handling with queued permission overlays and deterministic headless permission denials during `clio run`.
- Replaced the split worker/orchestrator runtime eligibility vocabulary with a
  single `isTargetEligibleRuntime` policy used by chat, print, dispatch, target
  listing, and worker-spec validation.
- Restricted `RuntimeDescriptor` to the direct runtime path Clio can actually
  govern: HTTP/native/pi-ai-backed targets. The normal Anthropic Messages API
  through pi-ai remains; Claude Code as a programmatic runtime does not.
- Changed dispatch receipt behavior for batch and delegated work so worker
  summaries and ACP delegation metadata are clearer and easier to audit.
- Refreshed the root `CLIO.md` from a tiny rule list into Clio Coder's own
  repository rulebook: architecture map, context/bootstrap constitution,
  workflow for changing Clio itself, self-development/contribution etiquette,
  and high-risk failure modes.
- Converted release/developer guide material into interactive HTML blueprints
  for installation, lifecycle, documentation, validation, and related operator
  workflows.
- Reworked the chat loop to compile one session prompt keyed by endpoint, model,
  safety level, and session id. Prompt recompiles are logged as
  `promptRecompiled` ledger entries only when the compiled text changes.
- Reworked provider tool delivery to use one deterministic session tool surface.
  Per-tool safety, pending-skill, ask-user, and dispatch policies are enforced
  at invocation time.
- Reworked the session ledger writer to true append mode: each persisted entry
  is one `O_APPEND` write with a debounced fsync that is forced at checkpoint
  and close, instead of rewriting the whole `current.jsonl` on every append.
  History-rewriting operations keep the atomic tmp+rename path, and a torn
  trailing line from a crash is newline-terminated on resume so the reader
  skips exactly one invalid line with a warning.

### Fixed

- Fixed ACP server/client output to conform to ACP v1 closed-schema shapes:
  non-spec capabilities stay out of top-level initialize responses, tool kinds
  are mapped to ACP's closed enum, Clio metadata is namespaced under `_meta`, and
  pi-agent stop reasons such as tool-use/error are normalized or surfaced as
  protocol-safe results.
- Fixed runtime target cleanup fallout after subprocess removal so target
  eligibility, provider support lists, dispatch worker specs, and runtime
  diagnostics agree on the same direct-runtime model.
- Fixed skill worker launches so runtime options are propagated into worker
  specs instead of being lost across dispatch boundaries.
- Fixed dispatch batch worker summaries so multi-worker runs report coherent
  completion data.
- Fixed CLIO.md project-context injection so custom H2 sections survive parsing
  and are visible to future turns instead of being silently discarded.

### Removed

- Removed the `claude-code-sdk` runtime descriptor, its worker runtime
  implementation (`src/engine/claude-code-sdk-runtime.ts`), and the SDK safety
  policy bridge (`src/engine/sdk-policy-bridge.ts`).
- Removed the `claude-code-cli`, `gemini-cli`, `copilot-cli`, `codex-cli`, and
  `opencode-cli` CLI subprocess runtime descriptors and their invocation/parsing
  paths. There are no remaining built-in subprocess runtimes.
- Removed the subprocess runtime execution engine
  (`src/engine/subprocess-runtime.ts`) and the native CLI
  auth/status/login/logout path (`src/cli/native-cli-auth.ts`).
- Removed the worker-only runtime terminology and eligibility helpers
  (`WORKER_ONLY_RUNTIME_IDS`, `isWorkerOnlyRuntime`,
  `isWorkerTargetEligibleRuntime`, `isOrchestratorTargetEligibleRuntime`),
  replaced by the single direct-runtime eligibility predicate.
- Removed the `cli`/`cli-gold`/`cli-silver`/`cli-bronze` runtime tiers, the `cli`
  auth type, and the `subprocess-codex`/`subprocess-opencode` API families from
  the built-in runtime model.
- Removed the tool-approval IPC that existed solely for the Claude Code SDK
  worker: the `clio_tool_approval_request`/`clio_tool_approval_response`
  channel, the `SpawnedWorker` approval handlers, the worker stdin demux
  approval wait, the TUI tool-approval overlay, and the `tool.approval.*` bus
  channels.
- Removed the `--auto-approve` CLI flag, the `auto_approve` dispatch tool
  argument, the `WorkerSpec.autoApprove` field, the Claude-Code-specific
  `--supervised` dispatch flag, and `DispatchRequest.supervised`.
- Removed Claude Code / agent-SDK entries from `RuntimeApiFamily` and the worker
  spec's accepted runtime API families.
- Removed per-turn dynamic prompt fragments, prompt diagnostics events, send-policy
  prompt churn, and per-turn tool-surface selection.
- Removed the five-stage compaction ladder and replaced the old settings block
  with `compaction: { auto, threshold, excludeLastTurns, model?, systemPrompt? }`.
  Existing settings files are rewritten once by the
  `2026-06-11-compaction-single-threshold` lifecycle migration.

### Release verification

- Deterministic release gate: `npm run ci:release` passed at tag time,
  covering typecheck, Biome checks, the production build, 286 contract,
  smoke, and boundary tests, and `check-dist` packaging verification.
- Manual release-prep evidence covered local source install/uninstall smoke
  checks, interactive TUI checks, dispatch work, destructive-delete refusal,
  and opt-in live model smoke through `npm run test:live`.
- The package is not published to npm for this release; the supported install
  path is a source checkout of the `v0.2.2` tag.

## 0.2.1 - 2026-06-05

Clio Coder 0.2.1 is an alpha source-checkout patch for local model operators
running real CLI/TUI workflows through Mini, Dynamo, llama.cpp, LM Studio, and
OpenAI-compatible gateways. It updates the Pi SDK stack to 0.78.1, ports the
new prompt-envelope and session-boundary behavior from the Pi ecosystem, narrows
per-turn tool exposure, and fixes live-validation issues found while preparing
the GitHub v0.2.1 release. The package is not published to npm for this
release; use a GitHub source checkout and built `clio` binary.

### Added

- Added live and final token-throughput telemetry for completed assistant
  streams. The footer and expanded dashboard can now show compact `Tk/s`
  feedback, generation span, TTFT, and output-token counts when usage data is
  available.
- Added a larger dynamic context fill bar in the footer so long-context local
  runs, including 262k-context Gemma 4 12B llama.cpp targets, are easier to
  monitor during real sessions.
- Added hashed prompt-envelope delivery split into stable static/session
  shells and dynamic turn fragments, improving prompt-cache determinism for
  local OpenAI-compatible and llama.cpp runs.
- Added `clio run --json` prompt diagnostics events so headless consumers can
  inspect prompt signatures, active tool palettes, omitted tools, and segment
  hashes from the event stream instead of only from persisted session JSONL.

### Changed

- Retuned the expanded footer dashboard for smaller terminals: it now uses
  four horizontal sections at 100 columns and above, 2x2 at 80-99 columns, and
  vertical stacking only below 80 columns.
- Restricted dashboard toggling to Alt+U / the leader fallback. Esc is reserved
  for popups, slash-command UI, and active-run cancellation, and `/status`
  prints the dashboard key hint instead of toggling state.
- Compact speed details now use the existing output-token glyph (`↓`) so the
  Gemma 4 12B local harness dashboard stays readable in tight columns.
- Updated Pi SDK dependencies to 0.78.1 and aligned Clio's agent/session
  internals with the current Pi coding-agent reference behavior where it fits
  the Clio boundary.
- Narrowed the active tool surface per turn. Small-talk and tool-meta turns can
  run without tool schemas, repo-inspection turns stay read-only, and mutation
  or dispatch tools appear only when the user's intent calls for them.
- Bounded long tool outputs in the harness so large read/grep results carry an
  offset hint instead of flooding the model context.
- Refreshed README, developer docs, and project guidance around the current
  source-checkout alpha surface.
- Shortened the public README into a release entry point and moved detailed
  command, mode, dispatch, verification, and troubleshooting guidance into
  `docs/commands-and-modes.md`.

### Fixed

- Fixed the expanded dashboard's narrow-terminal behavior so all four sections
  remain available instead of dropping the session section.
- Fixed `clio run --agent <unknown>` so typoed fleet-agent ids fail fast with
  `unknown agent recipe: <id>` and exit 2 instead of silently spawning a generic
  worker with the visible tool surface.
- Fixed `clio run "<task>"` under headless wrappers that leave non-TTY stdin
  open. Positional tasks no longer block waiting for stdin EOF; stdin remains
  the task source when no positional task is supplied.
- Fixed the headless JSON interface gap by streaming prompt diagnostics and the
  active tool palette for main-agent runs.

### Release verification

- Deterministic release gate: `npm run ci:release`, including typecheck,
  Biome checks, build, deterministic tests, and `check-dist` packaging
  verification.
- Packaging sanity: `npm pack --dry-run --json` should show the v0.2.1 package
  contents without publishing to the npm registry.
- Optional live smoke: `npm run test:live` runs only when `CLIO_LIVE_SMOKE=1`
  and a real target is configured. Manual prep evidence included a
  Mini/llama.cpp live smoke returning `clio-live-ok`, interactive TUI coverage,
  a `dispatch_batch` run with Dynamo-backed workers, and destructive-delete
  refusal.

## 0.2.0 - 2026-06-03

Clio Coder 0.2.0 is the first community alpha release for users building from
source. It is experimental software for early adopters who can test from a
tagged checkout, report reproducible issues, and stay close to the release
notes. It hardens durable session storage and fork replay, makes `CLIO.md` the
explicit project-context path, centralizes runtime/model target resolution,
and polishes the interactive terminal UI enough for broader testing with local
and cloud targets.

### Added

- Added JIT skills as a loaded resource type, including skill cataloging,
  slash-command access, prompt injection, tool bootstrap wiring, and tests for
  skill resource loading.
- Added stronger prompt compaction behavior for populated sessions, including
  session-entry aware compaction and tests for compacting older turns without
  dropping the current working context.
- Added `clio init` / `/init` adoption support for project-local agent
  instruction files. The scanner can import supported Claude, Codex, Gemini,
  Cursor, Copilot, and related project context into `CLIO.md` with provenance
  and conflict reporting.
- Added centralized runtime target resolution so orchestrator chat, fleet
  dispatch, prompt runtime text, receipts, worker specs, and model selectors
  resolve target/model/capability state through one path.
- Added runtime diagnostics in model, scoped-model, thinking, provider, and
  overlay surfaces so operators can see target resolution and capability
  issues without leaving the TUI.
- Added command-output routing for interactive shell replay so `!!command`
  output is rendered through the TUI and excluded from model context.
- Added durable session JSONL entry coverage for labels, task ledgers, display
  activity, evidence linking, corrupt-tail recovery, stale tree metadata, and
  fork replay.
- Added documentation pages for architecture, built-in agents, evidence and
  memory, eval runner, middleware/components, model catalog, safety model, and
  scientific validation.
- Added a portable `Ctrl+G` leader-key fallback for Alt-letter TUI actions so
  stock macOS Terminal.app users can reach the dashboard, model selector, and
  other controls without terminal reconfiguration.

### Changed

- Reworked the default damage-control path policy and project policy handling
  so no-access, read-only, no-delete, wildcard, tilde, and relative paths are
  applied consistently.
- Unified headless `clio run` behavior around the orchestrator path, argument
  parsing, JSONL/non-interactive output, dispatch memory injection, and test
  coverage.
- Stabilized prompt cache and worker runtime boundaries so workers receive
  explicit runtime descriptors and prompt context remains coherent across hot
  swaps, retries, dispatches, and memory injection.
- Refactored overlay focus and framing into shared rendering paths for auth,
  cost, hotkeys, keybinding, model, provider, scoped-model, settings,
  thinking, session, tree, and super-mode overlays.
- Replaced the old `docs/specs/*` layout with user-facing docs under `docs/`
  and refreshed the README to describe the current target-first product
  surface.
- Made `clio init` output more compact while still reporting context sources,
  codewiki indexing, fingerprint updates, and workspace dirtiness.
- Consolidated macOS Terminal.app Option-key guidance into one dismissible
  footer notification with both remediation paths: enable Option-as-Meta or
  use the `Ctrl+G` leader and slash commands.

### Fixed

- Fixed damage-control wildcard escaping and formatting so path policies match
  intended files without sibling-prefix leaks.
- Fixed interactive startup and Bash replay so context warnings and command
  output do not corrupt the chat transcript.
- Fixed footer dashboard context/workspace/session freshness so CLIO.md,
  memory count, git branch/dirty state, and live submitted turns update during
  the TUI session.
- Fixed receipt overlay rendering at narrow widths and added focused coverage
  for compact rows.
- Fixed tree overlay rendering, payload-driven previews, and delete
  confirmation so narrow terminals and destructive actions are clearer.
- Fixed status overlay precedence and active-overlay tracking so retry,
  stuck, cancelled, and ended phases do not mask one another incorrectly.
- Fixed assistant summary metadata truncation in the chat panel.
- Fixed overlay key routing for delayed escape sequences in model, session,
  and tree selectors.
- Fixed session persistence and fork hardening gaps, including atomic JSONL
  writes, selected-path replay, task-ledger preservation, missing/stale tree
  recovery, corrupt-tail handling, and evidence reconstruction.

## 0.1.9 - 2026-05-17

Clio Coder 0.1.9 is a broad hardening release on top of the v0.1.6
non-interactive CLI baseline and the v0.1.7/v0.1.8 safety and approval work.
It makes fleet dispatch a first-class agent primitive, removes the retired
internal dev harness, tightens local OpenAI-compatible model handling,
adds frontend validation without shell access, and hardens the interactive TUI
around active-run follow-ups and cancellation.

### Added

- Added `dispatch` as a first-class tool for bounded fleet-agent handoffs. The
  orchestrator prompt now includes the Agent Fleet catalog, unnamed dispatches
  default to `implementer`, and duplicate dispatch requests are guarded before
  they can loop.
- Added `validate_frontend`, a typed execution tool for frontend artifacts. It
  validates `.html`, `.htm`, `.css`, `.js`, `.mjs`, and `.cjs` files under the
  workspace root; checks HTML tag structure, local script/style references,
  JavaScript syntax, CSS balance, and optional headless browser loading.
- Added a local model runtime-capabilities resolver that classifies real mini
  model families, thinking mechanisms, supported levels, effective coercion,
  request payload fields, and response parsers from one shared source.
- Added GPT-OSS/Harmony response parsing for raw llama.cpp chat-template frames
  and request synthesis for Harmony `reasoning_effort`.
- Added finish-contract evidence for successful typed validation tools,
  including `run_tests`, `run_lint`, `run_build`, standard `package_script`
  validation scripts, `validate_frontend`, dispatch receipts, and protected
  artifact records.
- Added active-run TUI coverage for plain follow-up queuing and `Esc`
  cancellation.
- Added tests for local model capability resolution, UI thinking surfaces,
  footer/dashboard effective thinking display, Harmony payload construction,
  streamed reasoning accounting, constrained Harmony JSON responses, dispatch
  tool behavior, frontend validation, finish-contract evidence, and active-run
  TUI control.

### Changed

- `/thinking`, `/settings`, the welcome dashboard, footer, hot model switching,
  prompt runtime block, and fleet-agent selection now display/use the
  effective thinking level after model-specific coercion instead of raw
  configured settings.
- Local OpenAI-compatible targets now preserve server-owned sampler defaults;
  Clio records and passes only the model-family fields it owns.
- Fleet dispatch now requires explicit allowed tool profiles and carries the
  resolved effective thinking state through the internal worker spec.
- Built-in implementer-style agents are prompted to inspect changed frontend
  artifacts and run `validate_frontend` before claiming HTML/CSS/JS work is
  complete.
- `clio run`, `clio targets`, prompt text, receipts, and README-facing copy now
  use fleet/agent terminology. The legacy `workers` settings key remains for
  compatibility with existing config files.
- Print mode now preserves the last valid assistant answer when a later
  diagnostic assistant message is emitted, instead of replacing the answer with
  advisory text.
- Eval harness metrics now count validation evidence only for successful,
  non-timed-out verifier commands.
- Public component inventory now includes the frontend validator as a
  hot-reloadable enforcing tool implementation.

### Fixed

- Fixed GPT-OSS/Harmony constrained JSON frames such as
  `<|channel|>final <|constrain|>json<|message|>{...}` being routed as hidden
  thinking or surfaced as parser errors instead of visible assistant text.
- Fixed stale GPT-OSS/Harmony marker leakage from local OpenAI-compatible
  streamed output.
- Fixed prior assistant thinking blocks being replayed upstream on later
  OpenAI-compatible turns.
- Fixed OpenAI Codex file-tool schema aliases so file/path arguments serialize
  through the expected schema shape.
- Fixed active-run TUI behavior where follow-up text and cancellation could
  leave the operator without a clear queued-turn or cancelled-run signal.
- Fixed frontend completion claims being able to pass the advisory finish
  contract without a meaningful artifact validation path.
- Fixed install/upgrade lifecycle metadata so `clio doctor` flags stale
  `install.json` versions, `clio doctor --fix` refreshes them to the current
  package version, and `clio upgrade` re-enters the installed CLI before
  running migrations and metadata repair.
- Fixed duplicate local-model capability and thinking coercion paths that could
  make UI display, prompt runtime text, and payload construction disagree.

### Removed

- Removed the retired internal dev harness and associated prompt fragments,
  tests, and diagnostic scaffolding.
- Removed user-facing `--dev` mode and internal dev prompt surfaces from
  the CLI/TUI runtime.
- Removed stale local-model helper paths that duplicated provider capability
  resolution.

## 0.1.8 - 2026-05-11

Clio Coder 0.1.8 wires the `claude-code-sdk` runtime into Clio's safety
policy engine, adds bidirectional approval IPC over the worker subprocess's
stdin, exposes a TUI overlay for `ask` decisions, and hardens
`clio configure` against unknown models and oversized context windows. It
also corrects the gemini-cli token parser and surfaces SDK safety
decisions in the receipt.

### Added

- Added the Clio extension package model with filesystem install state,
  user/project scopes, enable/disable/remove behavior, discovery
  diagnostics, and package resource roots for skills and prompt templates.
- Added `clio extensions ...` CLI commands plus `/extensions` in the TUI
  for installed extension visibility.
- Added Clio share archives (`kind: "clio-share-archive"`,
  `formatVersion: 1`) for project context, prompts, skills, settings
  fragments, and extension bundles.
- Added `clio share export|import|inspect` plus `clio export` /
  `clio import` aliases and `/share export|import` TUI flows with dry-run
  conflict reporting.
- Redesigned the welcome dashboard around a CLIO coding-engine view with
  project familiarity, confidence, active capabilities, user preferences,
  extension counts, and level/progression status.
- Added `validateModelChoice` in `clio configure` so unknown models are
  rejected with exit 2 and a listing of the known catalog. A new `--force`
  flag escapes the check with a `warning:` line for advanced users who
  know the runtime accepts the model anyway.
- Added context-window override validation. `clio configure
  --context-window N` is rejected with exit 2 when `N` exceeds the
  catalog's known maximum for the resolved model. `--force` warns and
  proceeds.
- Added a safety policy bridge for the `claude-code-sdk` runtime
  (`src/engine/sdk-policy-bridge.ts`). The bridge maps Claude Code tool
  names to Clio tool names, evaluates them against Clio's `SafetyContract`,
  and returns `allow|block|ask` decisions consistent with the native
  worker.
- Added a bidirectional approval IPC channel over the worker subprocess's
  stdin. The worker entry now demultiplexes its stdin line-by-line
  (`src/worker/stdin-demux.ts`), allowing the orchestrator to deliver
  `clio_tool_approval_response` NDJSON messages after the initial spec.
- Added `SpawnedWorker.onApprovalRequest` / `sendApprovalResponse`,
  `clio_tool_approval_request` and `clio_tool_approval_response` event
  types, and dispatch derivation of effective `autoApprove` from a new
  `supervised` flag on `DispatchRequest`/`JobSpec`/`WorkerSpec`.
- Added `clio run --auto-approve <allow|deny>` and a dispatch policy that
  appends `"headless ask auto-denied; pass --auto-approve to override"`
  to `safety.runtimeLimitations` when an unsupervised run does not opt in.
- Added a TUI tool-approval overlay
  (`src/interactive/overlays/tool-approval-overlay.ts`) that prints the
  Claude tool name, arguments, classification, and policy hint; `[A]`,
  `[D]`, and `Esc` resolve allow / deny / deny.
- Added receipt accounting for SDK safety decisions. `buildCanUseTool`
  now emits `clio_tool_finish` events for every allow, block, elevated
  (ask resolved to allow), and ask-resolved-to-deny path so the receipt's
  `safety.decisions` counters and `safety.blockedAttempts` reflect what
  Clio gated even when the underlying tool runs inside Claude Code.

### Fixed

- `subprocess-runtime` now reads gemini-cli per-call tokens from
  `event.stats` (falling back to `event.usage` for older builds) so
  gemini receipts no longer report `tokenCount: 0` on successful turns.

### Changed

- `clio configure` reuses the new `--force` flag across model validation
  and context-window validation. Without `--force`, both checks fail
  closed and no settings are written.
- The `claude-code-sdk` runtime constructor accepts an optional
  `SafetyContract`, an `autoApprove` mode, and an `awaitApproval`
  callback. When supervised, the runtime emits a
  `clio_tool_approval_request` and awaits the orchestrator's reply over
  the worker stdin channel.

### Tests

- Added focused extension tests for install state, project/user
  precedence, malformed packages, and extension-backed resource loading.
- Added share archive tests for round trips, version mismatch warnings,
  dry-run conflicts, forced imports, and corrupted archive handling.
- Added `validateModelChoice` unit tests and CLI integration cases for
  unknown / known / forced-unknown configure flows.
- Added context-window validation integration tests for known / over-cap
  / over-cap-with-force combinations.
- Added SDK policy bridge tests for the Claude-to-Clio tool mapping and
  for `allow|block|ask` evaluation across modes.
- Added worker stdin demultiplexer tests covering happy path, stdin EOF,
  timeout, and chunked-line delivery.
- Added a dispatch approval handshake integration test that drives a
  stub worker over `spawnNativeWorker` and asserts the response reaches
  the worker over stdin.
- Added e2e coverage for the tool-approval TUI overlay, the
  `--auto-approve` flag, and the `(runtime x mode x env)` permission
  matrix for the five subprocess CLI runtimes.
- Added unit tests pinning the new `clio_tool_finish` emit shape for
  each SDK decision path (policy allow, policy block, autoApprove allow,
  autoApprove deny, supervised IPC allow, supervised IPC deny).

## 0.1.7 - 2026-05-11

Clio Coder 0.1.7 is a safety architecture release. It moves Clio beyond
blacklist-only Bash defense by sharing one policy evaluator across the
orchestrator and native workers, adding default-deny Bash admission, exposing
typed execution tools, tightening dispatch scope, and making receipts/audit
rows stronger evidence for reproducible runs.

### Added

- Added a shared safety policy engine for orchestrator and native workers.
  It composes `damage-control-rules.yaml` base/dev/super packs, snapshots
  project policy, and returns structured allow/elevate/block decisions with
  rule id, reason code, policy source, command, cwd, mode, and action class.
- Added strict `.clio/safety.yaml` parsing for project command policy. Invalid
  policy fails closed for command execution, and the active run keeps the
  validated snapshot so a model cannot edit the allowlist and use it in the
  same run. Project policy `cwd` must be relative to the policy root and may
  not escape it via `..`; entries that omit `cwd` are bound to the policy root.
  Default-mode bash with a caller `cwd` outside the workspace is rejected as
  `bash-cwd-escape`. Bash redirect targets are classified against the call's
  `cwd` argument so a relative redirect cannot launder a write outside the
  workspace.
- Added typed execution tools: `git_status`, `git_diff`, `git_log`,
  `run_tests`, `run_lint`, `run_build`, and `package_script`. These use fixed
  argv vectors, bounded cwd, timeouts, output caps, and structured result
  details.
- Added receipt safety summaries with decision counts, blocked attempts,
  worker mode, dispatch scope, requested action classes, runtime limitations,
  cwd, git branch/commit, dirty-state hash, rule-pack hash, and project policy
  fingerprint.

### Changed

- Native worker safety now enforces the same base hard blocks as the
  orchestrator, including remote install pipe-to-shell patterns, block-device
  writes, filesystem creation, fork bombs, and destructive git patterns.
- Default-mode Bash is now L4-style default-deny for ordinary execution. Common
  curated commands remain available; arbitrary Bash requires project policy or
  super elevation, and base hard blocks remain hard blocks in every mode.
- Dispatch admission now honors `MODE_MATRIX[mode].dispatchScope` and derives
  requested action classes from the actual worker recipe/tool surface instead
  of assuming every worker only reads.
- Claude Code CLI/SDK and other external runtimes are treated as delegated
  sandboxes. Clio no longer maps super mode directly to external full-access
  bypass unless `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` is set.
- Built-in default worker recipes prefer typed execution tools over Bash.
- Audit JSONL tool-call rows now carry policy provenance fields such as rule
  id, reason code, policy source, command, cwd, and policy hash where
  available.

### Tests

- Added unit coverage for project safety policy validation, active-run policy
  snapshots, default-deny Bash behavior, worker safety parity, dispatch action
  derivation, typed safe execution, and external runtime permission hardening.
- Extended receipt tests to assert blocked-attempt safety summaries and
  reproducibility metadata.

## 0.1.6 - 2026-05-04

Clio Coder 0.1.6 is a focused pi-coding-agent parity cut. It starts the
missing Phase 16 automation surface with a real text print mode while keeping
the implementation native to Clio's endpoint-first runtime, prompt compiler,
session, safety, receipt, and audit architecture.

### Added

- Added top-level `clio --print` / `clio -p` for one non-interactive
  orchestrator turn. The command runs through the same configured Clio
  orchestrator target and prompt compiler as the TUI, then prints only the
  assistant text to stdout.
- Added stdin plus argv prompt composition for print mode, matching the
  practical pi-coding-agent `-p` workflow for shell pipelines.
- Added a stdout guard for print-mode plumbing so startup chatter, usage, and
  diagnostics are routed to stderr while stdout remains script-friendly.

### Changed

- Reserved `--mode json` and `--mode rpc` behind explicit errors instead of
  silently treating them as ordinary subcommands. JSONL and RPC execution
  remain the next Phase 16 slices.

### Tests

- Added unit coverage for print-mode argument parsing, initial-message
  composition, and stdout guarding.
- Added end-to-end CLI coverage with a local OpenAI-compatible SSE fixture for
  `--print`, stdin merge, empty prompt errors, and reserved JSON mode.

## 0.1.5 - 2026-05-03

Clio Coder's first public alpha release. This release is intended for
developers and research-software teams who want to test a terminal-first
coding agent on real repositories while keeping human review, explicit tool
permissions, receipts, and audit trails in the loop. It is experimental:
interfaces may change, rough edges remain, and source install is still the
recommended path.

### Product highlights

- Interactive terminal UI for repository work, including a workspace
  dashboard, slash commands, model switching, receipts, cost and usage
  inspection, hotkeys, session navigation, and persistent chat state.
- Target-first model configuration for local servers, cloud APIs, and
  CLI-backed assistants. Targets can be probed, listed, selected, and routed
  separately for chat and worker agents.
- Built-in coding agents for scouting, planning, review, implementation,
  debugging, regression scouting, benchmarking, memory curation, evolution
  planning, and scientific validation.
- Persistent sessions with resume, fork, compact, replay, `/new`, and
  branch-aware navigation. `clio init` and `/init` create a checked-in
  `CLIO.md` project guide and local fingerprint state.
- Workspace orientation through the welcome dashboard and `workspace_context`
  tool, plus codewiki indexing and lookup tools for entry points and symbols.
- Safety modes for default, advise, and super workflows. Privileged actions
  require explicit confirmation, protected artifacts are tracked, and
  finish-contract advisories flag completion claims without recent validation
  evidence.
- Receipts and audit logs for run metadata, usage, tool activity, mode
  changes, aborts, and session lifecycle events.
- Evidence and eval workflows for building inspectable evidence corpora from
  runs, sessions, receipts, audit rows, and eval results, then comparing
  baseline and candidate runs.
- Scoped memory records that must be approved and evidence-linked before they
  are injected into prompts under a fixed budget.
- TUI hardening for long tool output, thinking blocks, usage accounting,
  model selection, popup framing, and terminal-width-sensitive rendering.

### Added

- Added `clio init` and `/init` to bootstrap `CLIO.md` plus local
  `.clio/state.json` fingerprint state.
- Added CLIO.md parsing, serialization, project fingerprinting, and session
  lifecycle state refresh for project context.
- Added codewiki indexing and lookup tools for repository entry points and
  symbols.
- Added clearer `/cost` accounting for fresh input, cached prefix reads,
  output, reasoning, model requests, and processed totals.
- Added a redesigned `/model` popup with summary counts, stable model
  metadata columns, filtering, selected-row details, and terminal-width
  guards.
- Added CLIO-branded popup frames across the interactive overlays.

### Changed

- Project context injection now loads `CLIO.md` only. `CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, and `CODEX.md` are read during `/init` and folded
  into `CLIO.md`; they are no longer walked and merged on every turn.
- Model capability resolution now follows the selected wire model instead of
  assuming the endpoint default.
- Session replay caps oversized retained content so resumed sessions do not
  resend unbounded historical payloads.
- Local usage accounting now exposes provider-reported cached prefix reads
  without treating them as hidden conversation history.
- Tool and thinking rendering now keeps long, streaming, and structured
  output readable in the chat panel.

### Alpha notes

- The recommended install path is still from source using the GitHub release
  tag. npm distribution is planned but not yet available under
  `@iowarp/clio-coder`.
- Clio Coder can execute tools in your repository. Review privileged actions,
  use safety modes intentionally, and do not treat the assistant as an
  unattended production operator.
- Model behavior depends on the target you configure. Quality, tool calling,
  reasoning, context length, and usage reporting vary by target.
- The full release gate is `npm run ci`, covering typecheck, lint, unit,
  integration, boundary, build, and end-to-end tests.

## 0.1.4 - 2026-04-30

The v0.1 evolution-plane release. v0.1.4 lands the components registry
(M1), typed change manifests (M2), the deterministic evidence corpus
builder (M3), the middleware domain with tool-surface enforcement (M4),
protected-artifact safety logic and persistence (M5), the advisory
finish-contract check (M6), the local eval runner with baseline and
candidate comparison (M7), the long-term memory domain with bounded
prompt injection (M8), eight new specialist agent recipes (M9), and a
scientific-validation pack covering HPC and scientific repositories
(M10). The same gated memory section reaches both interactive turns and
worker subprocesses, so `clio run` and the chat-loop see identical
lessons. A workspace-orientation pass surfaces cwd, project type,
branch, dirty flag, and recent commits in the welcome dashboard and
exposes the same snapshot to agents through a new `workspace_context`
tool. Engine fidelity gains pi-parity compaction, anchored context
accounting, a status-indicator domain, and a richer chat-loop replay
path. No breaking changes. No settings migration required. Sessions,
receipts, and audit JSONL written by v0.1.3 remain readable.

### Added - components

- `clio components` lists read-only harness components with stable
  ids, SHA-256 content hashes, authority, reload class, and owner
  metadata. `clio components --json` emits a stable snapshot envelope.
- `clio components snapshot --out <path>` writes that envelope to
  disk. `clio components diff --from <snapshot-a.json> --to
  <snapshot-b.json>` compares two snapshots and summarizes added,
  removed, changed, and unchanged components.
- The scanner inventories prompt fragments, agent recipes, tool
  implementations and helpers, runtime descriptors, safety rule
  packs, config and session and receipt schemas, context files, doc
  specs, and memory.

### Added - evolve

- `clio evolve manifest init|validate|summarize` creates, validates,
  and summarizes typed change manifests for auditable harness
  improvement proposals.
- Manifest validation enforces version 1, required iteration id, base
  git sha, and per-change rollback plan, requires at least one
  component id or changed file per change, requires predicted
  regressions for high-authority changes, and admits empty evidence
  refs only for the first exploratory iteration.

### Added - evidence

- `clio evidence build --run <runId>`, `clio evidence build --session
  <sessionId>`, `clio evidence build --eval <evalId>`, `clio evidence
  inspect <evidenceId>`, and `clio evidence list` create and inspect
  deterministic evidence artifacts from dispatch run ledger, receipt,
  session, audit, and eval data.
- Evidence artifacts link available session entries and audit JSONL
  rows into `transcript.md`, `audit-linked.jsonl`,
  `tool-events.jsonl`, `overview.json`, and `findings.json` without
  requiring model calls.
- Findings are tagged with the closed evidence taxonomy
  (`auth-failure`, `blocked-tool`, `build-failure`,
  `context-overflow`, `cwd-missing`, `destructive-cleanup`,
  `missing-dependency`, `no-validation`, `protected-artifact`,
  `provider-transient`, `proxy-validation`, `test-failure`,
  `timeout`, `tool-loop`, `wrong-runtime`, plus link-quality tags).

### Added - eval

- `clio eval run --task-file <tasks.yaml> --repeat <n>` runs
  repo-local YAML eval tasks through explicit setup and verifier
  subprocess commands, persists local eval result artifacts under
  `<dataDir>/evals/<evalId>.json`, and `clio eval report <evalId>`
  summarizes pass/fail counts, token and cost totals, wall time, and
  failure classes.
- Eval runs build deterministic evidence artifacts under the existing
  evidence store, link the generated evidence id back into each eval
  result, and can be rebuilt with `clio evidence build --eval
  <evalId>`.
- `clio eval compare <baselineEvalId> <candidateEvalId>` compares
  persisted eval artifacts by `taskId` plus `repeatIndex`, reporting
  matched, added, missing, regression, improvement, unchanged,
  failure-class, token, cost, wall-time, and pass-rate deltas.

### Added - memory

- `clio memory list`, `clio memory propose --from-evidence
  <evidenceId>`, `clio memory approve <memoryId>`, `clio memory
  reject <memoryId>`, and `clio memory prune --stale` manage scoped,
  approved, evidence-linked local memory records under the XDG data
  directory without model calls.
- Interactive turns inject a compact, deterministic memory section
  into the system prompt when approved, evidence-linked, in-scope
  memory is available. The section is hard-capped at 5 records and
  ~400 tokens, only selects approved memory with at least one
  evidence ref and no recorded regressions, and is omitted entirely
  when no memory applies. Backed by a new dedicated `memory.dynamic`
  prompt fragment so the section never grows unbounded.
- The memory store is bounded at 500 records. Approved records become
  stale after 180 days without verification; unapproved records
  become stale after 30 days.

### Added - middleware

- A pure middleware domain ships with a deterministic hook runner for
  future policy wiring. Eleven hooks (`before_model`, `after_model`, `before_tool`,
  `after_tool`, `before_finish`, `after_finish`, `on_blocked_tool`,
  `on_retry`, `on_compaction`, `on_dispatch_start`,
  `on_dispatch_end`) and six effect kinds (`inject_reminder`,
  `annotate_tool_result`, `block_tool`, `protect_path`,
  `require_validation`, `record_memory_candidate`) are admitted.
- Interactive tool execution invokes middleware `before_tool` and
  `after_tool` hooks around admitted tool runs without changing tool
  behavior.
- Dispatch carries a worker-safe declarative middleware snapshot into
  worker runs so native worker tools replay no-op middleware hooks
  from data instead of loading middleware code dynamically.

### Added - safety / protected artifacts

- Pure protected-artifact safety logic ships for deterministic
  protection state updates, validation command detection, and
  conservative destructive command classification.
- Protected artifact protection events are persisted as session
  entries and exported into deterministic evidence artifacts,
  including `protected-artifacts.json`.

### Added - finish-contract

- Interactive turns run an advisory finish-contract check that warns
  when an assistant completion claim has no recent validation
  evidence or explicit limitation. Recorded in evidence and consumed
  through the middleware `before_finish` and `after_finish` hooks.

### Added - workspace orientation

- `src/domains/workspace/` ships three pure probes: a git probe (branch,
  dirty flag, remote URL, recent commits) with scratch-repo tests, a
  project-type detector that reads manifest files, and a `probeWorkspace`
  aggregator that returns a stable snapshot.
- The session domain captures a workspace snapshot at session bind so
  resume and fork replay see the same orientation the first turn saw.
- A new `workspace_context` tool exposes that snapshot to the model in
  one call. Prompts that previously fabricated workspace facts or
  hand-rolled `.git/HEAD` reads now invoke the tool once and finish in
  roughly five seconds with correct facts.
- The interactive welcome dashboard renders a workspace panel showing
  cwd, project type, branch, dirty flag, and remote URL. Idle context
  usage shows `idle` with a dim bar before the first user turn instead
  of a stale percent.
- Mode prompt fragments and `MODE_MATRIX` enumerate the new tool so it
  is visible in `default`, `advise`, and `super` modes; the
  action-classifier admits it; and the boundary test
  `tests/boundaries/mode-fragments-tool-truth.test.ts` enforces parity.

### Added - agents

- Eight new built-in agent recipes ship under
  `src/domains/agents/builtins/`: `memory-curator` (advise) drafts
  candidate memory records from evidence, `debugger` (advise)
  produces root-cause analysis with failure class and recommended
  component changes, `regression-scout` (advise) maps risk surfaces
  and targeted negative tests, `middleware-author` (advise) drafts
  declarative middleware rules with test cases, `attributor`
  (advise) produces per-change keep/rollback recommendations from
  baseline and candidate evals, `evolver` (advise) drafts a
  `change_manifest.json` and minimal implementation plan,
  `benchmark-runner` (default) executes eval suites and summarizes
  failure classes and budget notes, and `scientific-validator`
  (advise) drafts validation contracts from a scientific task and
  artifact list.
- Built-in recipe enumeration is regression-tested; new recipes are
  picked up by `clio components` automatically.

### Added - scientific-validation

- A scientific-validation pack ships as a docs/spec at
  `docs/specs/scientific-validation.md` plus the
  `scientific-validator` agent recipe.
- The spec covers the YAML validation contract format, supported
  artifact families (HDF5, NetCDF, Zarr, FITS, CSV, Parquet, VTK,
  ParaView output, Slurm output, MPI rank-sensitive tests, checkpoint
  files, simulation restart artifacts, plots), and the three
  declarative rule intents.

### Added - dispatch / worker memory

- `DispatchRequest` and `JobSpec` now carry an optional
  `memorySection?: string` field. `dispatch.buildSystemPrompt`
  prepends the section to whichever base prompt wins
  (`req.systemPrompt` or `recipe.body`) with a blank-line separator;
  an empty section is a no-op.
- `cli/run.ts` loads memory records via `loadMemoryRecordsSync`,
  calls `buildMemoryPromptSection`, and passes the resulting string
  through `DispatchRequest.memorySection`. Workers see the same
  gated memory the chat-loop sees, with the same scope and budget
  defaults. The worker isolation invariant is unchanged because no
  new `src/domains/**` import enters `src/worker/**`.

### Changed - providers and runtimes

- A unified `llamacpp` runtime replaces the four surface-specific
  variants in the configure menu. The unified descriptor defaults to
  `/v1/chat/completions`, the universal surface for any modern `--jinja`
  llama-server build. The legacy ids (`llamacpp-anthropic`,
  `llamacpp-completion`, `llamacpp-embed`, `llamacpp-rerank`, and
  `lemonade-anthropic`) stay registered for back-compat with existing
  `settings.yaml` but are marked hidden. The Local HTTP menu drops from
  eleven entries to seven (`openai-compat`, `lemonade`, `llamacpp`,
  `lmstudio-native`, `ollama-native`, `sglang`, `vllm`). Power users can
  still see hidden ids with `clio configure --list --all`.
- `clio doctor` warns on every endpoint pinned to a legacy hidden alias
  and rewrites `runtime: llamacpp-completion` to `runtime: llamacpp`
  when `--fix` is on. The other legacy ids encode intent the unified
  descriptor does not preserve, so they get a warn-only manual hint.
- `RuntimeDescriptor` gains a `hidden` flag; `ProbeResult` gains
  `chatApiFamily` and a `ProbeSurfaceMap` so composite local descriptors
  record which inference surfaces they probed and which they will use
  for chat. `listProviderSupportEntries` accepts a new
  `ListProviderSupportOptions` so `clio configure --list --all` can
  surface hidden aliases.

### Changed - interactive TUI

- The `/model` picker scales between 60 and 120 columns based on
  `terminal.columns` so descriptions no longer truncate mid-word on wide
  terminals. The picker also suppresses the `auth=not-required` badge
  for local-tier endpoints where it is always redundant.
- Idle context usage shows `idle` with a dim bar when no user traffic
  has occurred, matching the welcome-dashboard contract.
- Pressing Esc while a modal overlay is open now closes the overlay
  instead of falling through to cancel the active run. Previously the
  inline cancel path stole the keystroke and required a second press,
  and in some flows the super-mode overlay's orphaned state silently
  elevated the session. Ctrl+C is unchanged.
- The thinking preview clips to terminal width instead of wrapping into
  the rail prefix, fixing layout drift on narrow terminals.
- Every subcommand accepts `--help` consistently. `clio components list`
  is now an explicit alias of `clio components`. `clio agents --help`,
  `clio components --help`, `clio upgrade --help`, and `clio run --help`
  all print full usage instead of defaulting to top-level help.

### Changed - engine parity

- Compaction now mirrors pi `prepareCompaction`: split-turn compaction
  summarizes pre and turn-prefix separately through a turn-prefix prompt
  template; iterative compaction respects the prior `compactionSummary`
  as a lower bound so prior summaries are never re-fed to the
  summarizer; and after compact, `agent.state.messages` is rebuilt via
  `buildReplayAgentMessagesFromTurns(deps.readSessionEntries())` to
  preserve the kept suffix, mirroring pi `_runAutoCompaction`'s
  `agent.replaceMessages(buildSessionContext().messages)`. Overflow
  recovery prunes the failed assistant before compact and re-prompts
  with the same user request.
- Context accounting moves to `src/domains/session/context-accounting.ts`
  with a provider-bound `estimateAgentContextTokens` that anchors on the
  last assistant usage and guards with `max(projection, anchored)`. The
  welcome dashboard percent now derives from live agent state instead of
  cumulative billing tokens. `extractReasoningTokens` handles the
  scattered provider shapes (`reasoningTokens`,
  `output_tokens_details.reasoning_tokens`,
  `completion_tokens_details`).
- A new `src/interactive/status/` controller adds a phase state machine,
  watchdog tiering, and an overlay frame stack for tool, retry, compact,
  and dispatch states. The footer and chat panels surface the agent verb
  plus a turn summary line. Safety audits alarmable status transitions
  (`stuck`, `tool_blocked`, `retrying`, `cancelled`).
- Rich assistant payload persistence carries content blocks, usage, api,
  provider, model, and `responseId`. Provider-shaped replay reconstructs
  `AgentMessages` from session entries with full content shape preserved.
  Ctrl+T thinking visibility now applies across the entire transcript
  instead of toggling only the most recent block. Reasoning tokens
  surface only when usage payloads expose them.

### Changed

- Tool registry middleware hooks enforce generic tool-surface
  effects: `block_tool` stops an admitted call before execution, and
  `annotate_tool_result` appends deterministic middleware
  annotations to tool results. The built-in middleware registry is
  empty until rules have enforced behavior and tests.
- Tool registry middleware hooks honor `protect_path` effects in
  in-memory protected-artifact state, pass validation command
  metadata to middleware, and block protected artifact writes or
  destructive bash commands before tool execution.
- Protected artifact state is rehydrated from session entries on
  interactive startup and session switches so protection survives
  resume, tree branch selection, and fresh-session resets.
- Memory operations share a single record clone helper instead of
  two near duplicates, and memory drops the unused domain-module
  wrapper (manifest, contract, extension) that no consumer
  registered. Consumers import directly from
  `src/domains/memory/index.ts`.

### Fixed

- Worker subprocesses register the Clio API providers
  (`lmstudio-native`, `ollama-native`) before any agent run, so `clio
  run` against a local-server target no longer fails with `No API
  provider registered for api: lmstudio-native`.
- `workspace_context` is reachable end-to-end. `MODE_MATRIX` for
  `default`, `advise`, and `super` enumerates the tool, the
  action-classifier admits it, and prompts that previously fabricated
  workspace facts now invoke the tool once and answer from real data.
- Cancelling a write through the super-mode confirmation overlay now
  blocks the same write through bash redirection, `tee`, `cp`, and `mv`.
  `extractCommandWriteTargets` parses shell write-targets out of bash
  commands; the action-classifier feeds each through the same
  `writePathClass` gate the write tool uses; `damage-control-rules.yaml`
  gains belt-and-suspenders kill switches for shell redirect or `tee`
  into `/etc`, `/usr`, `/var` (excluding `/var/tmp`), `/bin`, and
  `/sbin`. The active agent run is hard-stopped on super-mode cancel so
  pi-agent-core does not auto-continue past the parked-call rejection.
- The bash subprocess abort grace measures elapsed time on a monotonic
  clock so the SIGTERM-to-SIGKILL escalation no longer drifts under
  wall-clock adjustments.
- A dead `providers-overlay.diag.ts` (224 LOC of TUI-mocking code that
  violated the project's "don't mock pi-tui" rule, never bundled by
  tsup, never referenced) is removed.

### Notes

- Pi SDK pin remained on the previous package line. Engine
  boundary, worker isolation, and domain independence invariants
  unchanged.
- Default safety mode remains `default`; `advise` and `super` modes
  unchanged from v0.1.3.
- v0.1.x runtime tier is still `native` only; `sdk` and `cli` tiers
  remain scaffolded and rejected by dispatch until v0.2.
- Memory is intentionally not domain-modulated. The chat-loop and the
  worker dispatch path are the two consumers of
  `buildMemoryPromptSection`.
- Middleware effects honored by the tool registry this slice are
  `block_tool`, `annotate_tool_result`, and `protect_path`.
  `record_memory_candidate` is declarative metadata only; future slices
  wire memory candidate emission through the `memory-curator` agent
  recipe.
- Test counts at tag time: 944 unit, integration, and boundary tests
  green; 53 e2e tests green. Lint covers 477 source files.

## 0.1.3 - 2026-04-27

Polish release on top of v0.1.2. Four user-visible TUI improvements
(live tool output, bash echo, Ctrl+T thinking, footer git branch),
local-runtime hardening for LM Studio and Ollama, CLIO.md as the
canonical project instruction file, identity alignment with IOWarp's
CLIO ecosystem of agentic science, two CI substrate fixes, and a
clean-clone smoke job to catch
dev-env-only test passes before the next tag. No breaking changes.
No settings migration required. Sessions, receipts, and audit JSONL
written by v0.1.2 remain readable.

### Added - interactive TUI

- Live tool output. `tool_execution_update` events stream into the
  expanded tool block as they arrive, with a dim `(running...)`
  marker that disappears on `tool_execution_end`. Long-running
  `bash`, `grep`, and shell commands no longer leave the block empty
  until exit. Capped at 12 visible lines with `... N more lines
  hidden` overflow; latest output is preserved.
- Bash command echo. Successful `bash` results render
  `$ <full-command>` on its own line under the rail before the
  output, matching what you would see in a real terminal. Errors
  stay on the standard red-rail path so the failure signal is not
  diluted.
- `Ctrl+T` toggles the most recent assistant turn's thinking block
  between a one-line dim preview and the full rail-prefixed body.
  Symmetric with the existing `Ctrl+O` tool-segment toggle.
  Registered as `clio.thinking.expand` (default `ctrl+t`); rebindable
  via `settings.yaml` and surfaced in `/hotkeys`.
- Footer git-branch slot. The status footer reads `branch:<name>`
  when launched from inside a git repository. Resolves once at boot
  via a new `src/utils/git.ts` helper with a 1s timeout and a null
  fallback for non-repos, missing `git`, or timeouts. No live
  refresh in v0.1.x; cwd changes during a session leave the slot
  stale until the next boot.

### Added - project context loading

- CLIO.md is the canonical project instruction file and is
  auto-loaded by walking from the working directory upward. The
  loader merges CLAUDE.md, AGENTS.md, CODEX.md, and GEMINI.md into
  the same compiled prompt, with CLIO.md winning on conflicts.
  `--no-context-files` (alias `-nc`) still skips the entire chain.

### Added - local runtimes and discovery

- `clio targets convert <id> --runtime <runtimeId>` rewrites an
  existing endpoint's runtime in place. Use it to migrate
  `openai-compat` targets pointing at LM Studio or Ollama onto
  their native runtimes without re-entering credentials.
- `clio doctor` fingerprints `openai-compat` URLs and warns when
  the URL responds as LM Studio or Ollama, suggesting the convert
  command.
- `clio configure` and `clio targets add` detect native local
  servers on the entered URL and offer to switch the runtime to the
  native counterpart at setup time.
- Native local-server residency and routing become the default for
  detected local targets, replacing the prior generic openai-compat
  path.

### Changed - local runtimes

- `lmstudio-native` evicts non-target loaded models before each
  prompt (within a 60-second cache) so the active model owns VRAM
  and does not spill into system RAM.
- `lmstudio-native` passes `verbose: false` to the LM Studio SDK by
  default so the runtime no longer prints upstream JIT-load progress
  lines on every prompt. Set `CLIO_RUNTIME_VERBOSE=1` to restore the
  verbose stream.
- `ollama-native` pins the active model with `keep_alive: -1`. The
  chat-loop hot-swap path fires a one-shot `keep_alive: 0` sweep
  against other resident models so the prior pinned weights release.
- `llamacpp-completion` and `llamacpp-anthropic` probes report a
  diagnostic note when the configured wire model id does not match
  the server's single loaded model.

### Changed - identity

- Clio Coder is positioned as the coding agent inside IOWarp's CLIO
  ecosystem of agentic science, targeting HPC and scientific-
  software developers across the NSF-funded IOWarp project. The
  system prompt fragment, CLIO.md identity section, README,
  package.json description and keywords, CLI help text, orchestrator
  banner subtitle, and chat-loop fallback identity all reflect the
  new positioning. Architecture, engine boundaries, runtime
  selection, and test surfaces are unchanged.

### Changed - packaging and docs

- `package.json` `files` no longer references AGENTS.md, STATUS.md,
  or GOVERNANCE.md (the files were never shipped). CLIO.md is
  published instead.
- README.md and CONTRIBUTING.md document CLIO.md instead of
  AGENTS.md.

### Changed - safety rule packs

- `damage-control-rules.yaml` is restructured under schema v2 as a
  named `packs[]` list. Historic kill-switches stay under `base`
  and elevated rules stay under `super`, keeping normal operation on
  the base pack alone.

### Changed - CI

- The runner installs `fd-find` on `ubuntu-latest` so slash-
  autocomplete `@path` completion is exercised on every push.
- A new `clean-clone-smoke` job runs the full gate against a fresh
  shallow checkout with no npm cache, catching dev-tree-only test
  passes before tagging instead of after.

### Fixed

- Slash-autocomplete `@path` completion resolves `fd` or `fdfind`
  from PATH instead of hardcoding `fd`. Fixes the autocomplete on CI
  and on Debian/Ubuntu users who installed the `fd-find` apt
  package.
- `clio doctor --json` returns `{ok, fix, findings}`; `clio targets
  --json` returns `{targets: [...]}`. Both are now stable JSON
  envelopes with room for forward-compatible top-level fields.
- The streaming partial path coerces non-text `partialResult`
  envelopes through `previewResult` instead of `String(...)`. Tools
  that emit non-text partials (e.g. Task partials carrying
  `{ elapsedTimeSeconds, taskId }`) no longer render as
  `[object Object]` under the rail.

### Notes

- Pi SDK pin remained on the previous package line. Engine
  boundary, worker isolation, and domain independence invariants
  unchanged.
- Default safety mode remains `default`; `advise` and `super` modes
  unchanged from v0.1.2.
- v0.1.x runtime tier is still `native` only; `sdk` and `cli` tiers
  remain scaffolded and rejected by dispatch until v0.2.

## 0.1.2 - 2026-04-25

### Added

- Interactive chat now retries transient provider and stream failures using
  session retry settings. Retry boundaries, cancellation, exhaustion, and
  recovery are visible in the transcript and persisted for resume/fork replay.
- Tool and bash transcript lines now show clearer running/success/error status
  with bash command previews and elapsed time in live and replayed transcripts.
  Tool segments collapse by default with per-tool sublines, and `Ctrl+O`
  toggles full-output expansion through the keybindings manager.
- Edit-tool results render a unified diff preview alongside the structured
  tool-execution block.
- Settings overlay exposes retry controls (`retry.enabled`, `retry.maxRetries`,
  `retry.baseDelayMs`, `retry.maxDelayMs`) so users can tune retry behavior
  without hand-editing `settings.yaml`.
- The interactive TUI now opens with a Clio Coder dashboard showing target,
  model registry, context, latency, and worker-profile status. Interactive
  startup no longer prints a separate legacy banner above the dashboard.
- `/hotkeys` supports row selection, a read-only keybinding detail panel, and
  legacy-terminal warnings when user bindings require CSI-u support.
- Editor prompt rails reflect the active mode: default uses the terminal
  foreground, advise uses amber, super uses red.
- Slash-command autocomplete: typing `/` opens a filtered dropdown of every
  built-in command, and Tab accepts the selected entry.
- `/resume` picker now shows a one-line conversation preview, message count,
  and relative time per session.
- Prompt assembly auto-loads project context files (`AGENTS.md`, `CODEX.md`,
  `CLAUDE.md`) walking from the working directory upward; pass
  `--no-context-files` (alias `-nc`) to disable.
- Run receipts now carry per-tool stats (loops, errors, blocked attempts,
  parallel batches) emitted by worker telemetry hooks.
- `clio targets --json` exposes `detectedReasoning` and
  `reasoningCandidateModelId` so the `/thinking` probe state is observable
  from the CLI.
- Compaction summaries persist `triggerReason` and `tokensAfter` in the
  session entry stream, leaving a queryable trail for every `/compact`.
- Audit JSONL is now a five-arm discriminated union over `kind`: `tool_call`,
  `mode_change`, `abort` (sources `dispatch_abort`, `dispatch_drain`,
  `stream_cancel`), `session_park`, `session_resume`. Safety subscribes on
  start, unhooks on stop, and fsyncs every row. Integration coverage lives
  in `tests/integration/audit-{mode-transitions,run-aborts,session-lifecycle}.test.ts`.
- `tools.web_fetch` honors the abort signal end-to-end; bash abort coverage
  now includes a success-then-abort guard.

### Changed

- Slash-command help and autocomplete present only canonical commands:
  `/model`, `/quit`, and `/receipts [verify <runId>]` replace duplicate
  spellings such as `/models`, `/exit`, and `/receipt verify <runId>`.
- Provider catalog and cloud defaults realign with the then-current `pi-ai`
  package line.
- Worker tool-call path validates once and threads telemetry hooks so the
  agent loop, dispatch board, and receipts share one source of truth.
- Mode fragments must now enumerate the matrix tool set; a new regression
  test pins per-mode tool resolution and toggle re-resolution so future drift
  between `MODE_MATRIX` and the chat-loop fails fast.

### Fixed

- Retrying a transient failure continues from the existing user turn instead
  of duplicating it in model context.
- Cancelling an interactive run cancels any pending retry countdown and
  forwards abort signals into bash tool subprocesses.
- The last failed assistant message is pruned from live model context on
  every terminal exit of the retry chain so live state matches what
  `/resume` and `/fork` rebuild from the persisted transcript.
- A retryable error thrown from `agent.prompt` persists the original error
  as a visible failed assistant entry instead of surfacing only as a
  `[retry]` status line.
- Bash subprocess abort escalates to `SIGKILL` after a 5-second `SIGTERM`
  grace period so commands that trap or ignore `SIGTERM` no longer hang
  the chat-loop.
- Bash commands that exceed the 2 MB output cap report
  `command output exceeded N bytes` instead of a generic `SIGTERM`
  termination.
- `/resume`, `/fork`, and `/new` abort an in-flight agent run before
  reseating context so a pending retry-chain `agent.continue()` cannot race
  the new session's messages.
- Retry status lines render byte-identically in the live transcript and
  after `/resume` by sharing a single formatter.
- Streamed responses that emitted partial text before failing render both
  the partial output and the terminal error indicator together.
- Failed turns with empty usage no longer write zero-token rows to the
  observability ledger.
- User-facing product labels consistently say Clio Coder instead of mixing
  lowercase command-name branding into headers, prompts, and status text.
- Provider hot-swap on a same-endpoint model switch now updates the live
  agent without rebuilding the chat-loop, and stale model state is hardened
  on every swap surface.
- `lmstudio-native` preserves reasoning content, drops `<think>` tags, and
  forces `toolUse` on tool calls so `/thinking` and `clio run` behave on
  LM Studio backends.
- `openai-compat` tool schemas and reasoning probe align so `/thinking`
  and `clio run` work against local llama.cpp / vLLM / SGLang servers.
- Dismissing the Alt+S super-mode overlay emits a `request_cancelled`
  `mode_change` audit row instead of dropping the transition silently.

## 0.1.1 - 2026-04-24

### Added

- Interactive prompt compilation now loads project context files from the
  current working directory upward. `AGENTS.md` and `CODEX.md` are injected in
  deterministic parent-to-child order when present.

### Fixed

- Session resume, fork, and tree-switch replay now read the rich session entry
  stream instead of only legacy user/assistant turns, so compaction summaries,
  branch summaries, bash/tool entries, custom display entries, system notes,
  and checkpoints are visible when present.
- Interactive tool calls and results are now written as durable session entries
  so tool work remains visible after resume and fork.
- Resuming a session whose JSONL tail is metadata no longer resets the next
  turn parent to `null`; the interactive loop now derives the resumed leaf
  from the persisted tree.
- CLI-backed subprocess runtimes now dispatch through the native worker entry
  instead of running inline in the orchestrator process.
- Out-of-tree SDK runtime plugins now pass runtime descriptor validation and
  rehydrate correctly inside native worker subprocesses.
- `/receipt verify <runId>` now verifies a SHA-256 integrity field against the
  persisted run ledger entry instead of accepting schema-valid receipt JSON.
- Dispatch heartbeats now promote stale/dead worker states into run state and
  the live dispatch board instead of leaving silent workers marked running.
- `npm run check:boundaries` now exists for the boundary command documented in
  contributor guidance.

## 0.1.0-exp - 2026-04-24

First public release. Experimental. Expect moving surfaces; pin the tag if
you need a stable target.

### What ships

- **Interactive TUI.** Terminal chat with target and model controls, session
  navigation, resume/fork, markdown-rendered replies, configurable
  keybindings, a searchable resume picker, scoped-model cycling, a
  live-updating dispatch board, and receipts/cost overlays.
- **CLI lifecycle.** `clio`, `clio configure`, `clio targets`, `clio models`,
  `clio auth`, `clio doctor`, `clio reset`, `clio uninstall`, `clio agents`,
  `clio run`, `clio upgrade`, `clio --version`.
- **Target-first configuration.** Local HTTP engines, cloud APIs,
  OAuth/subscription runtimes, and CLI-backed runtimes all live in
  `targets[]`; `orchestrator` and `workers` point at those ids. Known and
  discovered models are surfaced through `clio models` and the TUI model
  selector.
- **Runtime coverage.** Native subprocess worker; protocol adapters for
  openai-compat, llamacpp, Ollama, vLLM, SGLang, LM Studio, Lemonade;
  cloud adapters for Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter,
  Bedrock; OAuth path for openai-codex (ChatGPT Plus/Pro via Codex);
  CLI-backed runtimes for Codex CLI, Claude Code CLI, Gemini CLI, Copilot
  CLI, OpenCode CLI; and a Claude Agent SDK worker path.
- **Seven builtin agents.** `scout`, `planner`, `researcher`, `reviewer`,
  `delegate`, `context-builder`, `worker`. Plain Markdown specs with
  frontmatter in `src/domains/agents/builtins/`.
- **Dispatch and workers.** `clio run` spawns OS-isolated worker
  subprocesses with NDJSON IPC and heartbeats. Named worker profiles
  let the interactive session fan out across multiple runtimes.
- **Receipts and audit.** Every run writes a receipt under
  `<dataDir>/receipts/<runId>.json` with token counts and USD cost.
- **Safety model.** Three modes (`default`, `advise`, `super`) gate tool
  visibility at the registry. Hardcoded Bash kill-switches live in
  `damage-control-rules.yaml`.
- **State layout.** XDG-aware, with `CLIO_HOME` plus `CLIO_CONFIG_DIR` /
  `CLIO_DATA_DIR` / `CLIO_CACHE_DIR` overrides for sandboxed installs.

### Known limits

- Windows is best-effort until a later release.
- Some runtime slots (remote fan-out, broader MCP) are scaffolded but not
  admitted by dispatch yet.

### Verification

- `npm run ci` gates typecheck, lint, unit/integration/boundary tests,
  production build, and e2e spawn + pty tests.

# 2026-07-13 — Proactive memory WS0: session task bank

- Added a bounded, in-memory task bank with private status, knowledge, and
  procedural entries; stable IDs on updates; oldest-untouched eviction; compact
  budgeted rendering; injection attribution; and detached JSON snapshots.
- Kept the execution-state bank separate from durable approved memory and the
  repository context engine. It performs no disk writes and has no approval or
  repository-identity fields.
- Added contract coverage for all bank operations, caps and eviction order,
  rendering limits, status privacy, content normalization, injection counts, and
  snapshot isolation.

# 2026-07-13 — Proactive memory WS1: rules-only intervention

- Added a synchronous middleware registration that observes a bounded tool
  trajectory, records error attempts idempotently by canonical fingerprint, and
  emits one cited advisory only after the same failure repeats.
- Added post-compaction knowledge reactivation through the existing visible,
  persisted `inject_reminder` channel. The private status and procedural history
  are excluded from this deterministic compaction reminder.
- Registered the rules-only tier beside the task-board reminder. It defaults on,
  makes no model calls, and has explicit disabled-path coverage proving zero
  effects and zero bank writes.
- Extended reminder severity with the additive, non-blocking `advisory` value so
  memory attribution remains literal in middleware effects and ledger entries.

# 2026-07-13 — Proactive memory WS2: background model plane

- Added an explicitly optional `background` session-routing role across saved
  settings, live routing, Settings, the Targets Hub, and CLI target setup. It
  remains unset by default, and ordinary chat/fleet target selection never opts
  the operator into model-backed memory.
- Added the compact two-phase memory prompt and strict full-response parser.
  Valid output applies a prevalidated operation list atomically and in order,
  then either stays silent or emits one capped reminder. Malformed output applies
  nothing; spontaneous uncited reminders are gated while deterministic triggers
  retain authority.
- Added a lazy provider adapter for the selected background target plus a narrow,
  tool-free engine completion boundary. An unset role constructs no client and
  makes no call; model failures and hard timeouts collapse to silence.
- Added focused contracts for routing isolation, explicit opt-in surfaces,
  operation ordering, citation gating, parser atomicity, timeouts, client
  failures, and engine-boundary prompt assembly.

# 2026-07-13 — Proactive memory WS3: selective trigger cadence

- Added a serialized, awaited turn-boundary middleware phase for model-backed
  memory while retaining the original synchronous, no-I/O evaluator for all
  tool hooks and rules-only effects. Agent run settlement now includes this
  bounded phase; no completion is detached or concurrent.
- Added independently testable interval, consecutive-error, and consumed
  loop-guard triggers. Signals coalesce into one prompted step per turn
  boundary, the cadence resets after a step, and configuration rejects an
  every-tool cadence. Post-compaction reactivation remains deterministic and
  makes no model call.
- Added `memory.intervention.{enabled,everyNTools,windowSteps,maxTokens,timeoutMs}`
  to strict settings validation and the Settings Center. The live next-turn
  view controls both tiers, including the master kill switch, model deadline,
  trajectory bound, and reminder cap.
- Preserved one visible memory reminder per boundary: a prompted step may still
  apply phase-one bank writes when a synchronous reminder already won, while
  its phase-two output yields silently. Repeated model reminders are deduped.

# 2026-07-13 — Proactive memory WS4: operator visibility

- Added a read-only `/memory` overlay that places approved durable lessons and
  the active session task bank in one operator surface. The bank is grouped by
  private status, knowledge, and procedural class, with stable ids, injection
  counts, and the last completed memory-policy outcome.
- Added a shared live status projection to the welcome island and expanded
  session dashboard: intervention on/off, rules or LLM tier, and bank size.
  Responsive rows retain whole facts and drop overflow behind an ellipsis.
- Kept every visible intervention attributable with the `Memory:` prefix and
  verified the existing middleware-reminder ledger path in a scripted session.
  Added contracts for overlay contents, read-only Escape behavior, real-width
  fitting, slash-command discovery, status rendering, and outcome tracking.

# 2026-07-13 — Proactive memory WS5: handoff continuity

- Added a strict `clio-task-memory` handoff payload for knowledge and procedural
  entries. Export excludes private status, redacts secret-shaped values at the
  artifact boundary, rejects malformed or oversized payloads, and reads only
  the newest project handoff.
- Supplies that structured source only when `context-handoff` is explicitly
  requested. The updated skill copies the fenced payload as untrusted data into
  its ignored `.clio/handoffs/` artifact; ordinary turns receive no snapshot.
- On session changes the heap bank resets. After `/resume`, Clio offers explicit
  `/memory seed` when the newest handoff contains a snapshot; import is
  deduplicated and the master intervention switch disables both the offer and
  all seed writes. No worker-side intervention was added.

# 2026-07-13 — Proactive memory WS6: telemetry, evaluation, and operations

- Added speculation-style, content-free task-memory telemetry under the local
  state directory. Exact-schema JSONL rows record coalesced triggers, tier,
  count-only bank deltas, decision, citation count, model tokens, and latency;
  the 1 MiB rotating sink is best effort and cannot alter intervention.
- Added a fixed three-task A/B harness over baseline, rules-only, and LLM tiers.
  It accepts any target/model adapter, reports pass rate, reminder/citation
  selectivity, and baseline-relative token/latency cost, and treats always-on
  reminders without a pass-rate gain as a regression.
- Documented architecture, paper mapping, real settings and target surfaces,
  trigger semantics, handoff continuity, the dynamo/qwopus reference route,
  measurement criteria, and the event/steering seam for future worker-local
  memory. Worker behavior remains unchanged.

# 2026-08-04 — Durable run traces and local trace viewer

- Added a schema-versioned WAL SQLite mirror under the Clio state directory,
  fed best-effort from the canonical dispatch lifecycle/progress bus without
  adding backpressure to worker event ingestion.
- Added `clio trace runs|phases|tail|procs|sql` with strict read-only readers,
  the documented 500-row cursor contract, tool-call span folding, process
  lifecycle rows, gate evidence support, and itemized token/cost fields.
- Added the source-checkout-only `apps/trace-viewer` localhost application and
  `clio trace ui`: a no-framework, no-build waterfall, phase/tool drill-in,
  gate evidence, and truthful spend/context display over the trace database.
