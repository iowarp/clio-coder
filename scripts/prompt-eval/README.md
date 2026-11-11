# Main-agent prompt evaluation

Runs Clio Coder against a fixed set of harness-use tasks and scores each run from its event stream: the
headless `run --json` events, or ACP session updates for the tasks that need a session (7, 11, 12). Prose is
scored only where a task is about prose, such as a closing offer. It compares `prompts.profile` values and
reports pass rates per task, profile and model.

## Running
Build first (`pnpm run build`); the runner drives `node <checkout>/dist/cli/index.js`.

    export TMPDIR=<your scratch directory>          # never the system /tmp
    export CLIO_EVAL_SEED_HOME=<a Clio home>        # or pass --seed-home
    pnpm eval:prompts -- --target copilot --model claude-haiku-5.5 --runs 5
    pnpm eval:prompts -- --target litellm --model <route>/<model> --lock <file> --tasks 01,09 --keep-raw
    pnpm eval:prompts:selftest

The seed home is a configured Clio home (`config/settings.yaml` plus the credentials the target needs). Each
(task, profile, run) gets a fresh copy with chat and fleet pinned to the run's target and model, scratch roots
dropped and `prompts.profile` set, and a fresh git fixture under `TMPDIR`. One JSON row per run goes to `--out`
(default `$TMPDIR/prompt-eval/<stamp>-<model>.jsonl`), and the report prints at the end.
`python3 -B scripts/prompt-eval/report.py a.jsonl b.jsonl` merges models into one table. `--lock` serializes
Clio calls with `flock` for a route that serves one request at a time. `--worktree` runs another checkout's dist.

Clio reads its prompt fragments from the checkout's `src/` at every start, not from `dist/`, so a run that
outlasts an edit to that checkout mixes prompts, and a fragment the build cannot parse leaves the model with no
system prompt. Run a long matrix from a checkout nothing edits, for example a `--shared` clone detached at the
commit under test with that commit's `dist/` and a `node_modules` link. The runner stops without recording a
run whose prompt failed to load or whose prompt sources changed. `--resume` skips the (task, profile, run)
cells already in `--out`, and refuses a file that holds another commit's runs.

## Files
- `tasks.py`: fixtures, prompts and one scorer per task (pass, fail or n/a, plus a note).
- `lib.py`: isolated homes, workspaces, the headless and ACP drivers, event normalization.
- `run.py`: the matrix runner. `report.py`: pass rates, counters, the flip criteria and known limits.
- `selftest.py`: each task's recorded pass and fail run in `tests/fixtures/prompt-eval/<id>/` must classify
  correctly.
- `make_recorded.py`: rebuilds those recordings from results, real runs first. Gaps are filled by a labelled
  synthetic edit of a real run (`"source": "synthetic: ..."`); rerun it after new results to replace those, then
  `npx biome check --write tests/fixtures/prompt-eval` (the lint gate formats JSON).

## Known limits
- Runs inherit the caller's sandbox. Inside a contained Clio session, Clio's own bash sandbox nests and some
  git commands fail (`could not open '/dev/null'`), so run from a plain shell.
- ACP runs use default autonomy, where the job tool refuses every `runner: command` job (a recurring command
  would run with nobody to approve it). Task 7 scores the model's choice: a well-formed command job with an
  `until` predicate passes whether or not it was admitted, and the note counts the admitted ones.
- Task 4 offers the Slurm skill with `--skill`, which makes it ready without a pending request.
- Task 9 turns the safety judge off (`safety.judge.enabled: false`) so the operator-named force push is an
  approval request, which a headless run denies every time. Its `origin` is a bare repository inside the
  fixture's `.git`, so fetches succeed and a push that got through would land locally.
