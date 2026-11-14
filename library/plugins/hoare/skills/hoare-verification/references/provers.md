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
| Frama-C/WP (with `-wp-rte`) | C | yes, ACSL contracts and generated runtime-error goals | not from failed goals alone | `mechanized`; a failed goal stays `unknown` until a counterexample is traced |
| CBMC with `--unwinding-assertions` | C | yes, within loop bounds the unwinding assertions show are sufficient | yes, with a trace | `mechanized` when the unwinding assertions pass; otherwise refutation only |
| Kani, Prusti, Creusot, Verus | Rust | depends on the tool | yes | as for the tools above |
| Nagini | Python subset | yes, within its supported subset | not from failed goals alone | `mechanized` |
| CrossHair, Hypothesis | Python | no | yes, with an input | `refuted` only |
| Dafny, Why3 | a translation | the model only | the model only | `modeled`, with gaps listed |
| `-fcheck=all`, sanitizers, tests | any | no | yes, with an input | `refuted` only |

A failed prover goal is not a counterexample. Provers fail for lack of a lemma or
time, so trace a concrete input before reporting `refuted`.

## Declaring a prover check

Catalog commands are exact argv arrays. Shell executables are rejected, so a check
that needs output parsing invokes a repository-owned script. Version 2 command
checks can declare `proof`: what successful execution attests, exact goal fields,
and every source, contract, wrapper or translation input. A goal's target source
must be among the inputs. For example (adapt the specification to the actual ACSL):

```yaml
version: 2
checks:
  - id: wp:max-array
    description: Frama-C WP proves every ACSL and RTE goal in src/max_array.c
    command: [python3, tools/wp_all_proved.py, src/max_array.c]
    cwd: .
    timeoutMs: 300000
    tags: [formal, frama-c]
    proof:
      status: mechanized
      inputs: [src/max_array.c, tools/wp_all_proved.py]
      goals:
        - id: max_array.post
          target: src/max_array.c:max_array
          kind: post
          pre: n > 0 and a[0..n-1] readable; no concurrent writes
          post: result is the maximum element of a[0..n-1]
          formula: pre implies post after max_array
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
summaries = re.findall(r"(?m)^\[wp\]\s+Proved goals:\s*(\d+)\s*/\s*(\d+)\s*$", run.stdout)
if run.returncode != 0 or len(summaries) != 1:
    sys.exit(1)
proved, total = map(int, summaries[0])
if total == 0 or proved != total:
    sys.exit(1)
```

This is a version-specific wrapper sketch, not a universal Frama-C adapter.
Confirm the summary format and expected property selection against the installed
version. Missing, ambiguous, zero-goal, partial or timed-out results must fail.
Pin the prover version/build flags in project policy. CLIO trusts the wrapper's
attestation; it does not inspect certificates or prove that a declaration covers
all required goals. A wrapper that lies can invalidate the result.

CBMC can use a declared source-proof check only with appropriate assertions,
runtime checks and successful unwinding assertions; a successful bounded search
alone is insufficient. Dafny/Why3 translations use `status: modeled` and list
the original source, translation and wrapper as inputs, with semantic gaps in
evidence. CrossHair/Hypothesis can use `status: refuted` only through a wrapper
that exits zero on a confirmed counterexample and prints its input/trace. A normal
test failure or prover nonzero exit yields no proof record and stays `unknown`.
Fortran has no general source prover in this pack; use explicitly limited models
or argued review. Runtime checks can refute, not prove, the source.

Inputs are regular, repository-relative files, without symlink components:
1..64 inputs, at most 1 MiB per file and 16 MiB combined including the catalog.
The catalog itself is always fingerprinted. Fingerprints must agree before,
after and at report validation. Include transitive includes/imports yourself;
CLIO does not discover them or pin the installed toolchain.

Annotated proof checks always run with read-only workspace and network disabled,
even from the main session. An isolated scratch directory/private temporary
filesystem is writable. Unsupported or unavailable containment, missing tools,
timeouts, incomplete output and changed inputs yield errors, never proof.
Hoare workers require native execution and the same restrictive command policy.
No prover or dependency is installed automatically.

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
