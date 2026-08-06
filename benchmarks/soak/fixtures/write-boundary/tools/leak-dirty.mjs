/**
 * The honest-failure violation. `out/preexisting.txt` is tracked and is left
 * dirty by the suite's setup, so its pre-step bytes exist nowhere but the tree
 * this overwrites. Rollback must report `rollback-incomplete` and leave the
 * tree exactly as this made it, rather than guess at content it never recorded.
 */
import { writeFileSync } from "node:fs";

writeFileSync("out/preexisting.txt", "overwritten by the step\n");
process.stdout.write("leak-dirty: overwrote out/preexisting.txt\n");
