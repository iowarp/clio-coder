/**
 * Workspace state after enforcement, checked structurally.
 *
 * The metrics read the sealed verdict; this reads the tree the verdict claims
 * to describe. A verdict that says `rolled-back` beside a file that is still
 * there is the failure this catches, and no assertion here depends on anything
 * a model wrote.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";

const mode = process.argv[2];

if (mode === "rolled-back") {
	assert.equal(existsSync("out/leak.txt"), false, "a rolled-back violation leaves nothing behind");
} else if (mode === "rollback-incomplete") {
	assert.equal(existsSync("out/preexisting.txt"), true, "an incomplete rollback leaves the tree as the step made it");
	assert.equal(
		readFileSync("out/preexisting.txt", "utf8"),
		"overwritten by the step\n",
		"the tree is left exactly as the step made it, never guessed back",
	);
} else {
	throw new Error(`unknown mode: ${mode}`);
}

process.stdout.write(`write-boundary: ${mode} workspace state ok\n`);
