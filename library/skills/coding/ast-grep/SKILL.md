---
name: ast-grep
description: "Structural code search with ast-grep rules: finds code by shape when grep on text is too noisy, and never rewrites it. Not for plain string or filename lookups; use grep or find."
triggers:
  - structural code search
  - ast-grep rule
  - find calls with this argument shape
  - find code inside a function
  - grep returns too much noise
version: 0.3.3
license: Apache-2.0
allowed-tools:
  - bash
  - read
  - write
  - edit
  - grep
  - ls
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/coding/ast-grep
  audit: pass
  model-size: any
  agents:
    - main
---

# ast-grep Structural Search

Translate a structural question into an ast-grep rule, prove the rule on a
tiny example, then scan the real codebase. Never scan first: an untested rule
that returns nothing tells you nothing.

Search only. Never use `--update-all` / `-U` / `--rewrite`; when matches need
changing, report them and edit through the normal edit tools.

## Arguments

When a flag is passed or no scan path is named, read references/arguments.md.

The five steps below are the plan; do not open a task list for them.

Shell rules for every `bash` call in this workflow: one command per call,
plain and direct. Never use `$(...)` or backticks; they trigger an approval
gate that ends a headless run. Always pass rules through a file, never
through `--inline-rules`, because `$VAR` metavariables inside shell quotes
produce quoting errors that look exactly like non-matches.

## Step 0 — Check the binary

```bash
ast-grep --version
```

If that fails, try `sg --version`; only output starting with `ast-grep`
counts. Linux `sg` may instead be the unrelated switch-group command.
If neither binary is ast-grep, report the missing binary and STOP this run.
Do not install, download, use `npx`, create fixtures, or scan after that failure.
The operator can install ast-grep separately before rerunning this skill.
For binary details, read references/binary-check.md. Use the verified binary
name in every later command.

## Step 1 — Pin down the question

Before writing any rule, write in your reply: the target language; the
structure to match; what must be included and excluded. If the request is
ambiguous on any of these, ask one clarifying question. When running
headlessly, state your reading of the ambiguity and proceed.

## Step 2 — Write a minimal example

Create a scratch directory inside the workspace and write the smallest
code snippet that MUST match and, when exclusions matter, one that must
NOT match:

```bash
mkdir -p .clio-coder/scratch/ast-grep
```

Then write `.clio-coder/scratch/ast-grep/positive.<ext>` and
`.clio-coder/scratch/ast-grep/negative.<ext>` with the `write` tool. These
are the rule's test fixture: one file that must match, one that must not,
nothing more. Never write under `/tmp`, not even by shell redirection; a
write outside the workspace needs an approval a headless run cannot give,
and the call is refused.

## Step 3 — Write the rule, simplest first

Write `.clio-coder/scratch/ast-grep/rule.yml` with the `write` tool.
Escalate only when the simpler form fails:

1. `pattern` alone for direct shapes: `console.log($ARG)`.
2. `kind` plus relational rules (`has`, `inside`) for context: "function
   containing await".
3. Composite rules (`all`, `any`, `not`) for logic: "has await but no
   try-catch".

Non-negotiable: every relational rule (`has`, `inside`) carries
`stopBy: end`, or traversal stops at the first non-matching child and the
rule silently under-matches.

When the question is async functions with no try/catch, or a JavaScript or
TypeScript rule has to assert `async` or fails with `Kind ... is invalid`, read
references/rule-examples.md.

Full syntax (atomic, relational, composite rules, metavariables, `constraints`,
`utils`): read `references/rule_reference.md` when the rule needs more than
the three forms above.

## Step 4 — Test against the example

```bash
ast-grep scan --rule .clio-coder/scratch/ast-grep/rule.yml .clio-coder/scratch/ast-grep
```

The rule must match the positive example and miss the negative one before
you scan anything real. When it passes, go to Step 5. When it does not, read
references/debugging.md and work its order, then test again.

## Step 5 — Scan the codebase

When the rule is a simple one-node pattern, read references/rule-examples.md.

Rule-based scans:

```bash
ast-grep scan --rule .clio-coder/scratch/ast-grep/rule.yml src
```

Scan the requested path, not `.`, so your own fixture under
`.clio-coder/scratch` does not show up as a match; if it does, drop those
lines from the report. Add `--json` only when the output feeds further
processing.

Before reporting, read references/red-flags.md and check the run against it.
Report matches as `path:line` with a one-line reading of each; do not paste
raw JSON at the user. Done when the reported matches answer the Step 1
question and false positives you noticed are either excluded by the rule or
called out. Delete the scratch files last, naming each file. `rm -r` and
`rm -f` are hard-blocked by the safety net, so:

```bash
rm .clio-coder/scratch/ast-grep/positive.js .clio-coder/scratch/ast-grep/negative.js .clio-coder/scratch/ast-grep/rule.yml
```
```bash
rmdir .clio-coder/scratch/ast-grep
```
