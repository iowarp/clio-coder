---
name: clio-live-drive
description: Use when you need to exercise the real clio-coder binary against a real model to see whether a change works, not just whether its tests pass. Covers the headless run, the operator live drivers, the scripted PTY drive of the TUI, and launching Clio interactively in a tmux or herdr pane with isolated state. For any agent working on this repository (Claude Code, Codex, Gemini, Clio herself).
---

# Driving the real Clio

A contract test with a stubbed model proves machinery. This skill is for the
other claim: that Clio, built from this checkout, does the thing against a
model that actually answers. Use it after `npm run build`, when a change
touches the agent loop, tools, dispatch, context, the TUI, or a provider.

Four rules, no exceptions:

1. **Real binary, real prompt, fake repository.** Run `dist/cli/index.js`
   (or the installed `clio-coder`) in a temporary repository made for the
   run. Never run an experiment in this checkout or in the operator's
   projects.
2. **Isolated state.** Every run gets a throwaway Clio home holding only the
   chosen target. The drivers below do this for you; if you launch by hand,
   source `live:home` first. Never point a run at the operator's real
   config, data, state, or cache.
3. **Explicit target.** The model is `--target <id>`, one of the ids
   `clio-coder targets` prints. `--model <wireId>` and `--thinking <level>`
   override that target's defaults for the run.
4. **Assert on outcomes.** Files written, the session ledger, receipts under
   `<state>/receipts`, the JSONL event stream, transcript text. "It printed
   something" is not a pass.

## Pick the surface

| You want to know | Run |
| --- | --- |
| Does the target answer through Clio at all? | `npm run live:smoke -- --target <id>` |
| What does one headless turn do for this prompt? | `node dist/cli/index.js --no-context-files run --target <id> --json "<prompt>"` inside a `live:home` shell, cwd in a temp repo |
| Does the model route and dispatch as documented? | `npm run live:recon -- --target <id>` and `npm run live:fleet-dispatch -- --target <id>` |
| What does a person see in the TUI for these inputs? | `npm run live:tui -- --target <id> --workspace <dir> --send "<prompt>" --send "/context"` |
| I want to watch it interactively | a tmux or herdr pane, below |
| Does the machinery hold under load? | `clio-coder eval run --suite benchmarks/soak/clio-soak.yaml --target <id> --model <wireId> --clio-coder-entry dist/cli/index.js` |

All drivers take `--help`, exit 0/1/2 for pass/fail/usage, keep a failed
run's scratch tree and print its path, and remove a passing run's tree unless
`--keep` is given.

## Scripted TUI drive (`live:tui`)

```bash
npm run build
npm run live:tui -- --target zbook --model qwen3.8-27b \
  --workspace benchmarks/soak/fixtures/single-file-bug \
  --send "Use the read tool to read src/window.mjs in full, then reply with exactly: window read" \
  --send "/context" \
  --out /tmp/clio-tui-out
```

The workspace is copied into the scratch tree (`--in-place` to skip that).
Each `--send` is typed and followed by Enter. A prompt waits until the session
ledger shows the assistant turn settled (last message is an assistant message
with no `toolCall` block), then 2.5 s for the last frame. A slash command
waits `--settle-ms` (3000). The driver presses Escape, types `/quit`, and
expects exit 0. Outputs under `--out`:

- `transcript.txt`: what a person saw, ANSI stripped.
- `raw.txt`: the bytes, for escape-sequence questions.
- `ledger.jsonl`: the session ledger (`current.jsonl`).
- `report.json`: target, size, per-turn settle times, ledger counts
  (`userMessages`, `assistantMessages`, `toolResults`, `contextEviction`,
  `contextRecall`, `compactionSummary`), exit status.

Read `report.json` first. Then read `transcript.txt` for the words and
`ledger.jsonl` for what actually happened (tool calls, results, context
sidecars). The TUI is ready when the footer shows `ctx `; that is the regex the
driver waits on.

## Interactive: tmux

Prepare an isolated home, then launch Clio in a detached tmux session at a
real size and talk to it:

```bash
eval "$(npm run -s live:home -- --target zbook --model qwen3.8-27b)"
WS=$(mktemp -d /tmp/clio-ws-XXXXXX) && cp -r benchmarks/soak/fixtures/single-file-bug/. "$WS"
tmux new-session -d -s clio -x 140 -y 44 -c "$WS" "node $PWD/dist/cli/index.js"
until tmux capture-pane -pt clio | grep -q 'ctx '; do sleep 1; done   # ready
tmux send-keys -t clio "Read src/window.mjs and reply with exactly: window read" Enter
sleep 20; tmux capture-pane -pt clio -S -200                           # what a person sees
tmux send-keys -t clio "/quit" Enter
rm -rf "$CLIO_CODER_HOME" "$WS"
```

`live:home` prints `export CLIO_CODER_HOME=...` and the four `_DIR` exports;
`eval` puts them in your shell so tmux inherits them. Turn settlement is in
the ledger, not the screen: poll
`$CLIO_CODER_STATE_DIR/sessions/*/*/current.jsonl` for an assistant `message`
without a `toolCall` block if you need to know a turn finished rather than
sleeping. Remove the home when done; that also removes the copied
credentials.

## Interactive: herdr

Only when `HERDR_ENV=1` (you are inside a herdr pane). The same isolation,
with the exports passed as pane env:

```bash
npm run -s live:home -- --target zbook --model qwen3.8-27b > /tmp/clio-home.env
ENV_ARGS=$(grep '^export' /tmp/clio-home.env | sed 's/^export /--env /' | tr '\n' ' ')
WS=$(mktemp -d /tmp/clio-ws-XXXXXX) && cp -r benchmarks/soak/fixtures/single-file-bug/. "$WS"
PANE=$(herdr pane split --current --direction right --cwd "$WS" $ENV_ARGS --no-focus | jq -r .result.pane.pane_id)
herdr pane run "$PANE" "node $PWD/dist/cli/index.js"
herdr pane wait-output "$PANE" --regex 'ctx ' --timeout 90000
herdr pane send-text "$PANE" "Read src/window.mjs and reply with exactly: window read"
herdr pane send-keys "$PANE" enter
herdr pane read "$PANE" --source recent --lines 60
herdr pane send-text "$PANE" "/quit"; herdr pane send-keys "$PANE" enter
```

`herdr pane read` is what a person sees; the ledger under the printed
`CLIO_CODER_STATE_DIR` is what happened. Close the pane and remove the home
when done. Herdr does not classify Clio as a known agent, so use the pane
verbs, not `herdr agent`.

## Writing your own driver

Import the harness rather than re-creating it:

```ts
import { openPty, stripAnsi } from "../../tests/harness/pty.js";         // the PTY
import { parseLiveArgs, prepareLiveHome, clio, runDriver } from "./live-target.js"; // target + scratch home
```

`tests/harness/pty.ts` is the one pseudo-terminal implementation in the
repository (`openPty` for a controllable session, `runInPty` for a scripted
one, `stripAnsi`, `visibleLines`, `colorSequences`). `live-target.ts` turns
`--target` into a scratch home with that target and gives you
`clio(home, args)` to run the binary in it. Start from `live-smoke.ts`; keep
the driver to the checks you can read back from the tree.

## What not to do

- Do not write probe scripts under `scripts/` or `tests/`; a one-off goes in
  your scratch directory and is deleted.
- Do not add a `CLIO_CODER_LIVE_*` environment gate or a second settings
  template. The target flag and `DEFAULT_SETTINGS` are the contract.
- Do not call a stubbed-model test a live run, and do not put a live run
  under `npm test`.
- Do not leave scratch homes behind: they carry copied credentials.
