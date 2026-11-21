# Automate with clio-coder run

Run one task from a script or CI job, read its exit code, and parse its JSON output.

## Run one task from a script

`clio-coder run` does one task without opening the terminal interface, then exits. The answer goes to stdout; progress, warnings and errors go to stderr, so a script can capture the answer alone.

```sh
clio-coder run --timeout 15m --max-cost-usd 2 "Run the test check and fix the failing parser test."
echo "exit $?"
```

Nobody is there to approve anything, so a request that would ask you is denied, and CLIO Coder continues another way or reports what it could not do. Name the actions the job needs in the prompt, such as "commit the fix", because the safety judge decides from your words.

Stdin is read only when you pass `-`. `clio-coder run -` takes the task from stdin, and `clio-coder run "<task>" -` appends stdin after the task.

## Read the exit code

| Code | Meaning |
| --- | --- |
| `0` | The run finished. |
| `1` | The task failed, including a run that changed nothing because its actions were refused. With `--fail-on-verify`, a failed check also exits 1, and with `--exit-code`, so does a run the agent declared unfinished. |
| `2` | Nothing started: an unknown flag, target or agent, an empty task, a session open in another process, or a refused admission or capability request. |
| `3` | A worker was stopped by permission refusals, the safety judge kept blocking, or `--on-permission fail` met a request nobody could approve. |
| `4` | A limit stopped the run: a spend ceiling, `--max-requests`, `--max-tool-calls`, or a `yolo` run's autonomous tool-call, time, or token cap. |
| `5` | A `--answers` file did not script a question only the author may answer. |
| `124` | `--timeout` ran out. |
| `129`, `130`, `143` | A signal stopped the run (SIGHUP, SIGINT, SIGTERM). |

The full guide lists the codes other commands use.

## Bound the run

- `--timeout <duration>` stops the run and exits 124. It takes `90`, `90s`, `15m` or `2h`, and a bare number is seconds.
- `--max-cost-usd <n>` caps what the run may spend on priced models, and `--require-priced` refuses routes with no price.
- `--max-requests <n>` and `--max-tool-calls <n>` cap the main agent's model requests and tool calls.
- `--verify "<cmd>"` runs an acceptance check after the turn, and `--fail-on-verify` turns a failed check into exit 1.
- `--dry-run` prints what the run would do and exits 0 without calling a model.
- `--read-only` leaves every file outside CLIO Coder's own folders unchanged.
- `--answers <file.yaml>` answers the questions only the author may answer, such as extension interview steps; any other question is still refused.
- `--autonomy yolo` lets an unattended job continue without waiting. It stays contained by default, and a call that would ask you is refused back to CLIO Coder, which continues without it.

## Read structured output

`--output-format json` writes one JSON document on stdout: a `run_end` result with the answer in `result.text`, the `exitCode`, the `outcome`, the `causes` that ended the run, and usage. `-o <path>` also saves the final answer to a file when the run exits 0.

`--output-format stream-json` writes one JSON event per line: the session, the model's text and each tool call, then the same `run_end` result as the last line. Dispatch on each frame's `type` and ignore kinds you do not know, because new ones are added.

`run --json` and `run --json-events` were removed; use `--output-format json` or `--output-format stream-json`. `clio-coder schema run-result` prints the JSON Schema of the result, and `--output-schema <file.json>` makes the answer itself one JSON object checked against your schema.

Continue an earlier session with `--resume <id>` or `--continue`. Add `--fork` to branch a new session and leave the original untouched.

`clio-coder doctor --json`, `clio-coder targets --json`, `clio-coder models --json` and other commands print one JSON document for scripts as well.
