import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionRows, reloadOutcome } from "../client/chat/extensions-model.js";

test("extensions read in the overlay's words with their problems, and paths never appear", () => {
	const rows = extensionRows({
		version: 1,
		truncated: false,
		extensions: [
			{
				id: "old",
				name: "Old plotter",
				version: "0.3.0",
				description: "",
				scope: "user",
				state: "incompatible",
				overriddenBy: "project",
				runtime: true,
				problems: 1,
				diagnostics: ["requires Clio Coder 0.4"],
			},
		],
	});
	assert.deepEqual(rows, [
		{
			key: "user:old",
			name: "Old plotter",
			detail: "old 0.3.0 · user scope · overridden by the project copy · runs code · 1 problem",
			tone: "warn",
			word: "Incompatible",
			diagnostics: ["requires Clio Coder 0.4"],
		},
	]);
});

test("a reload says which generation is live, and a refused one says which stays", () => {
	assert.deepEqual(
		reloadOutcome({
			status: "committed",
			generation: 3,
			changed: true,
			added: 1,
			removed: 0,
			modified: 2,
			hooks: { registered: 4, dropped: 1, issues: 0, overridden: 0 },
			lines: [],
		}),
		{ tone: "warning", text: "Generation 3 is live (+1 −0 ~2); 4 hooks registered, 1 dropped.", lines: [] },
	);
	assert.deepEqual(reloadOutcome({ status: "rejected", reason: "build-failed", generation: 2, lines: ["bad"] }), {
		tone: "error",
		text: "Reload refused (build-failed); generation 2 stays live.",
		lines: ["bad"],
	});
});
