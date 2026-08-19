# Evals - scientific-debugging

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 - stalled numerical bug

Setup: a small numerical project with a reference-comparison test. The
workspace already contains the fixture; run `python -m unittest -q` for the
reference check. Prompt: "after a refactor our results differ from the
reference by about 1e-4 and the obvious fix did not help; diagnose it."

Fixture:

```bash
mkdir -p tests
cat > diffusion.py <<'PY'
import math


def weighted_mean(values, weights):
    weighted = [value * weight for value, weight in zip(values, weights)]
    return math.fsum(weighted) / math.fsum(weights)
PY
cat > tests/test_diffusion.py <<'PY'
import math
import unittest

from diffusion import weighted_mean


class DiffusionReferenceTest(unittest.TestCase):
    def test_weighted_mean_matches_reference(self):
        values = [1.0e16, 6.0e-4, -1.0e16, 1.0e-4, 2.0e-4, -3.0e-4]
        weights = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
        expected = math.fsum(value * weight for value, weight in zip(values, weights)) / math.fsum(weights)
        observed = weighted_mean(values, weights)
        self.assertLess(abs(observed - expected), 1.0e-12)


if __name__ == "__main__":
    unittest.main()
PY
git init -q
git config user.name "Clio Eval"
git config user.email "clio-eval@example.invalid"
git add diffusion.py tests/test_diffusion.py
git commit -q -m "add stable weighted mean reference"
cat > diffusion.py <<'PY'
def weighted_mean(values, weights):
    total = 0.0
    for value, weight in zip(values, weights):
        total += value * weight
    return total / sum(weights)
PY
```

Expected:

- States a one-sentence goal naming the observable fixed state before
  investigating.
- Writes at least three hypotheses, each with an explicit "this is WRONG if"
  falsification test.
- Hypotheses span at least two distinct fault classes, including numerics and
  regression.
- Orders tests cheapest-first and runs one variable per test.
- Records a CONFIRMED/REFUTED/INCONCLUSIVE verdict per hypothesis, each citing
  a command and its output.
- Edits no code before a hypothesis is CONFIRMED.

## S2 - flaky parallel test

Setup: a test suite where one MPI/threaded test fails intermittently. Prompt:
"this test is flaky, sometimes it passes; figure out why."

Expected:

- Includes a concurrency-class hypothesis (race, collective mismatch, or
  reduction order).
- Attempts a deterministic reproduction (pin threads, fix seeds, force
  ordering) rather than rerunning until green.
- Preserves the raw failing output before changing anything.
- Does not present a lucky pass as a verdict.

## S3 - escalation to structured tier

Setup: quick-tier investigation is not converging; all initial hypotheses come
back REFUTED and fifteen minutes of investigation have elapsed.

Expected:

- Explicitly announces escalation to the structured tier instead of silently
  continuing.
- Writes an investigation file containing the goal, baseline measurements of
  the failing behavior, and one experiment per hypothesis.
- Each experiment's verdict condition is committed before the experiment runs.
- New hypotheses are generated from what the refuted tests revealed.

## S4 - anti-trigger: trivial failure

Setup: the failure is an obvious typo or missing import whose error message
names its own cause. Prompt: "why is this failing?"

Expected:

- Fixes it directly or says a quick fix is appropriate.
- Does not run the hypothesis ceremony for a self-explanatory failure.

## Baseline failure modes to watch for (RED)

- Tries a fix immediately with no stated hypothesis.
- Single hypothesis, no falsification test, anchored on one fault class.
- Bundles the fix with the diagnosis in one edit.
- Verdicts asserted from intuition with no cited observation.
- Flaky test "resolved" by rerunning until it passes.
- Investigation drifts past the time box with no escalation and no file.

## Observed gap closure

S1 run 2026-07-01, headless `clio-coder run` against a scratch git fixture (an
order-sensitive summation whose refactor replaced `math.fsum` with a plain
accumulation loop; regression check fails by 1.474e-4).

- RED (no skill): the agent found the correct root cause but with no stated
  goal, no enumerated hypotheses, no falsification tests, and no verdicts; it
  read the diff, asserted the cause, and benchmarked alternative summations ad
  hoc. On a harder bug that first guess would have been unfalsified anchoring.
- GREEN (skill via `--skill` and `/skill <name>` invocation): one-sentence goal,
  three hypotheses (numerics, data, environment; the refactor regression
  folded into H1) each with a WRONG-if test, explicit cheapest-first ranking,
  CONFIRMED/REFUTED verdicts citing command output, untested H3 marked N/A,
  fix applied only after the CONFIRMED verdict, and a commit message citing
  the confirming observation. All six S1 bullets pass.

## Smoke record (2026-08-13)

One representative scenario via `clio-coder skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. PASS. Judge 6/6 on the seeded numerical fixture; cleanest research run.
