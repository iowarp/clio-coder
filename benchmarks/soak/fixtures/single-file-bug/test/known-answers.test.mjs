/**
 * Known-answer test for the fixture defect. Runs offline in milliseconds with
 * no dependency beyond the Node binary already running the soak.
 *
 * Red before the fix, green after it. Nothing in the soak gates on the colour:
 * this measures whether the model solved the task, which is reported beside
 * the invariant readings rather than folded into them.
 */

import { strict as assert } from "node:assert";
import { rollingMean } from "../src/window.mjs";

// Six samples, window three: four complete windows.
assert.deepEqual(rollingMean([1, 2, 3, 4, 5, 6], 3), [2, 3, 4, 5]);
// The last complete window is the final one; a window equal to the series
// length yields exactly one mean.
assert.deepEqual(rollingMean([2, 4, 6], 3), [4]);
// Shorter than the window: nothing is complete.
assert.deepEqual(rollingMean([1, 2], 3), []);
// A window of one is the series itself.
assert.deepEqual(rollingMean([5, 7], 1), [5, 7]);

process.stdout.write("rolling-window: 4 known answers ok\n");
