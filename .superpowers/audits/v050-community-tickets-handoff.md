# v0.5.0 handoff: community tickets #375 to #380

You are the Clio Coder engineer. Work in `/home/akougkas/iowarp/clio-coder` on the local branch `v050`, cut from `main` at `3ae1ea3a` (the published v0.4.9). Six items arrived on 2026-09-17 from one external contributor, `@ikourkouta-svg`, all filed against 0.4.8 with a local Ollama 0.34 setup. They are careful reports: each gives file and line references, a reproduction, acceptance criteria and an environment block, and each says what was measured and what was not. Treat them with matching care. Nothing has been replied to, labeled, assigned or merged yet.

## Read first

`CONTRIBUTING.md`, `CLIO-CODER.md`, `docs/process/development-pipeline.md`, `docs/process/release-cut-checklist.md`, and `.superpowers/audits/v049-release-handoff.md` for the rules that bound the last cycle. Read every issue and the pull request in full with `gh issue view <n>` and `gh pr view 380 --comments` before touching code. The summaries below are a map, not a substitute.

## Standing rules

- Reproduce each defect before fixing it. Fix in `src/`. Add one focused regression per fix that fails on the prior source. No test theater.
- Conventional commits, full sentences, no attribution trailers, and never a dash used as a clause separator.
- Routine fixes, tests and local commits are authorized. Every push, PR merge, issue comment, label, tag, npm publication and GitHub release needs the maintainer's explicit authorization at that moment. Draft replies in a file first.
- Use a short private `TMPDIR` under `/var/tmp`. This WSL2 host steps its wall clock, so never trust `Date.now` deltas in tests.
- `v*` tags are restricted to org owners by ruleset `release-tags`. A `release` environment with the maintainer as sole reviewer exists but stays unwired until v1.0 by the maintainer's decision. Do not add `environment: release` to `release.yml`.
- An Ollama server is needed for #375, #379 and parts of #378. Check the homelab with the `hlab` skill (read-only commands are safe; anything that changes a node needs approval). `ollama-mini` was up on 2026-09-17. Do not pull or unload models on shared nodes without asking.

## The tickets, in recommended order

State of each claim against the released 0.4.9 source, checked on 2026-09-17:

### 1. #378 (bug, highest priority, NOT yet verified)
A headless `run` that ends blocked and changes nothing seals a `success` receipt and exits 0. Three mechanisms are reported: a permission denial under default autonomy, the loop guard after three identical failed `edit` calls, and an exhausted `safety.limits.observationBytesPerTurn`. `clio-coder eval run` then scores the run as a pass. It is framed as the mirror of #275, whose invariant is that the exit code and the sealed receipt agree in both directions.
This is the one claim that cannot be confirmed by reading source. Reproduce it first, with a deterministic fixture provider rather than a live model where possible (`tests/harness/openai-compat-fixture.ts`, `tests/harness/headless-denial-fixture.ts`). The design question is what terminal status a turn gets when it records a `limitation` or ends on a `blocked` tool outcome with no applied change. That changes receipt semantics and eval scoring, so state the two options and ask the maintainer before building.

### 2. #375 (bug, confirmed in source) with PR #380
`ollama-native` reads no context window. `OllamaTagsResponse` and `OllamaPsResponse` in `src/domains/providers/runtimes/local-native/ollama-native.ts:24-30` still declare only `name`, `model`, `size` and `size_vram`, so `context_length` from `/api/ps` (the serving window) and `details.context_length` from `/api/tags` (the model maximum) are dropped, and every Ollama target plans against the 131,072 floor. `num_ctx` appears nowhere in `src/` (zero hits), so Clio can neither read nor raise the window. The reported user-visible failure is an HTTP 400 `exceed_context_size_error` mid-session that is not mapped to `ContextOverflowError`.
PR #380 covers only the `/api/ps` read: +94/-2 in `ollama-native.ts`, a new `tests/extended/ollama-probe-context.test.ts`, and `CHANGELOG.md`. It is `CONFLICTING` with `main`, almost certainly in `CHANGELOG.md`, because the 0.4.9 commits landed as it was opened. No CI ran on it, which usually means first-time contributor approval is pending. Review the diff on its merits, check that its test fails without its change, and prefer helping the contributor land it (ask for a rebase, or rebase it locally and credit them) over reimplementing it. Then decide with the maintainer whether the `/api/tags` maximum, `num_ctx`, and the 400 mapping belong in the same release.

### 3. #377 (bug, confirmed in source)
`validationMatch()` in `src/domains/safety/protected-artifacts.ts:766-781` accepts `ctest`, `ninja test`, `mvn test` and `gradle test` as validation evidence, while `PROJECT_SCRIPT_COMMANDS` in `src/domains/safety/policy-engine.ts` does not let them run without an approval ask, so a headless run on a CMake codebase cannot verify its own work. Also absent from both: `python -m unittest`, `make check`, `meson test`, `tox`. The acceptance criteria ask for one vocabulary derived from the other and a test that stops them drifting. This widens what runs unattended, so it is a safety change: keep the set narrow, exact-match on executable and first argument as the existing code does, and ask before adding anything beyond the reporter's list.

### 4. #379 (bug, confirmed in source)
Every chat request pins the model with `keep_alive: -1` (`src/engine/apis/ollama-native.ts:225`), the ownership registry is per process (`src/engine/apis/residency.ts`), and the reconciler runs before a turn, so a one-shot `clio-coder run` exits with the model pinned and nobody able to reclaim it. The reporter measured 20.3 GB held after a 55 second run. #313 must keep holding: never unload a model Clio did not load. The two candidate fixes are a release on process exit for models this process pinned, or a finite `keep_alive` for headless runs. They differ in behavior on crash and on shared GPUs, so present both and ask.

### 5. #376 (feature request, confirmed in source)
`src/domains/providers/runtimes/boot-manifest.ts:43` registers the runtime as `ollama-native`, the only local runtime not named by its plain product name, so `--runtime ollama` fails. The request follows the `lmstudio` precedent: canonical `ollama`, `ollama-native` kept as a compatibility alias through `src/core/naming-compat.ts` with a deprecation warning. The reporter offers a smaller alternative, a "did you mean" hint on the unknown-id error. This is a naming decision for the maintainer. Do not start it without an answer; persisted `settings.yaml` files and the docs move with it.

## Also carried over from the v0.4.9 cycle

These are recorded under "Known remaining issues" in `v049-release-handoff.md` and were not filed as tickets:
- The read-only exploration nudge counts a Scout dispatch as successful only when the whole dispatch result is `ok`, so a batch with one failed member still prints "without a successful Scout dispatch" (`src/domains/middleware/dispatch-nudge.ts`).
- The 4000 character error-body restoration covers only the OpenAI-compatible path.
- SSH cancellation and failover were never exercised live. Multi-node parallel placement was, on 2026-09-17.
- Windows, macOS, power loss and network filesystems remain untested.

## Deliverables for the session

1. A reproduction note per ticket: reproduced or not, on which build, with the exact command and output.
2. Local commits on `v050`, one per fix, each with its regression and a `CHANGELOG.md` line under a new unreleased section.
3. `/var/tmp/<short>/replies.md` with a drafted maintainer reply for each issue and for PR #380: what was confirmed, what will change, what is declined and why, and thanks that are specific rather than generic. Post nothing without authorization.
4. `pnpm run ci` green before proposing anything for push. Do not run `ci:release` until the maintainer asks for a release.
5. A short report: SHAs, test results, open design questions, and the remote actions that need authorization.
