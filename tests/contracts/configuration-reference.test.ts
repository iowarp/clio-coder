import { strictEqual } from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { configurationReferenceMembership } from "../../scripts/configuration-reference.js";

it("configuration reference distinguishes optional, array and map keys from stale rows", () => {
	// Read the typed schema once. No repository copy, nested node_modules, build
	// output or operator scratch belongs in a documentation fixture.
	const supports = configurationReferenceMembership(resolve(import.meta.dirname, "../.."));
	const cases = [
		{
			paths: [
				"context.compaction.model",
				"fleet.profiles.<key>.node",
				"targets[].auth.headers.<key>",
				"fleet.rosters.<key>.members[].model",
			],
			stale: false,
		},
		{
			paths: [
				"chat.obsoleteOption",
				"context.compaction.obsoleteOption",
				"targets[].capabilities.obsoleteOption",
				"fleet.profiles.<key>.obsoleteOption",
				"fleet.rosters.<key>.members[].obsoleteOption",
				"chat.model.obsoleteOption",
				"chat[].model",
				"chat.<key>.model",
			],
			stale: true,
		},
	];
	for (const scenario of cases) {
		for (const path of scenario.paths) strictEqual(supports(path), !scenario.stale, path);
	}
});
