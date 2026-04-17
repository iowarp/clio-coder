# Interactive test walkthrough

A hand-run script for verifying an end-to-end Clio install. Paste each block
into a terminal, read the expected output, and confirm the reported values match.

## 1. Prerequisites

- Node >= 20 (check with `node --version`).
- A clean working tree on `main`. `git status` should be empty and
  `git rev-parse --abbrev-ref HEAD` should print `main`.

## 2. First-time install check

```bash
npm install
npm run build
node dist/cli/index.js --version
node dist/cli/index.js install
node dist/cli/index.js doctor
```

What each command does:

- `npm install` pulls pi-mono (pinned to 0.67.4), TypeBox, chalk, yaml,
  undici, and the dev toolchain.
- `npm run build` bundles `src/cli/index.ts` into `dist/cli/index.js` via tsup.
- `node dist/cli/index.js --version` prints the package version from
  `package.json`.
- `node dist/cli/index.js install` creates `~/.clio/` and writes a default
  `~/.clio/settings.yaml` if neither exists. It is idempotent.
- `node dist/cli/index.js doctor` reports XDG paths, package version, pi-mono
  version, Node version, and any missing runtime binaries.

## 3. Faux headless dispatch

```bash
node dist/cli/index.js run scout "hello" --faux
```

The `--faux` flag routes the dispatch through the faux provider, so no API
keys are consumed. Expected stdout is an NDJSON event stream that starts with
`message_start`, contains one or more `assistant_text` records, ends with
`message_end`, and finishes with a single-line `receipt` JSON record. The
receipt carries `runId`, `exitCode: 0`, `provider: "faux"`,
`model: "faux-1"`, and token counts. Process exit code is 0.

## 4. Interactive TUI smoke (requires a real TTY)

```bash
node dist/cli/index.js
```

The scaffold renders three panels:

- A banner row showing `Clio — IOWarp orchestrator`.
- An editor row in the middle of the screen.
- A footer row with the current mode and safety indicators.

Run the following steps in order inside the TUI:

1. Press `Shift+Tab` and watch the footer: the mode indicator cycles default
   ⇄ advise.
2. Type `/help` and press Enter. The help overlay prints the available
   commands.
3. Type `/run scout hello` and press Enter. A faux dispatch runs and its event
   stream scrolls inline. A receipt line prints at the end.
4. Type `/quit` and press Enter. The four-phase shutdown coordinator drains
   runs, closes the session, tears down domains, and exits cleanly.

## 5. Stress test

```bash
npm run stress
```

This spawns ten concurrent `clio run scout --faux` subprocesses. It asserts
that all ten produce valid receipts and that all ten merge into the shared
`~/.clio/state/runs.json` ledger. Ledger merges happen under an O_EXCL
lockfile with bounded retry and stale-lock sweep; `src/domains/dispatch/state.ts`
owns that primitive. Expected final line of output is `[stress] PASS`.

## 6. Real-provider path (optional, costs API tokens)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli/index.js run scout "say hello" \
  --provider anthropic --model claude-sonnet-4-6
```

**Warning: this dispatches against the real Anthropic API and bills your
account.** Use it sparingly. When the run completes, the receipt includes
session tokens (in and out), the pricing lookup, and the resulting USD cost.

## 7. Audit trail inspection

```bash
tail -n 20 ~/.clio/audit/$(date -I).jsonl | jq .
```

The audit log is one NDJSON record per classified action. Each record carries
`correlationId`, `runId`, `actionClass`, `mode`, `safety`, `verdict`, `reason`,
and `argsRedacted`. Blocked actions and allowed actions both land here.

## 8. Session artifacts

After any dispatch run, inspect the XDG state directories:

```bash
ls ~/.clio/sessions/
ls ~/.clio/state/
ls ~/.clio/receipts/
```

What each directory holds:

- `sessions/<cwdHash>/<id>/current.jsonl` is the append-only session
  transcript, tree-structured by `id` and `parentId`.
- `state/runs.json` is the run ledger, updated under the O_EXCL lockfile
  described in step 5.
- `receipts/<runId>.json` is the per-run reproducibility manifest; it carries
  the compiled-prompt hash and the environment manifest so a run can be
  re-validated later.

## 9. CI verification

```bash
npm run ci
```

`ci` chains typecheck, lint, boundary check, prompt check, every `diag:*`
script that is required for green CI, the production build, and finally
`verify`. A warm cache completes in roughly 30 seconds. The final line printed
is `[verify] all checks passed` when everything is green.
