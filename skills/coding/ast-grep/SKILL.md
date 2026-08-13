---
name: ast-grep
description: Use when a code search needs structure, not text — "find all async functions without error handling", "find calls with this argument shape", "find X inside Y" — or when grep returns too much noise to filter. Writes and tests ast-grep rules, then scans the codebase. Search only; never rewrites code. Not for plain string or filename lookups; use grep or find.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - bash
  - read
  - write
  - grep
  - ls
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/coding/ast-grep
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/ast-grep
  eval-status: scenarios-recorded
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

## Step 0 — Check the binary

```bash
command -v ast-grep || command -v sg
```

If neither exists, say ast-grep is not installed (`cargo install ast-grep` or
the platform package) and stop. Some installs expose only `sg`; use whichever
resolved.

## Step 1 — Pin down the question

Before writing any rule, state: the target language; the structure to match;
what must be included and excluded. If the request is ambiguous on any of
these, ask one clarifying question instead of guessing.

## Step 2 — Write a minimal example

Write the smallest code snippet that MUST match (and, when exclusions matter,
one that must NOT match) to a scratch file, e.g. `/tmp/astgrep-example.js`.
This is the rule's test fixture.

## Step 3 — Write the rule, simplest first

Escalate only when the simpler form fails:

1. `pattern` alone for direct shapes: `console.log($ARG)`.
2. `kind` plus relational rules (`has`, `inside`) for context: "function
   containing await".
3. Composite rules (`all`, `any`, `not`) for logic: "has await but no
   try-catch".

Non-negotiable: every relational rule (`has`, `inside`) carries
`stopBy: end`, or traversal stops at the first non-matching child and the
rule silently under-matches.

```yaml
# /tmp/astgrep-rule.yml
id: async-no-trycatch
language: javascript
rule:
  all:
    - kind: function_declaration
    - has: {pattern: await $EXPR, stopBy: end}
    - not:
        has: {pattern: 'try { $$$ } catch ($E) { $$$ }', stopBy: end}
```

Full syntax (atomic, relational, composite rules, metavariables, `constraints`,
`utils`): read `references/rule_reference.md` when the rule needs more than
the three forms above.

## Step 4 — Test against the example

```bash
ast-grep scan --rule /tmp/astgrep-rule.yml /tmp/astgrep-example.js
```

Prefer a rule file over `--inline-rules`: inline YAML in shell needs `$VAR`
escaped as `\$VAR` (or single quotes), and quoting errors look exactly like
non-matches.

The rule must match the positive example and miss the negative one before
you scan anything real. When it does not, debug in this order:

1. Strip the rule to its simplest positive key; re-add parts one at a time.
2. Confirm every `has`/`inside` has `stopBy: end`.
3. Dump the tree to check node kinds — never guess a `kind` name:

```bash
ast-grep run --pattern '<target code>' --lang javascript --debug-query=cst
```

(`cst` = every node; `ast` = named nodes only; `pattern` = how ast-grep
parsed your pattern.)

## Step 5 — Scan the codebase

Simple one-node patterns skip the rule file:

```bash
ast-grep run --pattern 'console.log($ARG)' --lang javascript .
```

Rule-based scans:

```bash
ast-grep scan --rule /tmp/astgrep-rule.yml <path>
```

Add `--json` when the output feeds further processing. Report matches as
`path:line` with a one-line reading of each; do not paste raw JSON at the
user. Done when the reported matches answer the Step 1 question and false
positives you noticed are either excluded by the rule or called out. Delete
the scratch files.

## Red flags

- Scanning the codebase with a rule never proven on an example.
- A `has`/`inside` without `stopBy: end`.
- A guessed `kind` name instead of a `--debug-query=cst` dump.
- Any rewrite flag: this skill only reads.
- Falling back to grep halfway because rule debugging felt slow — fix the
  rule with Step 4; that is the job.
