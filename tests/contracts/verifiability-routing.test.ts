import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
import { classifyVerifiability, verifiabilityRoute } from "../../src/domains/evidence/verifiability.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";

test("a step a check settles is executable, numeric or reproducible; anything else is a judgment", () => {
	const cases: Array<[string, string, string[]]> = [
		["Do the parser tests pass after the refactor?", "executable", ["test"]],
		["Does src/lexer.ts typecheck and build?", "executable", ["typecheck", "build"]],
		["Does the manifest validate against the JSON schema?", "executable", ["schema"]],
		["Is the HDF5 read throughput within 5% of baseline?", "numeric", ["measure"]],
		["Can we reproduce the run from last night?", "reproducible", ["rerun"]],
		["Should we keep the hand-written lexer?", "judgment", []],
		["Is the API naming better than before, now that tests pass?", "judgment", ["test"]],
		["What do you think about this module?", "judgment", []],
	];
	for (const [text, kind, checks] of cases) {
		const result = classifyVerifiability(text);
		assert.equal(result.kind, kind, text);
		assert.deepEqual(result.checks, checks, text);
	}
	assert.equal(verifiabilityRoute("executable", "default"), "closed-loop");
	assert.equal(verifiabilityRoute("numeric", "yolo"), "closed-loop");
	assert.equal(verifiabilityRoute("judgment", "default"), "ask-operator");
	assert.equal(verifiabilityRoute("judgment", "yolo"), "second-opinion");
});

function oracle(autonomy: AutonomyLevel) {
	const notes: string[] = [];
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (_request: DispatchRequest) => ({
			runId: "oracle-1",
			events: (async function* () {})(),
			finalPromise: Promise.resolve({
				runId: "oracle-1",
				outcome: "succeeded",
				targetId: "gw",
				wireModelId: "gemma-3-27b",
				output: {
					text: JSON.stringify({ verdict: "v", challenge: "c", changesMyMind: "m", citedDecisions: [] }),
					state: "final",
					truncated: false,
				},
			}),
		}),
	} as unknown as AcpCommandHost["dispatch"];
	const host: AcpCommandHost = {
		dispatch,
		bus: createTelemetryHub(),
		providers: { list: () => [], getTarget: () => null } as unknown as AcpCommandHost["providers"],
		submitOperatorNote: (text) => notes.push(text),
		isTurnInFlight: () => false,
		oracleBriefing: () => ({ decisions: [], tasks: [], compactionSummary: null }),
		getAutonomy: () => autonomy,
	};
	return { control: acpCommandControl(host), notes };
}

test("/oracle tells the main agent to run a check, ask the operator, or lean on the advisor", async () => {
	const supervised = oracle("default");
	await supervised.control.invoke({ command: "oracle", argv: ["Do the parser tests pass?"] });
	assert.match(supervised.notes[0] ?? "", /Verifiability: executable, settled by test\. Run that check/);
	await supervised.control.invoke({ command: "oracle", argv: ["Should we keep the lexer?"] });
	assert.match(supervised.notes[1] ?? "", /Verifiability: judgment.*Confirm the decision with the operator/);

	const unattended = oracle("yolo");
	await unattended.control.invoke({ command: "oracle", argv: ["Should we keep the lexer?"] });
	assert.match(unattended.notes[0] ?? "", /Autonomy is yolo, so this advice stands in for the operator/);
});
