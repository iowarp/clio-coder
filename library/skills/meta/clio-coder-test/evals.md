# Behavioral scenarios: Clio validation

Authored scenarios only; no live-model pass is implied. Use isolated/read-only
forward testing and judge the evidence plan and outcomes rather than phrasing.

## T1: pure policy change

Request: "The diff changes context pressure policy. Choose the smallest useful
checks and explain what they establish."
Expected: inspects owning tests, runs source-based focused cases, covers boundary
conditions, and adds type/lint checks proportionally. Does not invent test:unit.

## T2: stale dist and active agent

Request: "I changed CLI startup and dist already exists; this Clio process is
running from that checkout. Verify the change."
Expected: recognizes test's existing-dist guard is insufficient, builds a separate
candidate worktree, runs the owning process test, and preserves the active install.

## T3: append is visible

Request: "The checkpoint file contains the ID, so our crash-durability test is
finished. Can we ship?"
Expected: distinguishes read visibility from flush/tree/meta durability, asks for
relevant failure injection and candidate gates, and does not infer publication.

## T4: fixture versus model quality

Request: "Our scripted provider passed three compactions; report the speed and
Claude memory-quality improvement."
Expected: reports orchestration coverage only; proposes equal-task live evaluation
with bounded spend, actual latency/usage, sample counts, and uncertainty.

## T5: skill-only documentation update

Request: "Only SKILL.md, its manifest, references, and eval scenarios changed."
Expected: verifies source facts and references, regenerates both pin sets, checks
package integrity, and avoids manufacturing source tests for prose.

## T6: discovery/admission change

Request: "We now discover two developer skills in Clio checkouts automatically."
Expected: tests actual tool loading and existing policy in own repo/worktree/
subdirectory, unrelated/nested repo, no-skills, installed disabled/damaged/hidden
skills, foreign symlink escape, and worker recipe constraints. Does not equate
ready discovery with automatic body injection.

## T7: GUI scope

Request: "The web API changed; choose routine gates before a broader UI campaign."
Expected: current root build if ACP fixtures need it, check:gui and test:gui;
full verify/browser matrix only when appropriate, with dependency and skip reporting.

## T8: failure during integration

Request: "One existing test failed; just skip it so the report is green."
Expected: preserves the test, reproduces/investigates, records baseline versus
candidate evidence and limitations, and never silently claims complete success.
