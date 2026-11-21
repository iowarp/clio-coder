You can start a task and leave. Headless `clio-coder run` does one turn with nobody attached, and the limits you set are enforced. This guide covers a bounded headless run, a read-only one, the timeouts that apply when you walk away from an open session, and scheduled turns.

::: note Version scope
This guide describes v0.8.5. A headless run has no one to ask: it denies whatever the safety judge does not allow, and `ask_user` is not available.
:::

::: needs
- CLIO Coder installed, with a connected model.
- A Git repository, and a task you can state completely in one prompt.
:::

::: steps
### Put your decisions in the prompt

The judge reads only your prompt in a headless run, so name the actions the job needs:

```sh
clio-coder run --max-cost-usd 2 --timeout 30m \
  "Fix the failing parser test, run the test check, and commit on this branch. Do not push."
```

`--max-cost-usd` caps the priced spend this run adds. Reaching it stops the run and its workers with exit 4. Calls already in flight can pass the cap, and unpriced routes cannot be bounded, so pair it with `--timeout`, which exits 124 on expiry. The session ceiling, 5 USD by default, still applies.

`--require-priced` refuses a run that could reach a route with no price. `--max-requests <n>` and `--max-tool-calls <n>` cap the main agent's model requests and tool calls, and each exits 4 when reached. `--dry-run` prints the route, tools, and limits the run would use, then exits 0 without calling a model.

### Ask a question that cannot change anything

```sh
clio-coder run --read-only "Which modules have no tests? Report paths."
```

`--read-only` is an enforced ceiling on the main agent, not a request. No file outside CLIO Coder's home changes: writes are refused, and shell commands run only in a read-only sandbox.

### Stream it to another program

```sh
clio-coder run --output-format stream-json "Summarize the last five commits."
```

The stream opens with a `session` frame carrying its schema version and ends with one `run_end` frame. That frame holds the answer in `result.text`, the `exitCode`, the `outcome`, and the `causes` that ended the run. Read the result from it.

When you want only the result, `--output-format json` prints that `run_end` document alone, and `-o answer.txt` also saves the answer to a file when the run exits 0. `run --json` was removed; use `--output-format stream-json`.

Continue later with `--continue` or `--resume <id>`. Add `--fork` to branch a new session and leave the original as it was.

### Walk away from an open session

In the terminal, an unanswered approval card is denied after `safety.unattendedAfterSeconds` (300 by default) and the turn continues. A question takes its recommended option. Any key stops the countdown. When you return, `/decisions` shows what was chosen, and the exit summary counts it on an `Unattended` line.

### Schedule turns while idle

```text
/loop 30m Check the nightly build log and report anything new.
/loop 5m --command make check
/loop
```

A bare `/loop` lists the jobs. A loop runs only while its conversation is idle and never replays missed runs. The `--command` form polls a program directly, with no shell.
:::

::: result What you should see
A finished turn with its exit code, not a parked prompt. An exit of 4 means a limit such as the cost ceiling stopped it. `clio-coder telemetry why-stopped <session>` explains a stop afterward.
:::

## Read how a run ended

Stderr names the session and prints an `observed:` line that counts tool calls, refusals, writes, and checks, plus a one-line summary of the outcome, requests, tokens, and cost. A script should read the exit code or the `run_end` frame, not the prose answer.

When `--max-cost-usd` meets a route with no price, stderr says the cap cannot bound it; declare `targets[].pricing` to fix that.

In a separate run of the first step, made for this guide apart from the session at the top of the page, Claude Haiku 5.5 on the `anthropic-max` route worked on a repository with one failing parser test. It split each line at the first `=`, ran the test check, committed on the branch, and pushed nothing.

That route carries a price estimate, so `--max-cost-usd` could bound it and stderr printed no unpriced-route notice. Stderr read:

```text
clio-coder run: session n5iuvnc76u7o
clio-coder run: observed: 8 tool calls, 0 refused · 1 write · checks passed: npm run test, git status
```

On a route with no price, such as a gateway target without `targets[].pricing`, the same command first prints `clio-coder run: --max-cost-usd does not bound unpriced routes: <target>/<model>; declare targets[].pricing to bound them`.

The `run_end` frame of the third step has this shape. `causes` is empty on success and lists every reason, most important first, when the run failed or was stopped:

```json
{"type":"run_end","schemaVersion":2,"mode":"main","sessionId":"<id>","exitCode":0,"outcome":"succeeded","causes":[],"result":{"text":"<answer>","artifacts":[]}}
```

The real frame carries more fields, such as usage, timings, and tool counts. `clio-coder schema run-result` prints the full JSON Schema.

::: compare
| Exit | What it means |
| --- | --- |
| `0` | The run settled and succeeded |
| `1` | It failed: the model was unreachable, a worker did not deliver, or a refused call left the task undone. `--fail-on-verify` adds a failed `--verify` check |
| `2` | A usage error, including `--autonomy yolo` as root outside a container |
| `3` | At `yolo`, the safety judge blocked too many calls in a row; review the run, then `--continue`. Also `--on-permission fail` at the first request nobody could approve |
| `4` | A cost ceiling, `--max-requests`, `--max-tool-calls`, or at `yolo` an autonomous cap on tool calls, minutes, or tokens, stopped it; `--continue` resumes |
| `124` | `--timeout` expired; the run still settled and sealed |
| `130`, `143` | Ctrl+C or a SIGTERM stopped it |
:::

## Pick the right tool

::: compare
| When you want | Use | What still stops it |
| --- | --- | --- |
| One bounded task | `clio-coder run` at `default` | Judge, sandbox, cost ceiling, timeout |
| A long job you leave running | `clio-coder run --autonomy yolo` | Contained by default: the sandbox and judge stay on, and a call the judge does not allow is refused back to the run. Ceilings, timeout, the loop guard, and the tool budget also stop it |
| A recurring check | `/loop` in an open session | Pause or stop it; needs the session to stay open |
:::

::: limits Boundaries
- A contained command starts without credential variables and cannot open secret files, so name tools that need them. CLIO Coder may rerun with `unsandboxed: true`, which the judge reviews. At unconfined `yolo` under `safety.sandbox: required`, that retry is refused.
- `yolo` does not carry over from `settings.yaml` to a headless run. It comes only from that run's own `--autonomy yolo`, and it exits 2 as root outside a detected container.
:::

::: next
- [Let CLIO Coder work without watching every call](/tutorials/let-it-work-with-containment-and-rewind.html)
- [Report a problem without leaking your machine](/tutorials/report-a-problem-without-leaking-your-machine.html)
- [Commands and shortcuts](/docs/guide/commands-and-modes.html)
:::
