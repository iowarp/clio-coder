/**
 * The deterministic violation. This is a declared code command, not a model
 * that had to be talked into misbehaving: the step declares `writes: ["src/"]`
 * and this writes `out/leak.txt`, so the violation happens on every run with no
 * dependence on what any model decided to do.
 *
 * It exits 0. The step must fail because of the boundary, not because the
 * command failed; a command that also failed would leave the two reasons
 * indistinguishable.
 */
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("out", { recursive: true });
writeFileSync("out/leak.txt", "written outside the declared boundary\n");
process.stdout.write("leak: wrote out/leak.txt\n");
