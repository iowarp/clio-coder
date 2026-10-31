import assert from "node:assert/strict";
import { test } from "node:test";
import { staleBundle } from "../client/shell/stale-bundle-model.js";

test("a window whose bundle was built for another version than the server's is told to reload, and only then", () => {
	assert.deepEqual(staleBundle("0.6.6", "0.6.7"), {
		title: "This window runs Clio Coder 0.6.6, and the server runs 0.6.7.",
		detail: "Reload this window to use the version the server runs. It does not reload on its own.",
	});
	assert.equal(staleBundle("0.6.6", "0.6.6"), null);
	// A build that stamped no version, or a server not yet read, never prompts.
	assert.equal(staleBundle(null, "0.6.7"), null);
	assert.equal(staleBundle("0.6.6", undefined), null);
});
