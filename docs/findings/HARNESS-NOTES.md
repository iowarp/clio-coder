# Harness notes — paid-for once, do not repay

Recorded from evaldriver's Batch 1 setup and first run (2026-08-13), per
the orchestrator, so future campaigns start here.

1. `NODE_OPTIONS=--import tsx` is REQUIRED when driving the src entrypoint.
   src/cli/skills-eval.ts spawns baseline/treatment/judge children as
   `spawn(process.execPath, [process.argv[1], ...args])` with no loader
   re-applied; without NODE_OPTIONS every child dies on TypeScript syntax
   and the harness reports it as an infra error ("baseline run exited 1"),
   not a skill failure. It propagates because the spawn passes
   `env: process.env`.

2. For the llamacpp runtime the target URL is the server ROOT
   (http://192.168.86.141:8080), not `.../v1`. The runtime descriptor
   derives the base via targetRootUrl() and appends /v1 itself
   (src/domains/providers/runtimes/local-native/llamacpp.ts); configuring
   the /v1 form doubles the path.

3. 30B-class runs need headroom: use `--timeout-seconds 900` when the
   600s default times out. Each scenario is three full model runs
   (baseline, treatment, judge).

4. Headless `clio run` cannot service permission confirmations
   (src/entry/orchestrator.ts:1576). Under `autonomy: auto-edit` every
   exec-class call (all git) dies with "clio run cannot confirm permission
   requests" — the gate measures the harness, not the skill. Eval sandboxes
   for skills that must act need `autonomy: full-auto` (operator-approved
   for the disposable, torn-down eval sandbox on 2026-08-13); workspace
   containment (bash-cwd-escape, workspace roots) stays in force.

5. Judge grounding on Nemo-3.5-Lightning is unreliable: it passes bullets
   by quoting SKILL.md prose that reaches the treatment transcript through
   the `context` skill load. Campaign rule (operator-confirmed): a pass
   counts only when the transcript shows the behavior; any judge reason
   phrased as present-tense skill description ("Skill requires/enforces...")
   is SUSPECT and treated as not-passed until verified against the
   transcript evidence in skill-eval.json.

6. Scenario fixtures live in each skill's evals.md (`Fixture:` + fenced
   block, repo-relative shell only per validateFixtureCommands: no absolute
   paths, no `..`, no `~`, no cd/pushd, no HOME/CLIO_* vars). They run only
   with `--trust-fixtures` after review. All six git skills now ship them;
   fixtures were verified to execute cleanly and `npm ci` succeeds against
   the seeded lockfile.
