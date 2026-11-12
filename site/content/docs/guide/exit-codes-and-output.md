# Automate with clio-coder run

Run one task from a script or CI job, read its exit code, and parse its JSON output.

## Run one task from a script

`clio-coder run` does one task without opening the terminal interface, then exits. The answer goes to stdout; progress, warnings and errors go to stderr, so a script can capture the answer alone.

```sh
clio-coder run --timeout 900 --max-cost-usd 2 "Run the test check and fix the failing parser test."
echo "exit $?"
```

Nobody is there to approve anything, so a request that would ask you is denied, and CLIO Coder continues another way or reports what it could not do. Name the actions the job needs in the prompt, such as "commit the fix", because the safety judge decides from your words.

## Read the exit code

| Code | Meaning |
| --- | --- |
| `0` | The run finished. |
| `1` | The task failed, including a run that changed nothing because its actions were refused. |
| `2` | A usage error: an unknown flag, target or agent, or a refused admission or capability request. |
| `3` | A worker was stopped by permission refusals, or the safety judge kept blocking. |
| `4` | A spend ceiling stopped the run. |
| `124` | `--timeout` ran out. |
| `129`, `130`, `143` | A signal stopped the run (SIGHUP, SIGINT, SIGTERM). |

The full guide lists the codes other commands use.

## Bound the run

- `--timeout <seconds>` stops the run and exits 124.
- `--max-cost-usd <n>` caps what the run may spend on priced models.
- `--read-only` leaves every file outside CLIO Coder's own folders unchanged.
- `--autonomy yolo` lets an unattended job continue without waiting. It stays contained by default, and a call that would ask you is refused back to CLIO Coder, which continues without it.

## Read structured output

`--json` writes one JSON event per line on stdout: the session, the model's text, each tool call and the end of the turn. `--json-events terminal` keeps only the session header and the final result with its answer and exit code. Dispatch on each frame's `type` and ignore kinds you do not know, because new ones are added.

`clio-coder doctor --json`, `clio-coder targets --json`, `clio-coder models --json` and other commands print one JSON document for scripts as well.
