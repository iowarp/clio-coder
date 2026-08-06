# Fixture: multi-file bug

Two defects, two files, one known answer. A repair that reads only the file the
failure names cannot make this green.

`src/tokenize.mjs` consumes a closing quote but never recognises the doubled
quote escape, so `"a""b"` tokenizes as `ab` instead of the single field `a"b`.
`src/coerce.mjs` decides what a number is with `Number(field)`, which accepts
whitespace, hexadecimal, and exponent forms that are not the CSV's numeric
syntax, so `0x10` enters the parsed rows as 16 and ` 1 ` as 1. Both are values
the file did not contain.

`src/parse.mjs` composes the two and is correct as written. It is there so the
defect is genuinely spread across the modules a repair has to reach rather than
sitting in the one file a reader opens first.

`node test/known-answers.test.mjs` is red until both are fixed and green after,
runs offline in milliseconds, and depends on nothing but the Node binary
already running the soak. The test lives under `test/` so a repair that edits
the test instead of the defects shows up as `patch.testFilesModified`, and
`patch.filesChanged` distinguishes a repair that reached both modules from one
that reached only the first.

The soak does not gate on whether the defects were repaired. That is a
measurement reported beside the invariant readings; whether Clio sealed a
receipt, authenticated it, and agreed with its own exit status is the gate.

No new invariant family is needed here. This fixture runs the same two surfaces
`single-file-bug` runs, against a workload one file cannot answer.
