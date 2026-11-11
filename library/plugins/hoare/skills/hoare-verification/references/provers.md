# Mechanizing obligations through declared checks

An obligation is `mechanized` only when a prover check ran through `verify` in this
run and proved it on the real source. The check must be declared in the project's
`.clio-coder/verifiers.yaml`. A reviewer never runs a prover through a shell
command, and never invents a check the project has not declared. When a useful
check is missing, propose the catalog entry in the report and leave committing it
to the operator.

## What each tool can establish

| Tool | Language | Proves on the real source | Can refute | Status it supports |
| --- | --- | --- | --- | --- |
| Frama-C/WP (with `-wp-rte`) | C | yes, ACSL contracts and UB goals | through failed goals, with no concrete input | `mechanized`; a failed goal stays `unknown` until a counterexample is traced |
| CBMC with `--unwinding-assertions` | C | yes, within loop bounds the unwinding assertions show are sufficient | yes, with a trace | `mechanized` when the unwinding assertions pass; otherwise refutation only |
| Kani, Prusti, Creusot, Verus | Rust | depends on the tool | yes | as for the tools above |
| Nagini | Python subset | yes, within its supported subset | through failed goals | `mechanized` |
| CrossHair, Hypothesis | Python | no | yes, with an input | `refuted` only |
| Dafny, Why3 | a translation | the model only | the model only | `modeled`, with gaps listed |
| `-fcheck=all`, sanitizers, tests | any | no | yes, with an input | `refuted` only |

A failed prover goal is not a counterexample. Provers fail for lack of a lemma or
time, so trace a concrete input before reporting `refuted`.

## Declaring a prover check

Catalog commands are exact argv arrays. Shell executables are rejected, so a check
that needs output parsing invokes a script. Every required field must be present:

```yaml
version: 2
checks:
  - id: wp:max-array
    description: Frama-C WP proves every ACSL and RTE goal in src/max_array.c
    command: [python3, tools/wp_all_proved.py, src/max_array.c]
    cwd: .
    timeoutMs: 300000
    tags: [formal, frama-c]
  - id: cbmc:max-array
    description: CBMC checks max_array for bounds, pointer and overflow errors with sufficient unwinding
    command: [cbmc, src/max_array.c, --function, max_array, --bounds-check, --pointer-check, --signed-overflow-check, --unwind, "65", --unwinding-assertions]
    cwd: .
    timeoutMs: 300000
    tags: [formal, cbmc]
  - id: dafny:sum-model
    description: Dafny verifies the translated model of sum_array
    command: [dafny, verify, proofs/sum_array.dfy]
    cwd: .
    timeoutMs: 300000
    tags: [formal, dafny, model]
```

Frama-C's exit status does not by itself say every goal was proved, so the first
check uses a wrapper that fails unless all goals are proved:

```python
#!/usr/bin/env python3
"""Run Frama-C WP on one file and exit non-zero unless every goal is proved."""
import re, subprocess, sys

run = subprocess.run(["frama-c", "-wp", "-wp-rte", sys.argv[1]], capture_output=True, text=True)
sys.stdout.write(run.stdout)
sys.stderr.write(run.stderr)
match = re.search(r"Proved goals:\s*(\d+)\s*/\s*(\d+)", run.stdout)
if run.returncode != 0 or match is None or match.group(1) != match.group(2):
    sys.exit(1)
```

Confirm the summary line's format against the installed Frama-C version. CBMC exits
non-zero when a property fails, and `dafny verify` exits non-zero on a verification
error.

## Making the proof a completion requirement

A project can require the prover check for the files it covers through its quality
policy. Clio then reports the requirement as `passed`, `missing`, `failed` or
`stale` at the end of each turn that changes those files:

```yaml
version: 1
rules:
  - id: formal-core
    paths: ["src/max_array.c"]
    inputs: ["src/max_array.c", "tools/wp_all_proved.py"]
    checks: ["wp:max-array"]
    allowLimitations: false
```

Running a prover runs repository tooling. The session's code-execution consent
applies to it like any other `verify` check, and a quality policy grants no
execution approval of its own.
