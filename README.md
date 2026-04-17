# Clio-Coder

Clio is IOWarp's orchestrator coding-agent for running agent work through one safety model.

Clio is the brain of a distributed agentic harness. Workers are the hands.
It is built as a Level 3 custom harness on pi-mono, so Clio owns the agent
loop, prompt compilation, tool registry, session format, slash commands, and
interactive surface instead of handing that identity to a single worker
runtime. The project exists inside IOWarp to make orchestration itself the
product, with native, SDK, and CLI workers all treated as guests.

## Banner

This is the current banner row rendered by bare `clio` in interactive mode.

```text
  ◆ clio  IOWarp orchestrator coding-agent
```

## Status

Package version: `0.1.0-dev`.

Phases 2 through 8 are complete. Phases 9 and 10 are partial. See
[docs/guides/overview.md](docs/guides/overview.md) for the full phase
roll-up, tagged SHAs, and the deferred work still open in the
interactive, observability, scheduling, and intelligence tracks.

## Install from source

Clio targets Node 20+ and ships as `@iowarp/clio-coder`.

```bash
npm install
npm run build
npm link
clio --version
```

`npm link` exposes the same `clio` binary declared in `package.json`
(`dist/cli/index.js`). Re-run `npm run build` after source changes
because the link points at built output, not the TypeScript sources.

The runtime is XDG-aware and also honors `CLIO_HOME`, `CLIO_CONFIG_DIR`,
`CLIO_DATA_DIR`, and `CLIO_CACHE_DIR` when you want an isolated state tree. For
the fuller install and smoke path, use
[docs/guides/interactive-test-walkthrough.md](docs/guides/interactive-test-walkthrough.md).

## Five-minute tour

1. `clio install`: bootstrap Clio's local directories, write default
   `settings.yaml`, and create `credentials.yaml` plus `install.json`
   when they are missing.
2. `clio doctor`: report resolved config, data, and cache paths,
   package and pi-mono versions, Node version, and missing runtime
   binaries.
3. `clio providers`: list discovered providers with availability and
   health so you can see which runtimes are ready before dispatch. Local
   inference engines (`llamacpp`, `lmstudio`, `ollama`, `openai-compat`)
   read their endpoint list from `~/.clio/settings.yaml` and report
   per-endpoint probe status; see `docs/guides/overview.md` for the
   settings shape.
4. `clio agents`: list built-in, user, and project agent recipes with
   their default mode.
5. `clio run scout hello --faux`: run a headless faux dispatch through
   the native worker path, stream the non-heartbeat event types, and
   finish with a receipt summary.
6. `clio`: start the interactive scaffold, use `/help`, run
   `/run scout hello`, and exit cleanly with `/quit` when you are done.
7. `npm run stress`: launch ten concurrent faux runs and verify the
   shared run ledger merges correctly under lock.

In the interactive scaffold today, `Shift+Tab` cycles `default` and
`advise`, the footer shows the active mode plus provider, and the
current slash-command surface is intentionally small.

## Architecture at a glance

Clio is organized as 13 domains. In v0.1, the `ui` domain is folded under
`src/interactive/` while the TUI scaffold and overlay surface are still
being built out.

### Domains

- `config`: settings loading, schema validation, and file watching.
- `providers`: provider registry, model catalog, credentials, and
  health.
- `safety`: audit records, action classification, scope rules, and
  dangerous-command interception.
- `modes`: current mode and the tool allowlist matrix.
- `prompts`: identity, mode, and safety fragments plus SHA-256
  compiled prompts.
- `session`: session JSONL, checkpoint, resume, and history state.
- `agents`: recipe discovery across builtin, user, and project scopes.
- `dispatch`: worker spawn, admission, run ledger, and batching.
- `observability`: telemetry, metrics, receipts, and cost tracking.
- `scheduling`: budget counters, concurrency ceilings, and cluster
  state.
- `intelligence`: scaffolded detector, solver, and learner hooks.
- `lifecycle`: install metadata, version info, migrations, and health
  checks.
- `ui`: banner, editor, footer, panels, overlays, theme, and slash
  routing. In v0.1 this code lives under `src/interactive/`.

### Runtime tiers

- `native`: Clio's own worker subprocess built on `pi-agent-core`.
  This is the deepest control path and the richest telemetry tier.
- `sdk`: Claude Agent SDK running in a subprocess. It provides structured I/O without folding the SDK into the orchestrator process.
- `cli`: `pi-coding-agent`, `claude-code`, `codex`, `gemini`, `opencode`, and
  `copilot` adapters. This tier trades control depth for breadth of runtime
  coverage.

### Safety modes

- `default`: the launch mode with read, write, edit, bash, search, and
  dispatch tools visible.
- `advise`: the read-oriented mode. `Shift+Tab` cycles between
  `default` and `advise` in the interactive scaffold today.
- `super`: the privileged mode for writes outside cwd and package
  installs. The design entry is `Alt+S`, and the confirmation overlay
  remains part of the Phase 9 deferred work listed in the overview.

### Hard invariants

- Engine boundary: only `src/engine/**` imports
  `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and
  `@mariozechner/pi-tui`.
- Worker isolation: `src/worker/**` never imports `src/domains/**`.
- Domain independence: each domain owns its own state and
  cross-domain traffic goes through `SafeEventBus`.

These invariants are enforced in CI by `scripts/check-boundaries.ts`. For the
full thesis, domain table, runtime model, and decision log, read
[docs/specs/2026-04-16-clio-coder-design.md](docs/specs/2026-04-16-clio-coder-design.md).

## Config directory layout

The design spec describes a single logical `~/.clio/` tree. At runtime, Clio
is XDG-aware and also honors `CLIO_HOME`, `CLIO_CONFIG_DIR`,
`CLIO_DATA_DIR`, and `CLIO_CACHE_DIR`, but the state ownership map from
design spec section 18 still looks like this:

```text
~/.clio/
├── settings.yaml
├── credentials.yaml
├── install.json
├── cache/
│   └── models.json
├── agents/
│   └── ...
├── sessions/
│   └── <cwd-hash>/
│       ├── current.jsonl
│       └── tree.json
├── audit/
│   └── YYYY-MM-DD.jsonl
├── state/
│   ├── runs.json
│   ├── metrics.json
│   ├── budget.json
│   └── cluster.json
└── receipts/
    └── <run-id>.json
```

Every persistent artifact has a single owner. Settings belong to
`config`, credentials and model cache belong to `providers`, sessions
belong to `session`, audit belongs to `safety`, the run ledger belongs
to `dispatch`, receipts and metrics belong to `observability`, and
budget or cluster state belongs to `scheduling`.

## Development

The full script index lives in [docs/guides/scripts.md](docs/guides/scripts.md).
Day-to-day work mostly comes down to a small set of commands.

- `npm run ci`: the repo gate. It chains typecheck, lint,
  `check:boundaries`, `check:prompts`, the CI-enforced `diag:*` suite,
  the production build, and `verify`.
- `npm run stress`: the concurrency harness. It spawns ten faux runs and
  checks that the shared run ledger stays correct under contention.
- `npm run typecheck`: the fastest strict TypeScript pass when you want
  quick feedback before the full gate.
- `npm run diag:*`: targeted probes for boundaries, safety, modes,
  registry wiring, providers, agents, dispatch, the interactive TUI,
  observability, scheduling, and related surfaces.

For local iteration, `npm run build` produces the production bundle and
`npm run dev` keeps `dist/` warm under `tsup --watch`.

## Project invariants

- `src/engine/**` is the only place allowed to import pi-mono packages.
  This keeps upgrades contained to the engine layer.
- `src/worker/**` stays isolated from `src/domains/**` because workers
  are subprocesses, not in-process extensions.
- Domain state stays local to the owning domain. Cross-domain
  communication goes through `SafeEventBus`, and CI rejects boundary
  drift.

These are not style preferences. They are build-time rules that keep the
orchestrator from collapsing into a single god object.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a non-trivial change.
The repo prefers small, reviewable slices, and the working discipline is one
commit per slice whenever possible so intent stays obvious in history. Keep
`npm run ci` green on every commit. The prose rule is strict: no em-dash
clause separators anywhere in commit subjects, commit bodies, or docs.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

Clio builds on pi-mono and the wider agent tooling work by Mario Zechner
([@mariozechner](https://github.com/mariozechner)). The project also takes
direct inspiration from `pi-subagents` for agent-spec structure and from
`pi-coding-agent` for the lessons about what belongs in a worker adapter
versus the orchestrator core.
