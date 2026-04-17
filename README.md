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

## Tech

TypeScript 5.7 strict. Node 20+. Engine layer over `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`. Apache 2.0.
