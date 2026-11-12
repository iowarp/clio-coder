# Research campaigns and the arena

CLIO Coder has two ways to compare work by evidence instead of by impression:

- **`clio-coder research`** improves one measured number in your project, such as wall time, an error or a score. It
  runs CLIO Coder's own agent again and again and keeps a change only when the measurement shows a real improvement and every
  correctness check still passes.
- **`clio-coder arena`** gives one prompt to 2 to 4 target/model pairs side by side. You see their answers and diffs
  without knowing which model produced which, vote, and get standings from your votes.

Both commands work headless with `--json`. Both build on the project verifier catalog, `.clio-coder/verifiers.yaml`
(see [Project quality policies](quality-policy.md)). Both run every agent as a normal `clio-coder run` in a Git worktree,
so the same safety policy, cost accounting and run evidence apply, and your checkout is never edited. Every flag is
listed in [Commands and modes](commands-and-modes.md); this page explains how to use them and how they decide.

## When to use which

| You want to | Use |
| --- | --- |
| Make code faster, or move any numeric metric, without breaking an answer | `research start` |
| Know whether a gain is real or measurement noise | `research start` (its A/A check and bootstrap interval), then `research report` |
| Pick a model or target for a kind of task in your own repository | `arena run`, then `arena vote` and `arena standings` |
| See how two models approach the same bug before trusting either | `arena run --check <id>` |

Neither command judges quality with a model. Research decides from your checks and the measurements. The arena records
your vote and never grades a contender.

## Research: a verified hill climb

### Declare the objective and the gates

The objective is one key of the JSON a check prints. Correctness is a separate check that must pass on every candidate.
Commit `.clio-coder/verifiers.yaml` so that each research worktree contains it:

```yaml
version: 2
checks:
  - id: bench
    description: Wall time of stats.py on 3000 values (min is better)
    kind: command
    command: [python3, bench.py]   # prints {"wall_ms": 12.3}
    cwd: .
    timeoutMs: 60000
  - id: correct
    description: stats.py answers match the reference on a holdout input
    kind: numeric-compare
    command: [python3, check.py]
    reference: tests/reference/stats.json
    tolerance: { relative: 1.0e-9 }
    cwd: .
    timeoutMs: 60000
```

A `perf-budget` check works as an objective too: its `wall_ms` falls back to the measured duration. A `reproduce` check
cannot be an objective, but it can be a gate.

A sweep check (one with `runs: <directory>`, see [Parameter sweeps](slurm.md#parameter-sweeps)) takes one run at a
time, as `verify` does. `--check <sweep>/<run>` optimizes the metric of that run, and `--gate <sweep>/<run>` gates on
it; the run directory is appended to the check's command and is protected like every other file the check names. A
bare sweep id is refused as the objective, with the runs it holds listed, and as a `--gate` it gates on every run
directory present when the campaign opens, each recorded as its own `<sweep>/<run>` gate. Each worktree starts from
`HEAD`, so a run directory that is not committed, or has uncommitted changes, is refused when the campaign opens.

Install what the checks need in the project before the campaign starts, not through the agent. Each candidate is
measured and gated as its commit plus the environment its worktree had before the agent ran, such as installed
dependencies or build output a checkout step leaves. The worktrees sit under `.clio-coder/worktrees/` inside the
project, so a `node_modules` there resolves from them. That environment is read-only to the agent: a file added,
removed or changed inside it rejects the candidate unmeasured as `protected` ("changed the pre-agent environment").
Anything else the agent leaves untracked or ignored, a fresh install or a check's output included, is removed before
measuring, and the checks recreate their own output.

### Run a campaign

```bash
clio-coder research start --check bench --metric wall_ms --direction min \
  --max-iterations 5 --gate correct --scope stats.py --max-wall-minutes 30 \
  --goal "make stats.py faster without changing any answer"
```

`--max-iterations` is required. Add `--max-cost-usd` for a spend cap and `--target`/`--model` to choose the agent's
model. The campaign prints one line per step and ends with a summary:

```text
A/A: inconclusive (too few trials to judge the noise; raise --trials); inconclusive, median delta +5.15%, 95% CI [-14.69%, +21.51%]
  it-0001  ratcheted; improved, median delta -99.43%, 95% CI [-99.58%, -99.37%]; gates correct pass; cost unknown
  it-0002  not-improved; unchanged, median delta -3.28%, 95% CI [-20.43%, +33.28%]; gates correct pass; cost unknown
stopped: max-iterations: ran 2 of 2 iterations
```

The improved code is on the branch `clio/research/<id>`. Review it and merge it yourself:

```bash
git log --oneline clio/research/<id>
git diff HEAD clio/research/<id>
```

### How a change is judged

1. **A/A check.** Before the first iteration, the base is measured against itself with the same number of trials. If
   that already looks like a change, the measurement is too noisy to trust, and the campaign stops unless you pass
   `--allow-noisy`. The A/A line reads `quiet` only when the two medians stay inside `--min-improvement`. A larger
   move whose interval still spans zero reads `inconclusive (too few trials to judge the noise; raise --trials)`, and
   the campaign goes on.
2. **Agent run.** Each iteration runs `clio-coder run` at the campaign's `--autonomy` (`default` unless you choose
   `yolo`), with dispatch off, in a fresh worktree at the current best commit. The agent is told the objective, the
   gates, the scope and what earlier iterations tried.
3. **Rules before measuring.** The change is archived without measuring when it:
   - is a no-op;
   - repeats an earlier tree;
   - touches a protected path (the verifier catalog, every file the checks name including the executable, and the
     symlinks on the way to them);
   - changes a file outside `--scope`. Scope globs match dot segments too, so `**` covers `.github/` and `**/*.yml`
     covers `.github/workflows/ci.yml`.
4. **Measurement.** Base and candidate run in interleaved pairs (`--trials`, default 5). The change counts as improved
   only when two conditions hold:
   - the median moves by at least `--min-improvement` (default 5%) in the right direction;
   - a seeded bootstrap 95% interval (2,000 resamples) excludes zero.
5. **Gates.** Every `--gate` check, and a `numeric-compare` objective itself, must pass in the candidate's worktree.
   The objective and every gate, on the base and on the candidate, run inside the main-session sandbox rooted at their
   worktree, as host verification's checks do: credentials and secret files are hidden and writes stay in the worktree,
   the scratch roots and package caches. `safety.sandbox: off` runs them bare, as does `auto` on a host with no backend;
   `required` without a backend refuses them.
6. **Ratchet.** A kept change moves `clio/research/<id>` by compare-and-swap. If that fails because the ref moved, the
   change is archived as `ratchet-lost`. Your checked-out branch is never touched.

### Budgets and stopping

- `--max-iterations`, `--max-wall-minutes` and `--max-cost-usd` are hard stops. The wall deadline also cuts off the
  agent run, measurement or gate in flight, and nothing graded after it is kept.
- Spend is summed from each run's cost. **Unknown spend is never counted as zero.** With `--max-cost-usd` and without
  `--allow-unpriced`, one unpriced run stops the campaign as `budget-unenforceable`. Local and gateway models without a
  price are unpriced.
- Ctrl-C, SIGTERM and SIGHUP stop the agent run, journal the stop and remove the worktrees. The exit codes are 130, 143
  and 129.

### Unattended campaigns with contained yolo

`--autonomy yolo` runs each agent as [contained yolo](../architecture/safety-model.md#contained-and-unconfined) inside
its iteration worktree. The OS sandbox, the safety judge and your autonomous caps (`safety.limits.autonomous*`) stay on.
A call that would need you is refused back to the agent instead of waiting, so a campaign never stalls on a prompt
nobody is there to answer. Each refused call is kept in the journal as an open decision, and `research status` and
`research report` list them under "open decisions left for you". A run that its caps or the judge paused is archived as
`agent-failed`. The campaign records its autonomy in `campaign.json`.

Research refuses `--autonomy yolo` when your settings choose unconfined yolo (`safety.yoloConfinement: unconfined`),
and as root outside a container, the same as `clio-coder run`.

### Read and check a campaign

```bash
clio-coder research list
clio-coder research status            # the latest campaign
clio-coder research report <id>       # regrade every verdict from the raw samples
```

`research report` regrades the A/A check and every measured iteration from the stored samples with the recorded seed. It
exits 1 when any grade disagrees with the journal, so a campaign can be audited after the fact. In the terminal UI,
`/research` shows the same campaigns and timelines read-only.

### Resume a stopped campaign

```bash
clio-coder research resume <id>
```

`research resume` picks a campaign up where its journal ends: one you stopped, one the wall budget or an error ended, or
one whose process died. The spec and budget stay the same, and the iterations, spend and wall time already used count
against it. The A/A check is not run again; the objective runs once on the best commit and every gate runs there too, so
the output the checks create is known before the next iteration commits. An iteration no run finished is archived as
`interrupted`, and the journal gets a `resumed` event. Resume is refused while another process runs the campaign
(`.clio-coder/research/<id>/run.lock`), when its A/A check called a change, when its budget is already spent, and when
something other than the campaign moved `clio/research/<id>`.

Research also writes to the [claims ledger](../architecture/evidence-and-memory.md#claims-ledger):
- Judged gates (`numeric-compare`, `reproduce`) append claims.
- Each measured iteration records the agent's hypothesis and prediction.
- The research verdict itself (supported, refuted or inconclusive) comes from the grade and is kept in the journal.

## Arena: blind side-by-side comparison

### Run a match

```bash
clio-coder arena run --suite bugs --check unit \
  --contender copilot/claude-haiku-5.5 \
  --contender litellm/mini/qwen3.8-27b-iq4r-v4 \
  -- "Fix the bug in calc.py so test_calc.py passes. Keep the change minimal."
```

A contender is `<target>/<model>`, split at the first `/`, so models with slashes in their names work. Inside Git, every
contender runs in its own worktree from `HEAD`. Uncommitted changes are not part of the baseline, and the worktrees are
removed after each contender's diff is saved. Outside Git, or with `--read-only`, contenders only read. Put `--` before a
prompt that starts with `-`.

`--check <id>` dry-runs one verifier in each contender's worktree when it finishes. The check runs in the sandbox host verification uses, rooted at the worktree, since it executes what the contender wrote. An id the project cannot resolve is
refused before any contender starts. A sweep check takes one run, `--check <sweep>/<run>`. The project's
`.clio-coder/verifiers.yaml` is copied into each worktree, committed or not, and replaces any copy a contender wrote. So
are the uncommitted files the check names: untracked or changed files under each path on its command (the run
directory of a sweep included), its `reference` or `baseline` file and a `reproduce` check's pinned inputs. They are
copied before the contender starts and again before the check runs, so the check reads the project's bytes, and the
diff leaves each one out while it still holds them. Ignored files and links are not copied, and a check that names
more than 256 uncommitted files or 64 MiB is refused before any contender starts; commit those inputs instead. A file
the check reads without naming it, such as one its script opens, must be committed.

`--autonomy yolo` runs every contender as contained yolo, with the same rules as a research campaign: the sandbox, the
judge and your autonomous caps stay on, and a call that would need you is refused back to the contender. All
contenders in a match share the autonomy, and `match.json` records it. Before a vote, `show` adds each contender's count
of open decisions and the cap or judge that paused it, if any, next to its blocks. The refused commands themselves stay
in the contender's own stream. Unconfined yolo is refused here too, and `--read-only` still applies at yolo.

### Vote blind, then reveal

```bash
clio-coder arena show <match-id>                   # labels A..D in a seeded random order
clio-coder arena vote <match-id> A --note "smaller diff"
clio-coder arena show <match-id> --reveal          # now shows who was who
clio-coder arena standings --suite bugs
```

Before a vote, `show` lists each contender's answer, diff, turns, tool calls, writes, blocks and check result. It hides
the target, model, duration, tokens and cost, and redacts identifying text such as session ids and worktree paths.
`--reveal` before a vote is refused. One vote counts per match. `--replace` changes it, and the journal keeps both. The
choices are a label, `tie` or `both-bad`.

`standings` counts wins, losses, ties and both-bad votes per target/model. Once an identity has 5 votes, it also shows an
Elo rating. Every identity starts at 1000, and the votes are replayed in match order with K 32, so the same records
always give the same ratings. A win beats every other contender in the match, `tie` is a draw between each pair, and
`both-bad` leaves ratings alone. In a 3- or 4-way match, K is split across the opponents.

### In the GUI

The GUI's Arena page runs the same commands. It has a New match form with live progress and Cancel, blind columns with
answers, diffs and check output, a vote panel, and standings. See [Graphical application](gui.md#arena-page).
The Research page browses a project's campaigns with their iteration timeline, regrades one, and starts or stops a
campaign, one per project at a time. See [Graphical application](gui.md#research-page).

## Where things are stored

| What | Where |
| --- | --- |
| Research campaigns | `.clio-coder/research/<id>/`: `campaign.json` (the frozen spec, checks with their digest, seed and CLIO Coder version), `journal.jsonl`, `samples/`, `slate.json` and, while a run holds it, `run.lock` |
| Research worktrees | `.clio-coder/worktrees/research-<id>-base/` and `research-<id>-it-NNNN/`, removed after grading unless `--keep` |
| Research results | The branch `clio/research/<id>` |
| Arena matches | `.clio-coder/arena/<match-id>/`: `match.json`, each contender's `contender-N.ndjson` stream and `contender-N.diff`, and `vote.json` |
| Arena vote journal | `.clio-coder/arena/votes.jsonl`, every vote including replaced ones |

The full list is in [Artifact placement](../architecture/artifact-placement.md).

## Limits

- Research optimizes one metric of one check, or of one run of a sweep, at a time and runs one candidate per
  iteration. Parallel candidates are not supported yet. `research resume` keeps the campaign's budget; it cannot raise it.
- `--autonomy yolo` is contained yolo only. Neither command runs unconfined yolo. Each agent run is launched with `CLIO_CODER_YOLO_CONFINEMENT=contained`, so it stays contained even if your settings turn unconfined while the campaign or match runs. The pin also reaches every `clio-coder` such a run starts from bash, and setting it to another value does not widen it.
- Started from the bash of a session below yolo (`CLIO_CODER_AUTONOMY_CEILING` is set), `--autonomy yolo` is refused with exit 2: a delegated run never gets more autonomy than its dispatcher.
- Arena contenders do not inherit your whole environment. Each gets the safe command variables (`PATH`, `HOME`, `USER`,
  `LANG`, `TMPDIR`, the XDG base dirs), CLIO Coder's own `CLIO_CODER_*`, `LC_*`, `TERM`, `SHELL`, `TZ`, `NODE_OPTIONS`, proxy
  and CA variables, git author and committer names and emails, and the names in `safety.sandboxPassEnv`. From the credentials it
  gets only its own target's: the target's `auth.apiKeyEnvVar`, its runtime's default key variable, and that runtime's
  own variables (`CLAUDE_CONFIG_DIR` and the Anthropic selectors for `claude-code`, also every `ANTHROPIC_*` and
  `CLAUDE_CODE_*` for `claude-sdk`; `CODEX_HOME` for `codex-cli`; `OPENCODE_CONFIG*` and the keys its config names for
  `opencode-cli`; `PI_CODING_AGENT_DIR` for `pi-cli`; `COPILOT_*`, `GH_HOST`, `GH_CONFIG_DIR` and the D-Bus address for
  `copilot-sdk`; `AWS_*` for `bedrock`; the Google key, project and credentials file for `google`). A contender loses
  everything else: other targets' keys, `GITHUB_TOKEN`/`GH_TOKEN`, `SSH_AUTH_SOCK`, cloud logins its runtime does not
  read, `HERDR_*`, `DISPLAY`, `EDITOR`, and toolchain variables such as `VIRTUAL_ENV`. Add a name it needs to
  `safety.sandboxPassEnv`.
- A research measurement is only as good as its check. Run `research report` and look at the A/A line before you trust
  a gain.

## Exit codes

| Command | 0 | 1 | 2 | Signals |
| --- | --- | --- | --- | --- |
| `research start`, `research resume` | A budget cap ended the campaign | An error, a noisy A/A check, unenforceable spend, or a refused resume | Usage | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
| `research report` | Every regrade agrees with the journal | A regrade disagrees, or the campaign is missing | Usage | |
| `arena run` | Every contender finished | The match failed | Usage | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
| `arena show`, `vote` | Done | Unknown match, reveal before a vote, or a second vote without `--replace` | Usage | |

Implementation: [research](../../src/domains/research/index.ts), [arena](../../src/domains/arena/index.ts),
[research CLI](../../src/cli/research.ts) and [arena CLI](../../src/cli/arena.ts).
