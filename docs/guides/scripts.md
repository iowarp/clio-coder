# Scripts reference

## npm lifecycle

- build: tsup production bundle to dist/
- dev: tsup watch mode for local iteration
- clean: rm -rf dist
- typecheck: tsc --noEmit
- format: biome format --write
- lint: biome check
- verify: scripts/verify.ts, inline orchestrator smoke path
- smoke: scripts/verify.ts --smoke (60s end-to-end cycle, deferred in v0.1)
- ci: chained typecheck + lint + check:boundaries + check:prompts + all diag:* + build + verify
- stress: 10 concurrent clio-run subprocesses, asserts ledger concurrency
- hooks:install: installs repo git hooks from scripts/git-hooks/ into .git/hooks/

## Boundary + prompt gates

- check:boundaries: scripts/check-boundaries.ts, engine + worker isolation
- check:prompts: scripts/check-prompts.ts, fragment frontmatter + composition hashes
- diag:boundaries: scripts/diag-boundaries.ts, surfaces rg report inline

## Diag suite (ci-enforced)

- diag:safety: scripts/diag-safety.ts, classifier + audit record shape
- diag:modes: scripts/diag-modes.ts, mode matrix + allow/block decisions
- diag:registry: scripts/diag-registry.ts, tool registry wiring per mode
- diag:prompt: scripts/diag-prompt.ts, deterministic compiled prompt hash
- diag:session: scripts/diag-session.ts, session domain wire-up + events
- diag:credentials: scripts/diag-credentials.ts, 0600 umask race + keychain path
- diag:providers: scripts/diag-providers.ts, provider list + canSatisfy gates
- diag:agents: scripts/diag-agents.ts, agent discovery (builtin + user + project)
- diag:tools: scripts/diag-tools.ts, full 14-tool admission matrix
- diag:cli-runtimes: scripts/diag-cli-runtimes.ts, six CLI adapter canSatisfy checks
- diag:interactive-tui: scripts/diag-interactive-tui.ts, routeInteractiveKey + footer refresh
- diag:claude-sdk: scripts/diag-claude-sdk.ts, Claude Agent SDK subprocess adapter
- diag:dispatch: scripts/diag-dispatch.ts, dispatch domain admission + ledger path
- diag:single-dispatch: scripts/diag-single-dispatch.ts, one-worker end-to-end NDJSON + receipt
- diag:worker-tools: scripts/diag-worker-tools.ts, worker tool surface under isolation
- diag:orchestrator: scripts/diag-orchestrator.ts, topological boot + shutdown sequencing
- diag:observability: scripts/diag-observability.ts, telemetry counters + cost tracker
- diag:scheduling: scripts/diag-scheduling.ts, budget ceiling + concurrency token bucket

## Diag suite (manual, not ci)

- diag:interactive: scripts/diag-interactive.ts, non-tui interactive boot smoke
- diag:config: scripts/diag-config.ts, settings.yaml schema + hot-reload
- diag:xdg: scripts/diag-xdg.ts, XDG path resolution + install idempotence
- diag:session-engine: scripts/diag-session-engine.ts, JSONL append + atomic tree write
- diag:agents-parser: scripts/diag-agents-parser.ts, markdown + YAML frontmatter parse
- diag:providers-catalog: scripts/diag-providers-catalog.ts, 8-provider catalog shape
- diag:provider-runtimes: scripts/diag-provider-runtimes.ts, provider runtime adapter hooks
- diag:tools-core: scripts/diag-tools-core.ts, read/write/edit/bash/grep/glob/ls
- diag:tools-search: scripts/diag-tools-search.ts, grep + glob search semantics
- diag:tools-web: scripts/diag-tools-web.ts, web_fetch + web_search surface
- diag:tools-plan-review: scripts/diag-tools-plan-review.ts, write_plan/write_review path guard
- diag:tools-dispatch: scripts/diag-tools-dispatch.ts, dispatch_agent + batch_dispatch + chain
- diag:dispatch-state: scripts/diag-dispatch-state.ts, PID-owned ledger lock, 5-worker race
- diag:dispatch-spawn: scripts/diag-dispatch-spawn.ts, worker spawn + heartbeat classifier
- diag:dispatch-primitives: scripts/diag-dispatch-primitives.ts, admission + scope subset check
- diag:worker-entry: scripts/diag-worker-entry.ts, worker NDJSON entry contract
- diag:bootstrap: scripts/diag-bootstrap.ts, boot-order probe without running domains

## Helpers

- verify-prompt: subprocess spawned by verify.ts to exercise prompt compile determinism
- verify-session: subprocess spawned by verify.ts to exercise session JSONL round-trip
- verify-run: subprocess spawned by verify.ts to exercise clio run --faux

## Orchestrator-of-orchestrator infrastructure (scripts/orch/)

- send-impl.sh: dispatch task file to tmux clio-impl worker, writes <task>.result.md with IMPL_DONE
- send-review.sh: dispatch review file to tmux clio-review worker, writes <review>.result.md with REVIEW_DONE
- watch-prompts.sh: background watchdog that auto-answers Codex /full-auto approval prompts
