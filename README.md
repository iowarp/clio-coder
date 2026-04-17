# Clio-Coder

Clio is IOWarp's orchestrator coding-agent for running agent work through one safety model.

Clio is the brain of a distributed agentic harness. Workers are the hands.
It is built as a Level 3 custom harness on pi-mono, so Clio owns the agent
loop, prompt compilation, tool registry, session format, slash commands, and
interactive surface instead of handing that identity to a single worker
runtime. The project exists inside IOWarp to make orchestration itself the
product, with native, SDK, and CLI workers all treated as guests.

## Status

Package version in `package.json`: `0.1.0-dev`. Next tag is
`v0.1.0-rc1`; see [CHANGELOG.md](CHANGELOG.md) for the rc1 notes and
[docs/guides/overview.md](docs/guides/overview.md) for the phase roll-up.

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
`CLIO_DATA_DIR`, and `CLIO_CACHE_DIR` for isolated state trees.
[docs/guides/interactive-test-walkthrough.md](docs/guides/interactive-test-walkthrough.md)
covers the fuller install and smoke path.

## Quickstart with the homelab examples

`clio install` seeds `~/.clio/settings.yaml` with commented
`llamacpp@mini` and `lmstudio@dynamo` example blocks. To light them
up: edit `~/.clio/settings.yaml`, uncomment the block between
`# clio-example:start provider=llamacpp endpoint=mini` and
`# clio-example:end` so the `mini` entry replaces the surrounding
`endpoints: {}`; do the same for `provider=lmstudio endpoint=dynamo`
and for the matching `block=workers` section if you want `clio run`
to route there by default. Then:

```bash
clio doctor                                    # settings parse + paths
clio providers                                 # probe endpoints + register models
clio run scout "summarize the repo layout"    # native worker + receipt
```

Append `--faux` to the `clio run` line for a provider-less smoke test.

## Interactive surface

Start the TUI with bare `clio`. The banner renders as
`◆ clio  IOWarp orchestrator coding-agent`.

Slash commands in v0.1:

- `/run <agent> <task>` dispatches a worker and streams its events.
- `/providers` overlays provider + endpoint health from the providers
  domain.
- `/cost` overlays session token totals and USD cost accumulated
  from completed runs.
- `/receipts` opens a paginated list of run receipts persisted under
  `<dataDir>/receipts/`.
- `/receipt verify <runId>` reads a receipt and reports whether its
  ledger hash matches on disk.
- `/help` and `/quit` do the obvious.

Keybindings: `Shift+Tab` cycles `default` ⇄ `advise`, `Alt+S` opens
the super-mode confirmation overlay, `Ctrl+B` toggles the
dispatch-board overlay whose rows update live from the dispatch event
bus, and `Ctrl+D` triggers the four-phase shutdown.

## Providers and runtimes

Local runtimes are `llamacpp`, `lmstudio`, `ollama`, and
`openai-compat`. Each reads its endpoint list from `settings.yaml`
and registers the endpoint's discovered models into pi-ai's runtime
catalog under the provider id. Qwen-family local models have
thinking-content pass-through enabled via the `thinkingFormat`
compat field so reasoning output reaches the worker and the receipt.

Runtime tiers: `native` (Clio's own worker subprocess on
`pi-agent-core`, the only tier admitted by dispatch in v0.1), `sdk`
(Claude Agent SDK adapter, scaffolded; dispatch rejects `sdk` in
v0.1), `cli` (`pi-coding-agent`, `claude-code`, `codex`, `gemini`,
`opencode`, `copilot`, scaffolded; dispatch rejects `cli` in v0.1).

Safety modes: `default` (read + write + edit + bash + search +
dispatch tools visible), `advise` (read-oriented), `super`
(privileged writes outside cwd, requires the confirmation overlay).

## Architecture at a glance

Thirteen domains: `config`, `providers`, `safety`, `modes`, `prompts`,
`session`, `agents`, `dispatch`, `observability`, `scheduling`,
`intelligence`, `lifecycle`, and `ui` (folded under `src/interactive/`
in v0.1). Hard invariants enforced by `scripts/check-boundaries.ts`:
only `src/engine/**` imports pi-mono packages, `src/worker/**` never
imports `src/domains/**`, and cross-domain traffic goes through
`SafeEventBus`. Full design:
[docs/specs/2026-04-16-clio-coder-design.md](docs/specs/2026-04-16-clio-coder-design.md),
[docs/architecture/pi-mono-boundary-0.67.4.md](docs/architecture/pi-mono-boundary-0.67.4.md).

## Development

Full script index: [docs/guides/scripts.md](docs/guides/scripts.md).

- `npm run ci`: repo gate. Typecheck, lint, `check:boundaries`,
  `check:prompts`, the CI-enforced `diag:*` suite, production build,
  and `verify`.
- `npm run stress`: ten concurrent faux runs against the shared run
  ledger.
- `npm run stress:real`: opt-in real-provider variant against
  `llamacpp@mini` and `lmstudio@dynamo`. Excluded from CI.
- `npm run diag:inference:live` and `npm run diag:vision:live`:
  end-to-end real-inference and vision-inference probes against the
  homelab. Excluded from CI.
- `npm run typecheck`, `npm run build`, `npm run dev`: strict TS
  pass, production bundle, and `tsup --watch` loop.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a non-trivial
change. The repo prefers small, reviewable slices, and the working
discipline is one commit per slice whenever possible so intent stays
obvious in history. Keep `npm run ci` green on every commit. No
em-dash clause separators in commit subjects, commit bodies, or docs.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Acknowledgements

Clio builds on pi-mono and the wider agent tooling work by Mario
Zechner ([@mariozechner](https://github.com/mariozechner)). The
project also takes direct inspiration from `pi-subagents` for
agent-spec structure and from `pi-coding-agent` for the lessons
about what belongs in a worker adapter versus the orchestrator core.
