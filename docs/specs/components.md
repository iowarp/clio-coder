# Harness Component Registry

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The components domain exposes a read-only inventory of every artifact that can alter agent behavior or operator trust. It answers four questions for an agent or maintainer: what harness components exist, where they live, what authority they carry, and what changed between two snapshots. The domain is filesystem-deterministic and never imports runtime code; the scanner walks the repo tree, classifies each file by kind, hashes its content, and produces a stable `ComponentSnapshot` envelope. The CLI surface is `clio components`, `clio components snapshot`, and `clio components diff`.

## Data layout

The components domain reads from the repository tree, not from `<dataDir>`. A snapshot file is a single JSON document the operator chooses where to write. The scanner inspects:

- `src/domains/prompts/fragments/**/*.md` for prompt fragments.
- `src/domains/agents/builtins/**/*.md` for agent recipes.
- `src/tools/*.ts` for tool implementations and tool helpers.
- `src/domains/providers/runtimes/**/*.ts` for runtime descriptors.
- `damage-control-rules.yaml` for safety rule packs (one component per parseable pack id).
- `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/config/schema.ts` for config schemas.
- `src/domains/session/entries.ts`, `src/domains/session/contract.ts`, `src/engine/session.ts` for session schemas.
- `src/domains/dispatch/types.ts`, `src/domains/dispatch/receipt-integrity.ts` for receipt schemas.
- `CLIO.md`, `CONTRIBUTING.md`, `SECURITY.md` for context files.
- `docs/specs/**/*.md` for doc specs.

Missing optional directories are skipped without error. The scanner is deterministic across runs: components are sorted by `(kind, path)` and `contentHash` is `sha256` over the raw bytes.

## Public CLI surface

- `clio components` prints a compact human table: `<kind> <authority> <reloadClass> <path>`, one component per line, with a leading total count.
- `clio components --json` writes the full `ComponentSnapshot` envelope to stdout.
- `clio components snapshot --out <path>` writes the same envelope to `<path>` and creates parent directories as needed.
- `clio components diff --from <a.json> --to <b.json>` summarizes added, removed, changed, and unchanged components, then prints `+`, `-`, `~` markers for non-zero buckets. `~` lines include the `changedFields[]` list. `--json` emits a `ComponentDiff` object.

## Public types

Types live in `src/domains/components/types.ts` and are re-exported from `src/domains/components/index.ts`.

- `ComponentKind` enumerates the 13 supported kinds: `prompt-fragment`, `context-file`, `tool-implementation`, `tool-helper`, `middleware`, `agent-recipe`, `runtime-descriptor`, `safety-rule-pack`, `config-schema`, `session-schema`, `receipt-schema`, `memory`, `eval-suite`, `doc-spec`.
- `ComponentAuthority` enumerates 4 authority levels: `advisory`, `descriptive`, `enforcing`, `runtime-critical`.
- `ComponentReloadClass` enumerates 4 reload classes: `hot`, `next-dispatch`, `restart-required`, `static`.
- `HarnessComponent` is the per-component record: `id`, `kind`, `path`, `ownerDomain`, `mutable`, `authority`, `reloadClass`, `contentHash`, optional `description`.
- `ComponentSnapshot` is `{ version: 1, generatedAt, root, components[] }`.
- `ComponentDiff` is `{ version: 1, from, to, summary, added[], removed[], changed[] }` with `summary` carrying `{ added, removed, changed, unchanged }` counts and `changed[]` items carrying `{ id, before, after, changedFields[] }`.

## Invariants

1. The scanner never executes scanned files; it reads bytes, computes a `sha256` content hash, and applies a static authority and reload mapping.
2. Component ids are unique within a snapshot and stable across runs for the same input tree.
3. Two snapshots taken from the same tree produce byte-identical JSON when `generatedAt` is held constant.
4. `prompt-fragment`, `context-file`, `agent-recipe`, and `memory` are `advisory`. `tool-implementation`, `tool-helper`, `middleware`, and `safety-rule-pack` are `enforcing`. `runtime-descriptor`, `config-schema`, `session-schema`, and `receipt-schema` are `runtime-critical`. `eval-suite` and `doc-spec` are `descriptive`.
5. `prompt-fragment`, `context-file`, and `tool-implementation` are `hot`-reloadable. `agent-recipe` is `next-dispatch`. `tool-helper`, `middleware`, `runtime-descriptor`, `safety-rule-pack`, `config-schema`, `session-schema`, and `receipt-schema` require `restart-required`. `doc-spec` is `static`.
6. Diff buckets are partitioned: every component appears in exactly one of `added`, `removed`, `changed`, or `unchanged`. Field-level diffs are emitted only for the `changed` bucket and include the list of fields whose values differ.

## Status and scope notes

v0.1.4 ships the read-only registry, the snapshot writer, and the diff command. The registry is consumed manually today; a future slice will gate `clio --dev` handoffs on a recent snapshot when no change manifest exists. Component metadata is not persisted to `<dataDir>` automatically; snapshots are operator-managed files. The scanner has no plugin extension point; adding a new component kind requires an enum entry plus a scan rule.

## References

- `src/domains/components/types.ts`: the type surface.
- `src/domains/components/scan.ts`: filesystem inventory.
- `src/domains/components/hash.ts`: content hashing.
- `src/domains/components/snapshot.ts`: envelope construction.
- `src/domains/components/diff.ts`: snapshot comparison.
- `src/domains/components/index.ts`: public domain entry.
- `src/cli/components.ts`: CLI wiring.
- `tests/unit/components-scan.test.ts`, `tests/unit/components-snapshot.test.ts`, `tests/unit/components-diff.test.ts`: regression coverage.
- `docs/.superpowers/IMPROVE.md` section M1: roadmap entry.
