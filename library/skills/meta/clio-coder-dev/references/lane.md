# Lane handback

Use the brief's own format when it gives one. Otherwise end your final reply,
and the report file when the brief names one, with this block. One fact per
line so a manager can parse it.

    ## HANDBACK
    lane: <name>
    spec: <id or issue>
    state: READY | BLOCKED | PARTIAL
    base: <sha the lane was cut from>
    head: <full sha of the last landable commit>
    commits: <count above base>
    changed: <repo paths, comma separated>
    check: typecheck pass
    check: lint pass
    check: test:file tests/contracts/x.test.ts pass (12 pass, 0 fail, 0 skipped) node 24
    check: openapi regenerated | not needed
    live: <surface> | <command> | <what you observed>
    not-run: <check> | <reason>
    limits: <known limits, or none>
    changelog: <one proposed line>
    docs-later: <page: what changes, or none>
    question: <id and one line, or none>

Rules:
- `state: READY` needs every acceptance criterion mapped to a `check:` or
  `live:` line. A criterion with neither makes the state PARTIAL.
- A check that was skipped, timed out or could not start is `not-run`, never
  `pass`. A test run that reports skipped tests is not a pass.
- `head` is the last commit that is ready. Never leave unready commits below it.
- BLOCKED names the one decision or resource you need and what you did while
  waiting.
- Questions go where the brief says, numbered, each with options and your
  default. Continue on the default; do not wait idle.
- Report failures as they are. Do not call a red test pre-existing until you
  ran it on the base commit.
