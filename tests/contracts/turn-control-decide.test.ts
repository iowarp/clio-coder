import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { parse } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { settingsChangeKind } from "../../src/domains/config/classify.js";
import type { TurnFacts } from "../../src/domains/turn-control/index.js";
import {
	decide,
	decisionHash,
	factsDigest,
	renderCollectedBlock,
	TURN_CONTROL_BLOCK_MAX_CHARS,
} from "../../src/domains/turn-control/index.js";

const facts = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({
	explicitConstraints: false,
	finishedDetachedBatchIds: [],
	...overrides,
});
const on = { workflows: ["detached-collection" as const] };

it("collects finished batches only when the workflow is on and no explicit constraints apply", () => {
	deepStrictEqual(decide(facts({ finishedDetachedBatchIds: ["a", "b"] }), on), {
		kind: "collect",
		batchIds: ["a", "b"],
	});
	deepStrictEqual(decide(facts(), on), { kind: "none", reason: "nothing-finished" });
	deepStrictEqual(decide(facts({ finishedDetachedBatchIds: ["a"] }), { workflows: [] }), {
		kind: "none",
		reason: "off",
	});
	deepStrictEqual(decide(facts({ explicitConstraints: true, finishedDetachedBatchIds: ["a"] }), on), {
		kind: "none",
		reason: "constraints",
	});
});

it("hashes decisions and facts stably and keeps the collected block inside its bound", () => {
	strictEqual(decisionHash({ kind: "collect", batchIds: ["a"] }), decisionHash({ kind: "collect", batchIds: ["a"] }));
	strictEqual(factsDigest(facts()), factsDigest(facts()));
	strictEqual(
		renderCollectedBlock("sealed findings"),
		"[Collected]\nThese detached runs finished and Clio collected them; their sealed run records are the durable record. Use these results for synthesis and do not call monitor to collect them again.\n\nsealed findings",
	);
	strictEqual(renderCollectedBlock("x".repeat(9000)).length <= TURN_CONTROL_BLOCK_MAX_CHARS, true);
});

it("round-trips the defaults, drops retired workflows silently and refuses an invented one", () => {
	const defaults = validateSettings(parse(DEFAULT_SETTINGS_YAML));
	deepStrictEqual(defaults.issues, []);
	deepStrictEqual(defaults.settings.turnControl, DEFAULT_SETTINGS.turnControl);
	const home = validateSettings({
		turnControl: {
			workflows: ["orientation", "direction", "ledger-facts", "detached-collection"],
			orientation: { maxSplit: 4, maxCostUsdPerTurn: null },
		},
	});
	deepStrictEqual(home.issues, []);
	deepStrictEqual(home.settings.turnControl, { workflows: ["detached-collection"] });
	deepStrictEqual(
		home.retired.map((entry) => entry.path),
		["turnControl.orientation"],
	);
	const unknown = validateSettings({ turnControl: { workflows: ["invented"] } });
	strictEqual(unknown.issues[0]?.path, "turnControl.workflows[0]");
	match(unknown.issues[0]?.message ?? "", /detached-collection/);
	for (const key of ["turnControl", "turnControl.workflows"]) strictEqual(settingsChangeKind(key), "nextTurn", key);
});
