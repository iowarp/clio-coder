# Fixture: single-file bug

One defect, one file, one known answer. `rollingMean` in `src/window.mjs` drops
the final complete window: the loop bound is `start < values.length - size`
where a complete window ends at `start === values.length - size`. Six samples
with window three return three means instead of four.

`node test/known-answers.test.mjs` is red before the fix and green after it,
runs offline in milliseconds, and depends on nothing but the Node binary
already running the soak.

The suite seeds this copy as a git repository before the run, so `patch.*`
measures what the model actually touched. A repair that edits the test instead
of the defect shows up as `patch.testFilesModified`, which is why the test
lives under `test/` rather than beside the source.

The soak does not gate on whether the defect was repaired. That is a
measurement reported beside the invariant readings; whether Clio sealed a
receipt, authenticated it, and agreed with its own exit status is the gate.
