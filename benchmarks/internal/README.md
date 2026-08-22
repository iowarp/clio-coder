# Internal drivers: exercising the real Clio outside CI

Everything here runs the built binary (`dist/cli/index.js`) against a model
the operator names with `--target <id>`. Nothing here runs under `npm test`
or `npm run ci`; those stay deterministic and offline. Nothing here is
shipped in the package.

Three rules every file in this directory follows:

1. The binary is real, the prompts are real, and the repository is a
   temporary one made for the run. A pass means Clio did the thing, not that
   a stub returned the expected string. Machinery tests with stubbed models
   live under `tests/` and are labeled as such.
2. The target is explicit. `--target <id>` names a target from the operator's
   own `settings.yaml` (`clio-coder targets` lists them); `--model` and
   `--thinking` override that target's defaults for the run. The target is
   copied into a throwaway Clio home, so the run never reads or writes the
   operator's real config, data, state, or cache.
3. A failed run keeps its scratch tree and prints the path. A passing run
   removes it unless `--keep` was given. Copied credentials never survive the
   run either way.

## Entry points

| Command | Drives | Proves |
| --- | --- | --- |
| `npm run live:smoke -- --target <id> [--delegation]` | headless `run` | The target answers through Clio's provider path end to end: `--version`, `doctor --fix` on an empty home, one turn with a known reply. `--delegation` adds the opencode and copilot ACP agents. |
| `npm run live:recon -- --target <id> [--max-cost-usd 0.50]` | `eval run --suite` | Two model behaviors: a stale codewiki is not answered from alone (`wiki.staleAcknowledged`), and an "orient me" request dispatches Scout (`dispatch.scoutCount >= 1`). Suite, metrics, per-item isolation, and cost ceiling are the eval runner's own. |
| `npm run live:fleet-dispatch -- --target <id> [--thinking medium]` | headless `run --json` | The model-authored fleet lifecycle: one synchronous Scout, 1–6 parent spot-checks, one detached Debugger with a real briefing, one guide steer, monitor/wait/collect in order, truthful receipt labels, and a workspace that did not change. Read from the JSONL stream and the scratch home's receipts, `runs.json`, and `batches.json`. |
| `npm run live:tui -- --target <id> --workspace <dir> --send "<text>"...` | the TUI in a real PTY | What a person sees: prompts settle off the session ledger, slash commands open their overlays, `/quit` exits 0, and the terminal is handed back. Writes `transcript.txt`, `raw.txt`, `ledger.jsonl`, and `report.json`. |
| `eval "$(npm run -s live:home -- --target <id>)"` | nothing; prints exports | A scratch home holding only that target, for launching `node dist/cli/index.js` yourself in a tmux or herdr pane (`SKILL.md`). Never removed by the command. |
| `clio-coder eval run --suite benchmarks/soak/clio-soak.yaml --target <id> --model <wireId> --clio-coder-entry dist/cli/index.js` | the eval runner | Machinery under load: receipts sealed and authenticating, outcome matching exit status, no orphaned children, usage counted once. The soak suites are under `../soak/`. |

Every driver takes `--help`. Exit codes: 0 pass, 1 a check failed, 2 usage.

## Files

```text
live-target.ts         --target resolution, scratch home, settings from DEFAULT_SETTINGS, spawn, redaction
live-smoke.ts          one headless turn (+ ACP delegation)
live-recon.ts          stale-wiki and Scout-routing eval suite
live-fleet-dispatch.ts the fleet lifecycle regression
live-home.ts           scratch home + exports for an interactive pane
pty-drive.ts           scripted TUI drive in a pseudo-terminal
SKILL.md               how an agent (Claude Code, Codex, Gemini, Clio) drives the real Clio
inventory.md           every way Clio is exercised, with a keep/merge/delete decision each
```

The pseudo-terminal itself is `tests/harness/pty.ts` (`openPty`, `runInPty`,
`stripAnsi`, `visibleLines`, `colorSequences`). It is the one PTY
implementation in the repository; the CI smoke suites and `pty-drive.ts` are
both consumers of it. New drivers import it rather than adding another.

## Writing a new driver

Start from `live-smoke.ts`. `parseLiveArgs` handles the shared flags and hands
back the rest; `prepareLiveHome` gives you the scratch home with the chosen
target; `clio(home, args)` runs the binary inside it; `runDriver` turns a
thrown `LiveUsageError` into exit 2 and a `false` return into exit 1. Assert on
observable outcomes: files written, receipts under `home.stateDir/receipts`,
the session ledger, the event stream, transcript text. Never assert on a
stub's canned reply here; that is a contract test.
