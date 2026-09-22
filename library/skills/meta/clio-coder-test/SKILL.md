---
name: clio-coder-test
description: "Validate Clio Coder changes using focused source regressions, built CLI and ACP fixtures, skill/library checks, and isolated package or GUI gates. Use when developing or diagnosing Clio itself; select checks from the changed behavior and report evidence without claiming unrun coverage."
triggers:
  - validate a Clio change
  - test Clio context compaction or memory
  - verify Clio skill activation
  - choose Clio test gates
version: 0.4.0
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/meta/clio-coder-test
  audit: pass
  provenance: designed
  model-size: any
---

# Clio validation

Choose tests from the changed behavior and the code actually executed. The
canonical skill name is `clio-coder-test`. This
skill is independently usable: do not recursively load `clio-coder-dev`. Consult
it when implementation or repository coordination becomes part of the task.

## Start with an evidence plan

Read the diff, relevant source/tests, `CONTRIBUTING.md`, and current package
scripts. Identify the claim, the failure boundary, and the smallest test that
can distinguish correct behavior. Existing tests may mix source imports with a
built CLI subprocess: inspect the test before deciding a build is unnecessary.

For a bug, reproduce it or explain why it cannot be reproduced. Add a behavioral
regression at the owning boundary when warranted. Assert externally meaningful
state, provider payload, persistence, filesystem outcome, or event ordering;
a mock-call assertion alone rarely proves the claimed fix. Do not add tests that
merely match wording for a reversible prose edit.

## Select the lane

| Changed behavior | First useful checks |
| --- | --- |
| Pure policy or domain behavior | Closest `tests/contracts/` or `tests/extended/` file through `pnpm run test:file -- <file>` |
| Types, imports, domain seams | `pnpm run typecheck`; `pnpm run lint` enforces architecture boundaries |
| Prompt/tool/skill admission | Focused prompt-policy and tool activation tests, including restrictive modes and unavailable tools |
| Curated skill or resource package | Validate manifest/body/references; `skills:pin`, `skills:check`, `library:pin`, `library:check` |
| CLI, entry, ACP, child-process lifecycle | Build the candidate, then the owning smoke or extended-smoke file |
| GUI/API | `pnpm run check:gui` and `pnpm run test:gui`; root build where ACP fixtures require it |
| Package contents or installed behavior | `pnpm run test:package` against a current candidate build |
| Broad integrated implementation | `pnpm run ci`; affected extended suites that routine CI omits |
| Release candidate | Follow `docs/process/release-cut-checklist.md`; qualify the clean committed candidate before exact-artifact preflight |

Use [references/test-map.md](references/test-map.md) for source-grounded file
families and command semantics. Use [references/harness.md](references/harness.md)
when a test needs temporary state, providers, workers, or child processes.

## Run without contaminating the agent doing the work

Use the package scripts so `tests/harness/tmp-root.ts` is preloaded. Isolate Clio
state with `scratch-env.ts`; restore process-wide environment changes in teardown.
Use ephemeral loopback fixtures and scripted providers for deterministic checks.
Do not use real credentials, operator sessions, shared server model loads, or
public inference as a default test dependency.

Source imports through tsx see current files. A subprocess of `dist/cli/index.js`
sees the build. Build in the assigned candidate worktree when main `dist/` backs
the running Clio process. A watch build refreshes files, not already imported ESM
modules; restart the separate candidate process for interactive verification.
Configuration hot reload is a different contract owned by
`src/domains/config/classify.ts`.

Run the narrow test first while iterating, then appropriate type/lint/integration
gates. Repeat or broaden only after changes, failures, or unresolved risks justify
it. Do not run expensive full/release/browser gates after every edit. Do not
suppress, delete, or relabel a failure to obtain a green report.

## Lifecycle and context changes

For compaction, replay, memory, tools, or dispatch, read
[references/lifecycle-validation.md](references/lifecycle-validation.md). Prove
cancellation and late results, branch/session authority, request budget, exact
history, and persistence ordering as applicable. Append visibility is not fsync
durability. A scripted summary validates orchestration, not model understanding.

## Live models and performance

Run live models only within the task's authorization and bounded spending plan.
Record target, model/runtime, effective context window, server capacity, sampler,
fixture/task identity, and cold/warm conditions. Separate missing measurements
from zero. Include failed attempts and summary/memory spending in trajectory
costs. Report sample count and variability; a lower estimated prompt size is not
proof of improved latency or task success.

## Report precisely

List commands, outcomes/counts, candidate identity, failures/skips, and unverified
claims. Identify source versus built versus installed versus live evidence.
Explain any baseline failure with its reproduction; call a flake only with
supporting evidence. Keep raw temporary logs outside tracked product paths and
put concise evidence in the assigned sprint report. Passing checks authorize no
extra commit, remote write, version bump, or release step beyond the task.
