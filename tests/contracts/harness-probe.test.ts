import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { loadProbeFixture, pairProbeTurns } from "../../scripts/harness-probe.js";

it("loads a fixture and pairs three operator turns with two ledger outcomes without inventing the third", () => {
	const fixture = loadProbeFixture(
		JSON.stringify({
			description: "ledger pairing",
			project: "self",
			cases: [
				{
					id: "a1",
					turns: ["one", "two", "three"].map((text) => ({ text, expect: { control: "none", dispatch: false } })),
				},
			],
		}),
	);
	const first = { version: 1, turnId: "u1", coordinator: { toolCalls: 0 } };
	const second = { version: 1, turnId: "u2", coordinator: { toolCalls: 2 } };
	const control = { turnId: "u2", control: "direction" };
	const ledger = [
		{ kind: "message", role: "user", turnId: "u1", parentTurnId: null },
		{ kind: "message", role: "assistant", turnId: "a1", parentTurnId: "u1" },
		{ kind: "custom", customType: "turnOutcome", parentTurnId: "a1", data: first },
		{ kind: "message", role: "user", turnId: "u2", parentTurnId: "a1" },
		{ kind: "message", role: "assistant", turnId: "a2", parentTurnId: "u2" },
		{ kind: "custom", customType: "turnControl", parentTurnId: "a2", data: control },
		{ kind: "custom", customType: "turnOutcome", parentTurnId: "a2", data: second },
		{ kind: "message", role: "user", turnId: "u3", parentTurnId: "a2" },
		{ kind: "message", role: "assistant", turnId: "a3", parentTurnId: "u3" },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	const turns = fixture.cases[0]?.turns;
	strictEqual(fixture.project, "self");
	strictEqual(turns?.length, 3);
	const paired = pairProbeTurns(turns ?? [], ledger);
	strictEqual(paired.length, 3);
	deepStrictEqual(
		paired.map((row) => row.turnOutcome),
		[first, second, null],
	);
	deepStrictEqual(
		paired.map((row) => row.turnControl),
		[null, control, null],
	);
	deepStrictEqual(
		paired.map((row) => [row.turnIndex, row.text, row.expect]),
		[
			[0, "one", { control: "none", dispatch: false }],
			[1, "two", { control: "none", dispatch: false }],
			[2, "three", { control: "none", dispatch: false }],
		],
	);
});
