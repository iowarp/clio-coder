---
title: "Command-line sandboxing for shell commands and worker processes"
summary: "How Clio contains bash, run_script and worker child processes in an OS sandbox, which environment variables and secret files they lose, and how availability and policy are decided. Read this when a sandboxed command is refused, masked or unexpectedly unwritable."
sources:
  - "src/core/sandbox/main-session.ts"
  - "src/core/sandbox/worker-process.ts"
  - "src/core/sandbox/worker-policy.ts"
  - "src/core/sandbox/availability.ts"
  - "src/core/sandbox/env-scrub.ts"
  - "src/core/bash-exec.ts"
  - "src/core/safe-exec.ts"
symbols:
  - "mainShellContained"
  - "yoloScriptSandboxState"
  - "mainSandboxPolicy"
  - "mainSandboxLine"
  - "configureWorkerProcessSandbox"
  - "planSandboxedSpawn"
  - "composeWorkerSandboxInvocation"
  - "workerSandboxMasks"
  - "resolveWorkerSandboxSpec"
  - "protectedInside"
  - "workerSandboxReceipt"
  - "sandboxAvailability"
  - "probeSandboxInvocation"
  - "scrubSandboxEnv"
  - "knownSecretValues"
  - "sandboxEnvPolicy"
tests:
  - "tests/contracts/contained-secrets.test.ts"
  - "tests/contracts/sandbox-unix-sockets.test.ts"
  - "tests/contracts/git-hook-drift.test.ts"
invariants:
  - "When safety.sandbox is off, mainShellContained returns false and no backend is consulted for containment."
  - "When safety.sandbox is required and no backend is available, yoloScriptSandboxState reports refused rather than unsandboxed."
  - "scrubSandboxEnv removes variables whose names or values look like credentials and keeps names listed in the passEnv policy, as the contained-secrets test asserts for its fixture."
  - "A worker command that has no available backend is refused when the mode is required and runs directly otherwise, with a one-time stderr notice."
  - "Worker writable roots that sit under a .git or .clio-coder path are kept read-only through protectedInside."
validate:
  - "pnpm run test:file -- tests/contracts/contained-secrets.test.ts"
  - "pnpm run test:file -- tests/contracts/sandbox-unix-sockets.test.ts"
  - "pnpm run typecheck"
---

# Command-line sandboxing for shell commands and worker processes

This area runs the operator's shell commands and the child processes of dispatched workers inside an operating-system sandbox. A reader needs it when a sandboxed command fails to write a path, when a credential variable or secret file is missing inside a command, or when `clio doctor` reports the sandbox as unavailable.

## What this area does

The sandbox has two halves that share one backend probe:

- The main session (`src/core/sandbox/main-session.ts`) contains the operator's own bash and run_script calls under the default autonomy. Its writable roots are the workspace, the effective scratch roots, package caches and git dirs; credentials are masked; the network stays on.
- Worker processes (`src/core/sandbox/worker-process.ts`, `src/core/sandbox/worker-policy.ts`) run under a policy resolved from a dispatch run. Writable roots come from the run's write boundaries, falling back to its task worktree or cwd; read-only runs get none.

Both halves consult `sandboxAvailability` (`src/core/sandbox/availability.ts`), which picks bubblewrap on Linux and sandbox-exec (seatbelt) on macOS, and checks it with a real probe invocation. The environment passed to contained commands is filtered by `scrubSandboxEnv` (`src/core/sandbox/env-scrub.ts`).

## Ownership

- `src/core/sandbox/availability.ts`: `sandboxAvailability` caches the host probe. `detect` returns bwrap when `findBwrap` finds an executable, then runs a `/bin/true` probe via `probeSandboxInvocation`. A failed probe yields `available: false` with a reason. Other platforms are unavailable.
- `src/core/sandbox/main-session.ts`: `mainShellContained` (true only when mode is not `off` and a backend exists), `yoloScriptSandboxState` (returns `unsandboxed` unless mode is `required`), `mainSandboxPolicy` (the writable-root and read-only set for the main session), and `mainSandboxLine` (the one-line doctor summary).
- `src/core/sandbox/worker-process.ts`: `configureWorkerProcessSandbox` stores the process-wide spec; `planSandboxedSpawn` decides, per child, whether to spawn directly, spawn sandboxed, or refuse; `composeWorkerSandboxInvocation` builds the invocation; `workerSandboxMasks` caches the credential and runtime-escape masks.
- `src/core/sandbox/worker-policy.ts`: `resolveWorkerSandboxSpec` builds the spec from dispatch input; `protectedInside` lists the `.git` and `.clio-coder` paths under a writable root that stay read-only.
- `src/core/sandbox/env-scrub.ts`: `scrubSandboxEnv`, `knownSecretValues`, `sandboxEnvPolicy`, and `rememberResolvedSecret` for credentials Clio itself resolved.

## Control flow

Main-session commands reach the sandbox from `src/core/bash-exec.ts`, which computes a `containedPlan` and otherwise calls `planSandboxedSpawn`. When the plan is `sandboxed`, the child environment is passed through `scrubSandboxEnv(plan.source, sandbox.env, plan.source)`. `src/core/safe-exec.ts` uses `planSandboxedSpawn` the same way for typed commands.

For a worker, `planSandboxedSpawn` returns `direct` when no policy is active. Otherwise it composes an invocation with the availability probe. If composition yields nothing, `required` mode produces a `refused` plan with a message stating that the command was not run; any other mode prints the notice once and returns `direct`.

Callers outside `core/` read the same decisions. `src/entry/orchestrator.ts` passes `mainShellContained` into a status record, `src/tools/registry.ts` calls `mainSandboxPolicy` to build the shell sandbox policy, and `src/cli/doctor.ts` uses `mainShellContained`, `mainSandboxPolicy` and `mainSandboxLine` for its sandbox report.

## Boundaries and lifecycle

- `safety.sandbox: off` disables containment: `mainShellContained` returns false, and `resolveWorkerSandboxSpec` returns `undefined`.
- Availability is probed once per process for the real host; a call with an explicit platform or environment is answered without touching the cache.
- Worker policy strips credential variables and records only variable names in `removed`. The contained-secrets test fixture shows `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL` with an embedded password, and a private-key value dropped, while `PATH`, `HTTPS_PROXY` and `AWS_REGION` are kept.
- The pass list from `safety.sandboxPassEnv` keeps a named variable even when a filter would drop it, reading it from the unfiltered source.
- Git hooks and config under a writable root remain read-only, because a file written there would run later outside the sandbox. `protectedInside` returns the `.git` and `.clio-coder` paths for each root, and `resolveWorkerSandboxSpec` adds hooks directories strictly inside a writable root.

## Focused tests

- `tests/contracts/contained-secrets.test.ts`, first case: calls `scrubSandboxEnv` with the kept and dropped fixtures described above and asserts the output env equals the kept set and `removed` equals the dropped keys. The second case verifies the pass list keeps `HF_TOKEN` and `GITHUB_TOKEN` from the unfiltered source. A second test in the same file exercises secret discovery.
- `tests/contracts/sandbox-unix-sockets.test.ts` calls `resolveWorkerSandboxSpec` with a `unixSockets` option; the file was located by search and its cases were not read.
- `tests/contracts/git-hook-drift.test.ts` calls `resolveWorkerSandboxSpec` with hook directories; its cases were not read.

Tests were located by searching `tests/` for the exported symbols. Nothing was executed.

## Things to watch when editing

- `unixSocketLaunch`, `unixSocketHostState` and the secret-file discovery in `src/core/sandbox/secret-files.ts` are called from these files but their internals are documented elsewhere and were not read here.
- The `/tmp` re-exposure and the `TMPDIR` override in `composeWorkerSandboxInvocation` apply only to the bwrap backend; macOS keeps its per-user temp directory.

## Coverage gaps

The following are not described beyond their call sites: the body of `mainSandboxPolicy` and its writable-root derivation, the git-hook fingerprint and drift check (`src/core/sandbox/git-hooks-fingerprint.ts`), the Unix-socket filter (`src/core/sandbox/unix-sockets.ts`), and the secret-file discovery budget (`src/core/sandbox/secret-files.ts`). The `sandbox-unix-sockets` and `git-hook-drift` tests were located but not read.
