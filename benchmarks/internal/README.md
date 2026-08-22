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

## What a run is given

The scratch home holds one target and one credential entry: the one the
target's auth resolves to (`oauthProfile`, else `apiKeyRef`, else the
runtime's OAuth provider id, else the runtime id). Every other profile the
operator has stays home. A stored `!command` reference is resolved once by
the driver, so the run is handed the value and never executes the command.

The child environment is built from scratch rather than inherited: process
plumbing (`PATH`, `HOME`, `XDG_*`, locale, proxy, TLS), the home's own
`CLIO_CODER_*` variables and `TMPDIR`, and only the credential variables this
target's resolver would consult. `--pass-env NAME` adds one more. An ambient
`OPENAI_API_KEY` does not reach a run against a local target. `NODE_OPTIONS`
is deliberately not passed: it can preload code into the child.

`HOME` and the `XDG_*` roots are passed through, so the child does see the
operator's dotfiles (git config, node-pty, a delegated agent's own login).
What it cannot see is the operator's Clio state: every Clio root is forced
under the scratch home and `CLIO_CODER_REQUIRE_HOME_PREFIX` makes any escape
fatal.

Anything a driver writes for you to read afterwards goes through
`home.redact()` first: env values it handed over, the stored key and its
resolved value, OAuth tokens, inline header values, and a proxy URL that
carries a password. Selector variables like `AWS_PROFILE` or `AWS_REGION` are
passed through but not redacted, because blanking `default` or `us-east-1`
everywhere would corrupt the transcript you are reading.

## Leases and cleanup

Every scratch home carries `lease.json` and is named `clio-live-*`. Cleanup
is armed before the driver's body runs, so a failed check, a thrown setup, a
`SIGINT`, or a PTY child that will not die all still remove the credentials.
A tree whose secrets cannot be removed is deleted rather than retained.

The one tree that keeps its credentials on purpose is `live:home`, because
the pane it is for has not started yet. Its lease (default 12h, `--lease
90m|8h|2d`) bounds that: the launcher refuses to start once it has expired,
the next driver to start sweeps expired homes out of the temp root, and
`live:home --release <dir>` removes one now. Release it yourself; do not
leave it to the sweep.

Before any recursive delete, a candidate must be named `clio-live-*`, be a
real directory and not a symlink, hold a readable `lease.json`, and either
sit directly in this process's `os.tmpdir()` or be the home that `TMPDIR`
already points into. The second form is what makes `--release` work from a
shell running inside the home. Nothing inside the candidate votes: a lease
that names its own parent is refused, because the file is written by whoever
owns the tree it would authorize deleting.

Limits worth knowing. Killing a run's process tree is a POSIX process group:
on Windows only the direct child is signalled and its descendants are not
reached. A descendant that starts its own session (the bash tool, dispatch
workers) leaves the group and is reached only through the CLI's own SIGTERM
handler inside the grace window. And a driver killed with `SIGKILL` runs no
cleanup at all: its children survive until their own timeouts and its tree
until the next driver's lease sweep.

## Entry points

| Command | Drives | Proves |
| --- | --- | --- |
| `npm run live:smoke -- --target <id> [--delegation]` | headless `run` | The target answers through Clio's provider path end to end: `--version`, `doctor --fix` on an empty home, one turn with a known reply. `--delegation` adds the opencode and copilot ACP agents. |
| `npm run live:recon -- --target <id> [--max-cost-usd 0.50]` | `eval run --suite` | Two model behaviors: a stale codewiki is not answered from alone (`wiki.staleAcknowledged`), and an "orient me" request dispatches Scout (`dispatch.scoutCount >= 1`). Suite, metrics, per-item isolation, and cost ceiling are the eval runner's own. |
| `npm run live:fleet-dispatch -- --target <id> [--thinking medium]` | headless `run --json` | The model-authored fleet lifecycle: one synchronous Scout, 1–6 parent spot-checks, one detached Debugger with a real briefing, one guide steer, monitor/wait/collect in order, truthful receipt labels, and a workspace that did not change. Read from the JSONL stream and the scratch home's receipts, `runs.json`, and `batches.json`. |
| `npm run live:tui -- --target <id> --workspace <dir> --send "<text>"...` | the TUI in a real PTY | What a person sees: prompts settle off the session ledger, slash commands open their overlays, `/quit` exits 0, and the terminal is handed back. Writes `transcript.txt`, `raw.txt`, `ledger.jsonl`, and `report.json`. |
| `npm run -s live:home -- --target <id>` | nothing; prints a path | A scratch home holding only that target, plus `<dir>/clio`, a launcher that starts the built binary with the run's environment and nothing else from your shell. For a tmux or herdr pane (`SKILL.md`). Keeps its credentials until `--release <dir>` or its lease expires. |
| `clio-coder eval run --suite benchmarks/soak/clio-soak.yaml --target <id> --model <wireId> --clio-coder-entry dist/cli/index.js` | the eval runner | Machinery under load: receipts sealed and authenticating, outcome matching exit status, no orphaned children, usage counted once. The soak suites are under `../soak/`. |

Every driver takes `--help`. Exit codes: 0 pass, 1 a check failed, 2 usage.
Shared flags: `--target`, `--model`, `--thinking`, `--keep`, `--pass-env
<NAME>` (repeatable), `--lease <90m|8h|2d>`.

## Files

```text
live-target.ts         --target resolution, scratch home, credential scoping, env filtering, leases, spawn, redaction
live-smoke.ts          one headless turn (+ ACP delegation)
live-recon.ts          stale-wiki and Scout-routing eval suite
live-fleet-dispatch.ts the fleet lifecycle regression
live-home.ts           scratch home + launcher for an interactive pane; --release
pty-drive.ts           scripted TUI drive in a pseudo-terminal
SKILL.md               how an agent (Claude Code, Codex, Gemini, Clio) drives the real Clio
inventory.md           every way Clio is exercised, with a keep/merge/delete decision each
```

The offline contracts for all of the above are
`tests/contracts/live-home.test.ts` (credential scoping, environment
filtering, redaction, cleanup, leases, the launcher),
`tests/contracts/live-spawn.test.ts` (process-tree termination and
`replaceEnv`), and `tests/contracts/live-fleet-dispatch.test.ts` (partial
capture on timeout, the workspace snapshot). They run under `npm test` and
call no model.

The pseudo-terminal itself is `tests/harness/pty.ts` (`openPty`, `runInPty`,
`stripAnsi`, `visibleLines`, `colorSequences`). It is the one PTY
implementation in the repository; the CI smoke suites and `pty-drive.ts` are
both consumers of it. New drivers import it rather than adding another.

## Writing a new driver

Start from `live-smoke.ts`. `parseLiveArgs` handles the shared flags and hands
back the rest; `withLiveHome(args, options, body)` gives your body the scratch
home with the chosen target and arms the cleanup before the body's first line,
so use it rather than calling `prepareLiveHome` and remembering a `finally`;
`clio(home, args)` runs the binary inside it; `runDriver` turns a thrown
`LiveUsageError` into exit 2 and a `false` return into exit 1. Put anything
you generate for the run under `home.dir` so the same cleanup owns it, and
send anything you print through `home.redact()`. Assert on
observable outcomes: files written, receipts under `home.stateDir/receipts`,
the session ledger, the event stream, transcript text. Never assert on a
stub's canned reply here; that is a contract test.
