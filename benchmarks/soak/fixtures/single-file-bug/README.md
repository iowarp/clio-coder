# Fixture: single-file bug

One defect, one file, one known answer. `rollingMean` in `src/window.mjs` drops
the final complete window: the loop bound is `start < values.length - size`
where a complete window ends at `start === values.length - size`. Six samples
with window three return three means instead of four.

`node test.mjs` is red before the fix and green after it, runs offline in
milliseconds, and depends on nothing but the Node binary already running the
soak.

The soak does not gate on that colour. Whether the model repaired the defect is
a measurement reported beside the invariant readings; whether Clio sealed a
receipt, authenticated it, and agreed with its own exit status is the gate.
