# Internal benchmark harness

These operator-run drivers exercise the built candidate against a real model.
They are versioned development tools, but they do not run under `npm test`,
`npm run ci`, or `npm run ci:release`.

## Rules

1. Run `dist/cli/index.js`, never an unverified registry install.
2. Use a throwaway repository and isolated Clio home.
3. Select `--target`, `--model`, and `--thinking` explicitly.
4. Assert on files, JSONL, ledgers, receipts, exit status, and cleanup.
5. Keep raw output under an ignored `runs/` directory.
6. Preserve failed attempts; a rerun gets a new directory and a reason.

## Deterministic self-check

```sh
npm run benchmark:check
```

This typechecks the internal drivers and runs adapter/harness contracts from
`internal/tests/`. It calls no model and is intentionally separate from the
product release gate.

Start a campaign before the first attempt, then freeze the final two-axis table
without overwriting prior evidence:

```sh
npm run benchmark:campaign -- \
  --out benchmarks/internal/runs/<campaign> \
  --target <id> --model <id> --thinking <level> \
  --input humaneval=<dataset> --selection humaneval=HumanEval/0,HumanEval/17

npm run benchmark:report -- \
  --campaign benchmarks/internal/runs/<campaign> \
  --status humaneval=valid,pass \
  --result humaneval=benchmarks/internal/runs/<campaign>/humaneval/summary.json
```

Both commands refuse ambiguous status values. The report refuses to overwrite
an existing report; a rerun is a new campaign or attempt directory.

## Live commands

| Command | Purpose |
| --- | --- |
| `npm run live:smoke -- --target <id>` | Built-binary provider smoke and one known reply. |
| `npm run live:fleet-dispatch -- --target <id>` | Model-authored Scout/Debugger lifecycle with receipts and an unchanged workspace. |
| `npm run live:tui -- --target <id> --workspace <dir> --send <text>` | Scripted real PTY; writes transcript, raw bytes, ledger, and report. |
| `npm run -s live:home -- --target <id>` | Isolated launcher for an interactive tmux or herdr pane. |

All commands take `--help`. A failed run retains its scrubbed scratch tree; a
passing run removes it unless `--keep` is supplied. `live:home` is the one
exception because its pane has not run yet: release it explicitly.

## Herdr

Only use this path when `HERDR_ENV=1`:

```sh
BENCH_HOME=$(npm run -s live:home -- \
  --target dynamo --model qwen3.8-27b --thinking off)
BENCH_WS=$(mktemp -d /tmp/clio-bench-ws-XXXXXX)
PANE=$(herdr pane split --current --direction right --cwd "$BENCH_WS" --no-focus | jq -r .result.pane.pane_id)
herdr pane run "$PANE" "$BENCH_HOME/clio"
herdr pane wait-output "$PANE" --regex 'ctx ' --timeout 90000
```

Drive the pane with `herdr pane send-text`, `send-keys`, and `read`. Settlement
comes from the session ledger under `$BENCH_HOME/state`, not from a sleep or a
screen guess. Finish with `/quit`, close the pane, then:

```sh
npm run -s live:home -- --release "$BENCH_HOME"
```

Never put credentials in pane commands, logs, manifests, or env files.

## Result contract

Generated output belongs below `benchmarks/internal/runs/<run-id>/` and is
ignored. A campaign records the candidate commit and dirty diff hash, binary
and selected input hashes, exact target/model/thinking, dataset and grader identity,
fixed task selection, per-attempt events, usage coverage, run/session IDs,
receipt integrity, process cleanup, upstream score, and artifact hashes.

`harnessStatus` and `taskStatus` are independent. Infrastructure or scorer
failure invalidates evidence; an upstream test failure is a valid model result.
