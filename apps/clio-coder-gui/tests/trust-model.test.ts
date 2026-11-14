import assert from "node:assert/strict";
import { test } from "node:test";
import {
	afterTrust,
	ignoredSurfaces,
	printable,
	sizeNote,
	TRUST_APPLY_LATER,
	TRUST_NOTHING_READABLE,
	TRUST_RESTARTING,
	TRUST_WAIT_FOR_TURN,
	trustAvailability,
} from "../client/chat/trust-model.js";
import type { TrustPreview } from "../contracts/review.js";

const preview = (patch: Partial<TrustPreview> = {}): TrustPreview => ({
	workspaceRoot: "/work/demo",
	surface: "settings",
	files: [{ path: "/work/demo/.clio-coder/settings.yaml", text: "version: 1\n", hash: "a".repeat(64) }],
	contentHash: "b".repeat(64),
	verdict: "untrusted",
	...patch,
});

test("Trust waits for the running turn and needs a readable file", () => {
	assert.deepEqual(trustAvailability(preview(), false), { enabled: true, note: null });
	assert.deepEqual(trustAvailability(preview(), true), { enabled: false, note: TRUST_WAIT_FOR_TURN });
	const unreadable = preview({
		files: [{ path: "/work/demo/.clio-coder/settings.yaml", text: null, hash: null, error: "EACCES" }],
		contentHash: null,
	});
	assert.deepEqual(trustAvailability(unreadable, false), { enabled: false, note: TRUST_NOTHING_READABLE });
	assert.equal(trustAvailability(undefined, false).enabled, false);
});

test("project text is shown inert and a cut file names its size", () => {
	assert.equal(printable("a\tb\r\nc\u001b[31m\u202ed\u0085"), "a\tb\nc\\u001b[31m\\u202ed\\u0085");
	assert.equal(sizeNote(preview().files[0] ?? { path: "", text: null, hash: null }), null);
	assert.equal(
		sizeNote({ path: "big", text: "x", hash: null, truncatedFrom: 600 * 1024 }),
		"Showing the first 256 KB of 600 KB.",
	);
});

test("the dialog claims a restart only when the surface left the task's report", () => {
	assert.deepEqual(afterTrust(true, false), { message: TRUST_RESTARTING, close: true });
	assert.deepEqual(afterTrust(true, true), { message: TRUST_APPLY_LATER, close: false });
	assert.equal(afterTrust(false, false).close, false);
	assert.deepEqual(
		ignoredSurfaces({
			ignored: [
				{ surface: "hooks", file: "a.yaml", verdict: "untrusted", fix: "x" },
				{ surface: "hooks", file: "b.sh", verdict: "untrusted", fix: "x" },
				{ surface: "settings", file: "s.yaml", verdict: "changed", fix: "y" },
			],
		}).map((group) => [group.surface, group.files]),
		[
			["hooks", ["a.yaml", "b.sh"]],
			["settings", ["s.yaml"]],
		],
	);
});
