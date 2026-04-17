# Clio-Coder

Clio is IOWarp's orchestrator coding-agent, built on a Level-3 custom harness over pi-mono. It discovers providers, composes agents, dispatches work across native, SDK, and CLI runtimes under a unified safety model, and surfaces everything through a single disciplined TUI.

## Status

v0.1 — under active development. See `docs/specs/2026-04-16-clio-coder-design.md` for the design plan and `docs/superpowers/plans/2026-04-16-clio-coder-roadmap.md` for the phased implementation roadmap.

## Install (dev)

```
npm install
npm run build
node dist/cli/index.js --version
```

## Run from source

Work on Clio as if it were installed globally by linking the built binary into your `npm` prefix. The `bin.clio` entry in `package.json` resolves to `dist/cli/index.js`, so `npm link` exposes the same `clio` binary that the published package will expose.

```
npm ci
npm run build
npm link
clio --version
clio install
clio doctor
clio
npm unlink -g @iowarp/clio-coder
```

Notes:

- Re-run `npm run build` after every source change; `npm link` symlinks the package, not the source tree. Use `npm run dev` for a watch build during iteration.
- `clio install`, `clio doctor`, and `clio` all honor `CLIO_HOME` and the individual `CLIO_CONFIG_DIR` / `CLIO_DATA_DIR` / `CLIO_CACHE_DIR` overrides. Set one of them (e.g. `CLIO_HOME=$(mktemp -d)`) to exercise the CLI against an ephemeral state tree without touching your real `~/.clio`.
- The link stays active across shells until you run `npm unlink -g @iowarp/clio-coder`. Forgotten links are harmless but can mask a stale build; check with `which clio` and `readlink -f "$(which clio)"` if output looks outdated.

## Tech

TypeScript 5.7 strict. Node 20+. Engine layer over `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`. Apache 2.0.
