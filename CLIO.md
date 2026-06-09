# Clio Coder

Clio Coder is a TypeScript-based code generation orchestrator that assembles context files (CLIO.md) from domain modules and entry points. It runs as a CLI tool with modular domains for agents, components, configuration, evaluation, dispatch, and session management.

## Conventions

- Each domain lives under src/domains/<name> and exports its public API via an index.ts.
- All command-line interfaces are defined in src/cli and must import from the core engine.
- Tool registration occurs through src/tools/bootstrap.ts; tools activate only when a session contract is present.

## Hard invariants

1. The project must compile without TypeScript errors under tsc --noEmit.
2. All public symbols are re-exported from an index.ts file in their directory.
3. Session migrations run automatically on each session start.

## Domain Architecture

Modules are grouped under src/domains and expose a public API via index.ts. Each domain is isolated; internal imports use relative paths.

## CLI Entrypoint

The CLI lives in src/cli/index.ts and coordinates tool execution, session handling, and prompt rendering. It must not import directly from test files.

## Tool Registration & Context

Tools are registered via src/tools/bootstrap.ts. The workspace_context tool is only enabled when a session contract is supplied; otherwise it is skipped.

## Session Migration Flow

Session migrations under src/domains/session/migrations and src/domains/lifecycle/migrations apply versioned state changes on every session resume. Migrations mutate SessionMeta in place.

## Failure Modes & Verification

Build failures occur if any migration throws or the TypeScript compiler reports errors. Verify by running npm run build which compiles, lints, and runs migrations without side effects.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-09T23:02:05.005Z",
  "model": "configured-clio-target",
  "gitHead": "c48a5fd4c256bda5d6e188e41baa93e6fd82bcd5",
  "treeHash": "42b7fe2a708d740ff0ec6de8dd280e9f4d1dc1b7646fa2a2bc84e873292ee6f6",
  "loc": 87529
}
-->
