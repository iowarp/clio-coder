# Battletest — deterministic pre-release oracle for Clio Coder

The battletest is a **`clio eval` task-file generator**, not a fourth bespoke harness. It turns a real
repository into a SWE-bench-discipline oracle and lets clio's own `clio eval run` do the scoring, so the
whole harness (context indexing, code navigation, editing, validation, the finish contract, and — in
dispatch mode — cross-node worker delegation) is exercised end to end against weak local models.

## How the oracle works

For each target in [`targets.json`](./targets.json), one attempt is:

| phase | command | meaning |
|---|---|---|
| `setup[0]` freeze | `battletest_clio.py freeze` | `git reset --hard <SHA>`, `git clean` (keep dep dirs), then **inject** one deterministic single-line regression into a NON-TEST source file |
| `setup[1]` solve | `clio run --json` (deterministic sampler) | drive clio to repair it; clio's own exit is swallowed so the verifier — not clio's self-report — decides pass/fail |
| `verifier[0]` ban | `battletest_clio.py testedit-ban` | hard-fail if `git diff` touched any test file |
| `verifier[1]` gate | `battletest_clio.py gate` | the repo's OWN offline test gate; **exit 0 == regression repaired without breaking anything == PASS** |

`prepare` proves the oracle is non-vacuous **before any model runs** by asserting
`green → inject → red → revert → green` on the frozen copy. A drifted target (where the injected
`find` string is missing or ambiguous) refuses to inject rather than passing silently.

Because a bounded single-file fix never makes clio delegate, `--agent <recipe>` (e.g. `coder`) switches
`setup[1]` to `clio run --agent coder`, which routes to `workers.default` (the dynamo worker in the
`local-split` fleet) and exercises the full cross-node dispatch path.

## Determinism envelope

`prepare` writes `envelope.json` per run: resolved SHA + tree hash, the pinned sampler
(`temp 0 / topK 1 / topP 0.8 / minP 0`), the resolved fleet (from
[`../community-benchmarks/fleet.json`](../community-benchmarks/fleet.json) via `clio_fleet.load_fleet`),
the isolated `CLIO_*` env knobs, tool versions, and the oracle preflight result. There is **no decode
seed** in the runtimes yet, so results are reported as **pass@k over `--repeat N`**, not single-shot
bit-reproducibility.

## Usage

```bash
# 1. Isolate clio state (never touch ~/.config/clio). Set all five in lockstep.
export CLIO_HOME=/tmp/bt-clio-home CLIO_CONFIG_DIR=$CLIO_HOME/config \
       CLIO_DATA_DIR=$CLIO_HOME/data CLIO_STATE_DIR=$CLIO_HOME/state \
       CLIO_CACHE_DIR=$CLIO_HOME/cache CLIO_REQUIRE_HOME_PREFIX=1 \
       CLIO_NO_UPDATE_NOTIFIER=1 CLIO_RIGOR=high
mkdir -p $CLIO_CONFIG_DIR
export CLIO_DIST=$PWD/../../dist/cli/index.js   # from benchmarks/battletest/

# 2. Render settings.yaml from the fleet (single source of truth), then verify isolation.
python3 battletest_clio.py settings --out $CLIO_CONFIG_DIR/settings.yaml
node $CLIO_DIST paths --json          # must point inside $CLIO_HOME

# 3. Prepare a target (copy to /tmp, install deps offline, prove the oracle).
python3 battletest_clio.py prepare --target voipi --run-root /tmp/bt-voipi --force

# 4. Generate the eval task file and run it (pass@k via --repeat).
python3 battletest_clio.py generate-tasks --target voipi --run-root /tmp/bt-voipi
node $CLIO_DIST eval run --task-file /tmp/bt-voipi/tasks.yaml --repeat 3

# Or one-shot (prepare + generate + eval), and the dispatch variant:
python3 battletest_clio.py run --target voipi --run-root /tmp/bt-voipi --repeat 3 --force
python3 battletest_clio.py run --target voipi --run-root /tmp/bt-voipi-disp --repeat 2 --agent coder --force
```

Targets ship pinned to the author's `~/tools/` checkouts; point `targets.json[*].repo` at your own
clones (each at the recorded SHA) to reproduce elsewhere.

## Observation (log-only)

The eval writes its artifact + auto-builds an evidence bundle under `$CLIO_DATA_DIR`. **Caveat:** the
`clio evidence build --eval` bundle only sees the eval runner's own command tool-events; it is blind to
the nested `clio run` receipts/sessions/audit rows (they land in `$CLIO_STATE_DIR` but are not linked).
For real forensics, read the session ledgers (`$CLIO_STATE_DIR/sessions/<cwdHash>/<id>/current.jsonl`),
the audit ledger (`$CLIO_STATE_DIR/audit/<date>.jsonl`, sorted by `ts`; watch
`completion_contract decision:engage reason:unvalidated_mutation`), and the per-attempt streams under
`<run-root>/logs/`.
