# Clio Coder Safety Model

This document describes the current Clio Coder safety architecture.

## Enforcement Layers

Clio treats prompt instructions as advisory. Enforcement happens in code:

1. **Mode matrix** gates tool visibility and action classes for `default`,
   `advise`, and `super`.
2. **Shared safety policy engine** classifies every tool call and composes the
   base/dev/super damage-control rule packs.
3. **Project policy snapshot** loads `.clio/safety.yaml` once for the active
   run. Invalid policy fails closed for command execution.
4. **Tool registry** applies mode admission, policy decisions, protected
   artifact checks, middleware effects, and one-shot elevation.
5. **Receipts and audit JSONL** record the decision evidence.

## L3, L4, and L5 Direction

The base damage-control pack is L3: known-dangerous patterns are hard-blocked.
It is the floor, not the full safety story.

Default-mode Bash now behaves like L4: command execution is default-deny for
ordinary `execute` calls, shell operators are rejected, and only curated or
explicit project-policy command shapes can pass. `system_modify` actions can still be
parked for super confirmation; `git_destructive` and base hard blocks remain
blocked in every mode.

The production direction is L5: remove arbitrary Bash from common workflows and
replace it with typed tools. Current typed tools include `git_status`,
`git_diff`, `git_log`, `run_tests`, `run_lint`, `run_build`,
`package_script`, and `validate_frontend`, so models can perform common
engineering and frontend validation actions through fixed argv vectors or
in-process validators, cwd constraints, timeouts, output caps, and structured
results.

`validate_frontend` is the new typed frontend checker:

- it validates `.html`/`.htm`, `.css`, `.js`, `.mjs`, and `.cjs` artifacts
- HTML validation includes structural tag checks plus local `<script>` and
  `<style>/<link rel="stylesheet">` traversal
- JavaScript validation includes inline script syntax plus local script reference
  loading and parser checks (`node --check` for module form)
- CSS validation is parser-level brace/quote/comment balance checking
- browser validation (`browser=auto|required|off`) optionally validates loadability in
  a local headless browser when available
- malformed paths, workspace escapes, and missing files fail the check with
  typed, structured evidence in the tool result

Finish-contract advice uses the same typed verification evidence model: a successful
`run_tests`, `run_lint`, `run_build`, approved `package_script` execution
(`test`, `test:e2e`, `lint`, `build`, `typecheck`, `ci`), or a successful
`validate_frontend` call satisfies completion-advice checks without requiring a
fresh bash command pattern.

## Modes and Fleet Dispatch Scope

Modes are enforcement:

- `advise`: read-oriented; fleet dispatch scope is readonly.
- `default`: normal repository work; Bash is default-deny.
- `super`: explicit elevation; base hard blocks still apply.

`safetyLevel` is prompt/UX posture (`suggest`, `auto-edit`, `full-auto`). It is
not the enforcement boundary. A command that policy blocks remains blocked even
if a prompt fragment asks the model to proceed.

## Project Policy

`.clio/safety.yaml` version 1 reserves project-local command policy:

```yaml
version: 1
zeroAccessPaths:
  - secrets
readOnlyPaths:
  - vendor
noDeletePaths:
  - src/generated
commands:
  - id: local-test
    command: npm test
    cwd: .
    timeoutMs: 120000
    maxOutputBytes: 600000
    actionClass: execute
    shellOperators: deny
    env:
      mode: none
      allow: []
    requireConfirmation: false
    rationale: Standard local test command.
    owner: maintainers
    comment: Keep exact and reviewed.
```

Validation is strict: unknown keys, wrong types, duplicate ids, or unsupported
action classes make the policy invalid. The `cwd` field must be relative to the
policy root and must not escape it via `..`; absolute or escaping cwds reject
the entire policy. Entries that omit `cwd` are bound to the policy root, so a
reviewed command only matches when the caller's effective cwd stays under the
project. Invalid policy blocks command execution instead of widening
permissions. The policy is snapshotted for the active run so a model cannot
edit the policy and immediately benefit from the new allowlist. Default-mode
bash that does not match a project policy entry must also run with a cwd under
the workspace root; otherwise the call is rejected as `bash-cwd-escape`.

Path policies are also rooted at the policy root. `zeroAccessPaths` blocks
read, write, and delete access; `readOnlyPaths` allows reads but blocks writes
and deletes; `noDeletePaths` allows reads and writes but blocks deletes.
The policy engine enforces these for typed file/search/list tools and for
deterministic Bash write/delete targets such as redirects, `tee`, `cp`, `mv`,
`rm`, and `find -delete`. Unknown shell behavior is not treated as a path-policy
sandbox and remains governed by the command policy and damage-control layers.

## External CLI and SDK Runtimes

Subprocess and SDK runtimes are delegated sandboxes. Clio controls launch
arguments, mode mapping, and final receipts, but it cannot fully intercept
internal tool calls made by another agent process. In `default` and `advise`,
Clio chooses restricted or supervised external permissions where available.
`super` does not map to external bypass/full-access unless
`CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` is set.

Receipts include runtime limitations for subprocess and SDK workers so replay
and review can distinguish native-tool evidence from delegated evidence.

## Receipts and Audit Evidence

Tool-call audit rows include action class, decision, rule id, reason code,
policy source, command, cwd, mode, policy hash, and redacted arguments where
available.

Run receipts include tool stats, safety decision counts, blocked attempts,
internal `workerMode` (for runtime/config compatibility), dispatch scope,
requested actions, runtime limitations, cwd, git branch, git commit,
dirty-state count/hash, damage-control rule-pack hash, and project policy
fingerprint. The receipt integrity digest covers the new fields when present.
