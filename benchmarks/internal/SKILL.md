---
name: clio-live-drive
description: Drive the built Clio Coder candidate against a real model in an isolated temporary repository, including headless, PTY, tmux, and herdr runs.
---

# Driving the real Clio

Use this only after `npm run benchmark:check` and `npm run build` pass.

## Non-negotiable rules

1. Use the current `dist/cli/index.js` or a tarball hashed from this checkout.
2. Never experiment in this checkout or an operator project.
3. Use `live:home` or another internal driver so config, state, data, cache,
   credentials, and temp files live under one leased scratch tree.
4. Pin target, model, and thinking explicitly.
5. Assert on observable outcomes: workspace files, JSONL, ledger settlement,
   receipts, grader output, exit status, and cleanup.
6. Store output only under ignored `runs/`; never overwrite a prior attempt.

## Pick a surface

| Question | Command |
| --- | --- |
| Does the target answer? | `npm run live:smoke -- --target <id>` |
| What does a scripted TUI turn do? | `npm run live:tui -- --target <id> --workspace <dir> --send <text>` |
| Can the model manage a real fleet lifecycle? | `npm run live:fleet-dispatch -- --target <id>` |
| Do I need to watch interactively? | `npm run -s live:home -- --target <id>`, then launch `<home>/clio` in herdr or tmux. |

The TUI is ready when the footer contains `ctx `. A prompt is settled only
when the session ledger ends in an assistant message without a pending tool
call. Always quit the TUI and release the live home.

Community workload scores come from their upstream graders, never from
`clio-coder eval` and never from the model's prose.
