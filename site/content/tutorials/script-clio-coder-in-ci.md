A CI job needs three things from a coding agent: a result it can parse, an exit code it can branch on, and limits it can rely on. `clio-coder run` gives a script all three. This guide builds one job step by step, then puts it in a GitHub Actions workflow.

::: note Version scope
This guide describes v0.8.5. The output contract is schema version 2, and `clio-coder schema run-result` prints its JSON Schema for the version you have installed.
:::

::: needs
- CLIO Coder installed on the runner, with a model connection whose key comes from an environment variable.
- A repository with a test command.
- `jq`, to read the result.
:::

::: steps
### Preview the run without calling a model

`--dry-run` prints what the run would do and exits 0. It opens no session, calls no model, and runs no check.

```sh
clio-coder run --dry-run --output-format json \
  --max-cost-usd 2 --timeout 15m \
  --verify "npm test" \
  "Fix the failing parser test." | jq '.plan'
```

The plan names the route, the tools the agent may use, the sandbox mode, the limits, and the checks. Put this in a pull request job to catch a bad flag before anything is spent. Check that `.plan.route.target` is set.

### Ask for one result document

`--output-format json` prints one `run_end` document on stdout when the run is over. Progress and notices go to stderr, so stdout is the document alone.

```sh
clio-coder run --output-format json \
  --max-cost-usd 2 --timeout 15m \
  "Fix the failing parser test." > result.json
```

Use `--output-format stream-json` instead when another program should follow the run live. It prints one JSON event per line and ends with the same `run_end` document.

### Bound the run

Each limit is a flag, and each one stops the run with its own cause code.

```sh
clio-coder run --output-format json \
  --max-requests 40 --max-tool-calls 120 \
  --max-cost-usd 2 --require-priced \
  --timeout 15m --sandbox required \
  "Fix the failing parser test." > result.json
```

`--max-requests` and `--max-tool-calls` cap the main agent's model requests and tool calls. `--max-cost-usd` caps priced spend, and `--require-priced` refuses the run when a route it could reach has no price. `--sandbox required` refuses to start on a runner with no OS sandbox.

### Make the job fail when the work is not finished

By default a run that ends normally exits 0, whatever the agent says about its own work. Two flags turn an honest "not finished" into a failed job.

```sh
clio-coder run --output-format json \
  --verify "npm test" --fail-on-verify \
  --exit-code \
  "Fix the failing parser test." > result.json
```

`--verify` declares an acceptance check that CLIO Coder runs itself after the turn, and `--fail-on-verify` exits 1 when it fails. `--exit-code` exits 1 when the run was assessed as partly done or not done.

The agent declares how the turn ended, and CLIO Coder records that claim beside its own assessment. A claim of done that left unvalidated changes or a failing check is assessed as partly done, so `--exit-code` fails it.

### Get a structured answer

When the next step needs data instead of prose, pass a JSON Schema. The answer must be one JSON object that matches it, and CLIO Coder validates the object before the run exits 0.

```sh
cat > summary.schema.json <<'EOF'
{
  "type": "object",
  "required": ["fixed", "files"],
  "properties": {
    "fixed": { "type": "boolean" },
    "files": { "type": "array", "items": { "type": "string" } }
  }
}
EOF

clio-coder run --output-format json \
  --output-schema summary.schema.json \
  "Fix the failing parser test and report which files changed." \
  | jq '.result.structured'
```

A mismatch gets one repair turn with no tools. If the answer still does not match, the run exits 1 with cause `schema_mismatch`. The schema's root must be an object, and a schema CLIO Coder cannot enforce exits 2 before any model request.

### Read the result

Branch on the exit code first, then read the fields you need.

```sh
jq -r '.outcome' result.json            # succeeded, failed, canceled, timed_out
jq -r '.causes[].code' result.json      # why, most important first
jq -r '.result.text' result.json        # the answer
jq '.verify.checks' result.json         # each --verify check and whether it passed
jq '.usage.total' result.json           # tokens and cost
```

`causes` is empty on success. On a failure or a stop it lists every reason as a code, usually with a message. `-o answer.md` also writes the answer to a file when the run exits 0.
:::

::: result What you should see
One JSON document on stdout, an exit code that matches its `exitCode` field, and a `causes` list that names the reason whenever that code is not 0.
:::

## Exit codes a job can branch on

::: compare
| Exit | Meaning | Typical cause codes |
| --- | --- | --- |
| `0` | The run settled and succeeded | none |
| `1` | The run failed, or a flag you set turned an unfinished result into a failure | `verify_failed`, `schema_mismatch`, `context_overflow` |
| `2` | A usage or setup error, before any model request | `empty_task`, `schema_unsupported`, `session_live` |
| `3` | A request nobody could approve, with `--on-permission fail` | `permission_required` |
| `4` | A limit stopped the run | `max_requests`, `max_tool_calls`, `max_cost_usd` |
| `124` | `--timeout` expired | `deadline` |
:::

Retry on 124 or 4 only after you raise the limit, because the same run will stop at the same place. An exit of 2 is a mistake in the job itself, so fail fast and fix the command.

## A GitHub Actions job

This workflow installs CLIO Coder, connects a model from a repository secret, previews the run, then runs it with limits. The job fails when the run does not finish the work.

```yaml
name: agent-fix
on: workflow_dispatch

jobs:
  fix:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4

      - name: Install CLIO Coder
        run: |
          curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --no-gui
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Connect a model
        run: |
          clio-coder configure --id ci --runtime anthropic \
            --model <model> --api-key-env ANTHROPIC_API_KEY --set-orchestrator

      - name: Preview
        run: |
          clio-coder run --dry-run --output-format json \
            --verify "npm test" "Fix the failing parser test." | jq '.plan'

      - name: Run
        run: |
          clio-coder run --output-format json \
            --max-requests 40 --max-cost-usd 2 --timeout 15m \
            --verify "npm test" --fail-on-verify --exit-code \
            "Fix the failing parser test." > result.json

      - name: Report
        if: always()
        run: |
          jq -r '"outcome: \(.outcome)", "causes: \([.causes[].code] | join(", "))"' result.json
          jq -r '.result.text' result.json >> "$GITHUB_STEP_SUMMARY"
```

Replace `<model>` with a model id from `clio-coder models --target ci`. The key stays in the secret: `--api-key-env` names the variable, and CLIO Coder reads it when it calls the model. If the installer put the launcher somewhere else, `command -v clio-coder` after the install step shows where.

## Limits to know

A headless run has no one to ask. Requests that would need approval are denied, and the turn goes on without them unless you pass `--on-permission fail`.

`--max-cost-usd` bounds priced routes only. On a route with no price, stderr says the cap cannot bound it, and `--require-priced` turns that into a refusal.

Pass the task as an argument. `run` reads stdin only when you pass `-`, so a pipe into `run` without it is ignored.

## Next

[Run it unattended within limits](/tutorials/run-it-unattended-within-limits.html) covers read-only runs, yolo, and scheduled turns. The [exit codes and output guide](/docs/guide/exit-codes-and-output.html) lists every field and cause.
