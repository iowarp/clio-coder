/**
 * Known-answer test for the two fixture defects. Runs offline in milliseconds
 * with no dependency beyond the Node binary already running the soak.
 *
 * Red before both fixes, green after them. Nothing in the soak gates on the
 * colour: this measures whether the model solved the task, which is reported
 * beside the invariant readings rather than folded into them.
 *
 * It lives under `test/` so a repair that edits the test instead of the defect
 * shows up as `patch.testFilesModified`.
 */

import { strict as assert } from "node:assert";
import { coerceField } from "../src/coerce.mjs";
import { parseCsv } from "../src/parse.mjs";
import { tokenizeLine } from "../src/tokenize.mjs";

// Defect 1: a doubled quote inside a quoted field is one literal quote.
assert.deepEqual(tokenizeLine('"a""b",c'), ['a"b', "c"]);
// A comma inside a quoted field is data, not a separator.
assert.deepEqual(tokenizeLine('"x,y",z'), ["x,y", "z"]);
// An unquoted line is unaffected.
assert.deepEqual(tokenizeLine("p,q,r"), ["p", "q", "r"]);

// Defect 2: only the CSV's own numeric syntax is a number.
assert.equal(coerceField("42"), 42);
assert.equal(coerceField("-3.5"), -3.5);
assert.equal(coerceField(""), null);
assert.equal(coerceField("0x10"), "0x10", "hexadecimal is not CSV numeric syntax");
assert.equal(coerceField(" 1 "), " 1 ", "surrounding whitespace is data, not a number");
assert.equal(coerceField("1e3"), "1e3", "exponent form is not CSV numeric syntax");
assert.equal(coerceField("Infinity"), "Infinity");

// Both defects together, through the composing module.
assert.deepEqual(parseCsv('"a""b",42,\nx,0x10, 1 \n'), [
	['a"b', 42, null],
	["x", "0x10", " 1 "],
]);

process.stdout.write("csv-parse: 11 known answers ok\n");
