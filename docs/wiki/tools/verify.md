---
title: "Tools verify"
summary: "The verify tool is a single EXECUTE entry point for declared verification: it lists package scripts, project catalog checks, and toolchain-derived checks, and runs one by exact id. It executes commands through safe-exec and attaches a three-part judgement (execution, validation, scientific validity) to every result."
sources:
  - "src/tools/verify/index.ts"
  - "src/tools/verify/catalog.ts"
  - "src/tools/verify/scripts.ts"
  - "src/tools/verify/numeric.ts"
  - "src/tools/verify/perf.ts"
  - "src/tools/verify/frontend.ts"
  - "src/tools/verify/authoring.ts"
  - "src/tools/verify/resolve.ts"
  - "src/tools/verify/surface.ts"
  - "src/tools/verify/toolchain.ts"
  - "src/tools/verify/toolchain-checks.ts"
  - "src/tools/verify/discovery.ts"
symbols:
  - "verifyTool"
  - "DeclaredCheck"
  - "DeclaredCheckKind"
  - "NumericTolerance"
  - "PerfBudgetSpec"
  - "runFrontendCheck"
  - "compareNumeric"
  - "evaluatePerfBudget"
  - "resolveVerifyCall"
  - "discoverVerifierAuthoring"
tests:
  - "tests/contracts/verify-numeric.test.ts"
  - "tests/contracts/verify-toolchain-checks.test.ts"
  - "tests/contracts/verify-numeric-boundaries.test.ts"
  - "tests/extended/verify-perf.test.ts"
invariants:
  - "A verify call runs only a command that the safety policy engine resolved through the same `resolveVerifyCall` function; a model-supplied check string that names no declared or derived check resolves to `unresolved` and runs nothing."
  - "Every judged check result carries a three-part judgement separating execution outcome, validation verdict, and scientific validity, which is always `not established by this check`."
validate:
  - "pnpm run test:file -- tests/contracts/verify-numeric.test.ts tests/contracts/verify-toolchain-checks.test.ts tests/extended/verify-perf.test.ts"
---

# Tools verify

## What the verify tool does

The verify tool is a single EXECUTE entry point for declared verification. Its purpose is to run the project's own verification commands—package scripts, project catalog entries, and checks derived from build/CI files—through a safety-admitted argv, and to return a structured verdict that separates execution facts from validation conclusions. The tool has no shell access by default; a model-supplied command string is never executed unless it names a declared or derived check id.

The tool exposes three check kinds in its catalog: `command` reads the exit code as the verdict; `numeric-compare` runs the command and judges its stdout as a JSON object against a reference file under a declared tolerance; `perf-budget` runs the command and judges its wall time against a declared budget or a recorded baseline. The `frontend` check kind is special: it validates an HTML, CSS, or JavaScript artifact without shell access, checking tag structure, syntax, and an optional headless-browser load.

## Ownership

The tool's surface is defined in `src/tools/verify/surface.ts` as `verifyToolSurface`, which declares the argument schema and action class. The executable entry point is `verifyTool` in `src/tools/verify/index.ts`, which calls `resolveVerifyCall` from `src/tools/verify/resolve.ts` and dispatches to the appropriate runner.

The catalog schema lives in `src/tools/verify/catalog.ts`, which exports the `DeclaredCheck` interface, the `DeclaredCheckKind` type (`"command" | "numeric-compare" | "perf-budget"`), and the parser `parseProjectVerifierCatalogText`. The catalog is stored at `.clio-coder/verifiers.yaml` and is versioned: version 1 files admit only `kind: command` checks, while version 2 files admit the full kind set.

Execution logic lives in `src/tools/verify/scripts.ts`. The `runProjectCheck` function runs catalog checks, `runScriptCheck` runs package scripts, `runToolchainCheck` runs derived toolchain checks, and `runJudgedCheck` is the shared spine for judged checks (numeric-compare and perf-budget).

The numeric-compare judgement is pure math in `src/tools/verify/numeric.ts`, which exports `compareNumeric`, `normalizeNumericTolerance`, `parseNumericPayload`, and `renderNumericReport`. The perf-budget judgement is in `src/tools/verify/perf.ts`, which exports `evaluatePerfBudget`, `parsePerfBaseline`, `renderPerfBaseline`, and `capturePerfEnvironment`.

Frontend validation is in `src/tools/verify/frontend.ts`, which exports `runFrontendCheck` as the entry point. HTML structure, script syntax, CSS syntax, and browser loading are validated without shell access.

Toolchain discovery—the reading of Cargo, CMake, Python, Go, Makefile, justfile, and CI files—lives in `src/tools/verify/toolchain.ts` and `src/tools/verify/toolchain-checks.ts`. The `discoverToolchainChecks` function returns the derived checks, and `toolchainArgv` resolves the argv for a derived check with model-supplied arguments.

The authoring workflow for creating and revising verifier catalogs is in `src/tools/verify/authoring.ts`, which exports `discoverVerifierAuthoring`, `createVerifierDraft`, `reviseVerifierDraft`, `previewVerifierDraft`, and `runVerifierAuthoringWorkflow`.

## How data flows through a call

When the model calls `verify(check="test")`, the flow is:

1. `verifyTool.run` in `src/tools/verify/index.ts` calls `prepareVerifyArguments` from `src/tools/verify/surface.ts`, which tolerates the weak-model shape of `args` sent as a JSON string.
2. `resolveVerifyCall` in `src/tools/verify/resolve.ts` is called with `process.cwd()` and the prepared args. It calls `discoverDeclaredChecksAtRoot` from `src/tools/verify/discovery.ts`, which reads the package.json scripts and the project catalog.
3. If the check id matches a project catalog entry, resolution returns `{ kind: "catalog", check }`. The tool then calls `runProjectCheck` in `src/tools/verify/scripts.ts`.
4. `runProjectCheck` resolves the execution cwd via `resolveProjectVerifierExecutionCwd` from `src/tools/verify/catalog.ts`, then dispatches to `runJudgedCheck` for numeric-compare or perf-budget kinds, or to `runVectorTool` for plain command checks.
5. For a numeric-compare check, `runJudgedCheck` runs the command via `runCommandVector`, then calls `judgeNumericCompare` which reads the reference file and calls `compareNumeric` from `src/tools/verify/numeric.ts`. The result is rendered via `renderNumericReport` and attached to the tool result as `details.report`.
6. For a perf-budget check, `runJudgedCheck` runs the command, then calls `judgePerfBudget` which reads the baseline file (if any) and calls `evaluatePerfBudget` from `src/tools/verify/perf.ts`. The result is rendered and attached similarly.
7. For a plain command check, `runVectorTool` executes the command, and `withCommandJudgement` attaches the exit-code judgement.

The safety policy engine in `src/domains/safety/policy-engine.ts` uses the same `resolveVerifyCall` function to resolve a verify call before the tool runs. This means the command admitted by the safety net is the same command the tool runs: a model-supplied check string that names no declared or derived check resolves to `unresolved` and the tool refuses it.

## Enforced boundaries and lifecycle ordering

**Check resolution boundary.** `resolveVerifyCall` in `src/tools/verify/resolve.ts` is the single authority on what a verify call runs. It consults package scripts, the project catalog, and derived toolchain checks in that order. A check id that matches none of these resolves to `unresolved`, and `verifyTool.run` returns an error. The safety policy engine calls the same function, so the tool and the safety net cannot disagree.

**Workspace confinement.** All catalog file paths (reference files, baseline files, cwd values) are validated by `validateRepositoryFile` in `src/tools/verify/catalog.ts`, which rejects absolute paths, NUL bytes, paths that escape the workspace root, and paths exceeding the 512-byte cap. The execution cwd is resolved by `resolveSafeCwd` from `src/core/safe-exec.ts`, which enforces the workspace boundary at runtime.

**Output ceiling for judged checks.** Judged checks (numeric-compare and perf-budget) run under `JUDGED_CHECK_MAX_OUTPUT_BYTES` (32 MiB) in `src/tools/verify/scripts.ts`, not the safe-exec default of 600 KB. A command that overruns this ceiling fails before any comparison, so a crashed or truncated validator never reads as a tolerance verdict. Reference and baseline files are refused past this ceiling before being read.

**Judgement separation.** Every result carries a three-part judgement: `execution` says whether the command ran to completion (`succeeded`, `failed`, `timed-out`, `aborted`, `output-capped`); `validation` says what the declared judgement concluded (`passed`, `failed`, `exit-code`, `not-run`); `scientificValidity` is always `"not established by this check"`. This separation is enforced by `withCommandJudgement` and `runJudgedCheck` in `src/tools/verify/scripts.ts`.

**Frontend browser mode.** The `browser` argument accepts `"auto"`, `"required"`, or `"off"`. In `"off"` mode, the check is skipped. When a browser is not found on PATH, the check status is `"fail"` in `"required"` mode and `"warn"` in `"auto"` mode. The browser is found by `findBrowserExecutable` in `src/tools/verify/frontend.ts`, which searches for chromium, google-chrome, and microsoft-edge on PATH.

## Extension seams

**Adding a new check kind.** A new check kind would be added to `DeclaredCheckKind` in `src/tools/verify/catalog.ts` and the `DECLARED_CHECK_KINDS` array. The `validateCheckKind` function in the same file gates which parameters may appear for each kind. A new kind would need a new branch in `runJudgedCheck` in `src/tools/verify/scripts.ts` to perform its judgement, and a new pure module for the judgement math.

**Adding a new toolchain proposal source.** A new proposal source (e.g., a new build system) would be added as a function in `src/tools/verify/toolchain.ts` following the pattern of `cargoProposals`, `cmakeProposals`, `pythonProposals`, and `goProposals`. The function would read the project's configuration file, return a `RawProposal` with the exact argv, and push diagnostics for any parsing failures. The proposal would then be discovered by `discoverToolchainChecks` in `src/tools/verify/toolchain-checks.ts`.

**Adding a new verifier authoring signal.** The authoring discovery in `src/tools/verify/authoring.ts` reads package scripts, the project catalog, Cargo, CMake, Python, Go, and validation contracts. A new signal source would be added to `discoverVerifierAuthoring` following the pattern of `cargoProposals` and `validationContractProposals`.

**Host verification integration.** The `runHostVerification` function in `src/domains/dispatch/host-verification.ts` uses the same `compareNumeric` and `evaluatePerfBudget` functions as the verify tool. A change to the judgement math in `src/tools/verify/numeric.ts` or `src/tools/verify/perf.ts` affects both paths.

## Focused tests

**`tests/contracts/verify-numeric.test.ts`** demonstrates the numeric-compare tolerance math and the verify runner integration. It tests:
- Relative, absolute, and ulp tolerance judgements against extreme values (e.g., `Number.MAX_VALUE`, signed zeros, subnormals).
- The `combine: any` rule that lets a key pass when at least one named bound holds.
- Array elementwise comparison with length mismatch detection.
- The `nonFinite` policy that fails NaN and infinity by default but matches them under `match`.
- The verify runner judging a command's stdout against a reference file and recording the report with SHA-256 provenance.
- The output ceiling: a command that prints more than `JUDGED_CHECK_MAX_OUTPUT_BYTES` fails before judgement.
- The exit-code judgement attached to plain command checks and package scripts.
- Host verification judging the same payload through both ordinary and host verification paths, with the verdict agreeing despite different reference labels.

**`tests/contracts/verify-toolchain-checks.test.ts`** demonstrates derived toolchain checks. It tests:
- Deriving a uv-launched unittest check from `pyproject.toml`, `uv.lock`, and a `tests/` directory.
- Following pytest when the project declares it as a dependency.
- Listing Makefile verification targets and CI scripts, skipping setup steps.
- Running a derived check through `verifyTool.run` and resolving a family word when one check owns it.
- Refusing an undeclared check string: `verifyTool.run({ check: "touch marker" })` does not run and the marker file is not created.
- Safety policy engine admission: a derived check is admitted at yolo autonomy and asks at default; model-supplied arguments are scanned with the resolved command.

**`tests/contracts/verify-numeric-boundaries.test.ts`** tests the numeric-compare combination rule. It uses fixture cases to verify that `combine: all` requires every named bound to hold while `combine: any` passes when at least one holds, and that the per-bound facts (`held`, `violated`) are identical under both rules. It also tests that the worst element naming under `combine: any` names the element that needed the rule, not the clean element that deviated most.

**`tests/extended/verify-perf.test.ts`** demonstrates the perf-budget judgement. It tests:
- Passing within a budget and applying relative headroom.
- Judging against a baseline with relative headroom.
- Rendering and parsing baseline files with version 1 and version 2 support.
- Reporting environment drift beside a baseline verdict without changing the verdict.
- Recording a baseline file and comparing against it with headroom.
- The output ceiling for baseline recording: a command that prints between the safe-exec default and the judged ceiling records and then judges the same way.
- Host verification judging the measured duration against a sealed budget.

## Things to watch when editing

- **The `resolveVerifyCall` function is shared between the tool and the safety policy engine.** A change to its resolution logic changes both the tool's behavior and the safety net's admission. The test `tests/contracts/verify-toolchain-checks.test.ts` has a case that verifies the two paths agree: `verifyTool.run({ check: "ci-gate" })` and the safety engine's evaluation of the same call must both allow it.

- **The `JUDGED_CHECK_MAX_OUTPUT_BYTES` ceiling is shared between numeric-compare and perf-budget runs, and between the judged run and the baseline recording run.** A change to this constant or to how it is enforced in `runJudgedCheck` affects both judgement paths and the `recordPerfBaseline` function.

- **The `compareNumeric` and `evaluatePerfBudget` functions are pure and are used by both the verify tool and `runHostVerification` in `src/domains/dispatch/host-verification.ts`.** A change to their behavior changes both paths. The test `tests/contracts/verify-numeric.test.ts` has a case that verifies the verdict agrees between the two paths.

- **The catalog schema is versioned.** Version 1 files admit only `kind: command` checks. Version 2 files admit the full kind set. A change to the kind validation in `validateCheckKind` in `src/tools/verify/catalog.ts` must preserve version 1 compatibility: a version 1 check with a `kind` field must be rejected.

- **The `frontend` check id is reserved.** The `validateId` function in `src/tools/verify/catalog.ts` rejects the id `"frontend"` because it is used by the built-in frontend validation. A catalog entry with this id will fail to load.

- **The `frontend` validation runs without shell access.** The HTML structure validator uses regex to parse tags, and the JavaScript validator uses `node --check` for module syntax. The browser load validator uses a headless browser from PATH. These validators are internal modules of the verify tool and are not registered as separate tool surfaces.

- **The safety policy engine scans model-supplied arguments to derived checks.** A change to how `extraArgs` are forwarded in `resolveVerifyCall` or `toolchainArgv` must preserve the safety net's ability to scan the full argv. The test `tests/contracts/verify-toolchain-checks.test.ts` has a case that verifies the safety engine asks for a hidden shell command in the args.

- **The authoring workflow writes the catalog file atomically.** The `writeValidatedDraft` function in `src/tools/verify/authoring.ts` writes to a temporary file and renames it, and it validates the file is inside the workspace root before writing. A change to this function must preserve the atomicity and workspace confinement.
