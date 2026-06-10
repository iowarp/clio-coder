# Clio Coder

Clio Coder is a TypeScript coding-agent harness for HPC and scientific-software developers. It runs as an operator-driven CLI/TUI, resolves configured model targets, assembles project context, mediates tools through safety policy, and dispatches bounded worker agents with auditable receipts.

## Conventions

- Domain code lives under `src/domains/<name>` and exposes public APIs through `index.ts` or an explicit contract file.
- CLI entry points live in `src/cli`; interactive TUI surfaces live in `src/interactive`.
- Worker execution crosses the `src/worker` / `src/engine` boundary through serialized worker specs, not ad hoc imports.
- Tool registration flows through `src/tools/bootstrap.ts`; tool safety is enforced by the registry and safety domain before execution.

## Hard Invariants

1. Scope/admission policy must not loosen: dispatch workers and retries pass the same safety gates as first-run work.
2. Every finalized dispatch run writes one integrity-sealed receipt with outcome, lineage, identity, costs, and safety summary.
3. Background workers must not stall on permission prompts; non-interactive permission policy is machine-enforced and audited.
4. Status surfaces are read-only and must not be required for orchestration correctness.

## Dispatch and Fleet Orchestration

`src/domains/dispatch/extension.ts` is the single authority for dispatch state. It owns admission, worker launch, heartbeat reconciliation, terminal outcome mapping, bounded retry, ledger persistence, and operator snapshots. Native workers and ACP delegations share the same receipt/outcome taxonomy.

`clio fleet` is the repo-owned fleet-contract surface. Fleet contracts live under `.clio/fleets/*.md`, render strict prompt templates, preflight agents/scope/budget, and dispatch normal workers with lineage. `clio fleet status` and the TUI `/fleet` overlay expose running rows, retry rows, and totals without mutating orchestration state.

## Safety and Audit

The safety domain classifies tools and commands, applies damage-control/path/project policy, emits audit records, and records permission decisions. `workers.onPermission` controls dispatched-worker non-stall behavior: `deny` returns a structured tool denial and lets the run continue; `fail` ends the run as `failed` with `outcomeDetail: permission_required` and worker exit code `3`.

## Receipts, Lineage, and Provenance

Receipts are integrity-sealed JSON artifacts under the Clio data directory. New receipts carry `outcome`, `outcomeDetail`, `lineage`, and `identity` blocks. Lineage links retries and nested fleet steps back to the operator-initiated root run. Identity records host/user and, when present, Slurm/PBS/LSF allocation metadata for reproducibility.

## Verification Expectations

Use narrow validation first when changing a bounded surface, then broaden for shared contracts. Standard gates are:

```bash
npm run typecheck
npm run check:boundaries
npm run lint
npm run build
npm run test
node --import tsx --test tests/contracts/*.test.ts
```

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-10T18:18:25.221Z",
  "model": "configured-clio-target",
  "gitHead": "220b25cbca487863e483c66c489d7ea2bdb3ddbb",
  "treeHash": "6f1bcd59231fe3c28cccd64cb724619b3595b659e6664c366436aba885332f53",
  "loc": 93785
}
-->
