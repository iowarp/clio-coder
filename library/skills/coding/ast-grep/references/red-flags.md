# ast-grep Red Flags

- Scanning the codebase with a rule never proven on an example.
- A `has`/`inside` without `stopBy: end`.
- A guessed `kind` name instead of a `--debug-query=cst` dump.
- Any rewrite flag: this skill only reads.
- Treating shadow-utils `sg` as ast-grep because `command -v sg` succeeded.
- Cleaning up with `rm -rf`, or writing fixtures under `/tmp`; both are
  refused in a headless run.
- Falling back to grep halfway because rule debugging felt slow; fix the
  rule with Step 4, that is the job.
