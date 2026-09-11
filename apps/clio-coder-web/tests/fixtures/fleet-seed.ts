import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../../../src/domains/dispatch/gate-decisions.js";
import { writeFleetRun } from "../../../../src/domains/dispatch/state.js";
import type { RunEnvelope } from "../../../../src/domains/dispatch/types.js";

const state = process.env.CLIO_CODER_STATE_DIR;
assert.ok(state);
mkdirSync(join(state, "fleet-runs"), { recursive: true });
mkdirSync(join(state, "receipts"), { recursive: true });
const stamp = (i: number) => new Date(Date.UTC(2026, 8, 10, 12, Math.floor(i / 2))).toISOString();
for (let i = 0; i < 150; i++) {
	await writeFleetRun({
		version: 1,
		id: `fleet-${String(i).padStart(3, "0")}`,
		fleet: "Fixture verification",
		planHash: "a".repeat(64),
		startedAt: stamp(i),
		endedAt: stamp(i + 2),
		resumedFrom: null,
		stepIds: ["review"],
		planSteps: [],
		vars: {},
		steps: [
			{
				stepId: "review",
				result: {
					stepId: "review",
					assignmentId: "fixture-assignment",
					terminalRunId: "member-two",
					receiptDigest: "b".repeat(64),
					output: "Fixture step passed.",
					succeeded: true,
					integrityValid: true,
				},
			},
		],
	});
}
writeFileSync(join(state, "fleet-runs/corrupt.json"), "{broken");
writeFileSync(join(state, "fleet-runs/wrong-shape.json"), JSON.stringify({ version: 1, id: "wrong-shape" }));
const base: RunEnvelope = {
	version: 1,
	id: "member-one",
	agentId: "researcher",
	executionRole: "researcher",
	task: "Review fixture evidence",
	targetId: "fixture-target",
	wireModelId: "fixture-model",
	runtimeId: "openai-compat",
	runtimeKind: "http",
	startedAt: stamp(1),
	endedAt: stamp(2),
	status: "completed",
	outcome: "succeeded",
	exitCode: 0,
	pid: null,
	heartbeatAt: null,
	receiptPath: null,
	sessionId: null,
	cwd: process.argv[2] ?? "",
	tokenCount: 125,
	costUsd: 0,
	council: { group: "fixture-council", label: "reviewer", round: 1 },
};
const rows: RunEnvelope[] = [
	base,
	{
		...base,
		id: "member-two",
		startedAt: stamp(3),
		endedAt: stamp(4),
		council: { group: "fixture-council", label: "reviewer", round: 2 },
	},
	{
		...base,
		id: "council-report",
		agentId: "council-synthesis",
		task: "Council none synthesis",
		startedAt: stamp(5),
		endedAt: stamp(6),
		council: { group: "fixture-council", label: "synthesis", round: 2 },
	},
];
writeFileSync(join(state, "runs.json"), JSON.stringify(rows));
for (const id of ["fleet-149", "member-two"])
	writeFileSync(
		join(state, "receipts", `${id}.json`),
		JSON.stringify({ version: 1, runId: id, outcome: "succeeded", output: { text: "Fixture receipt output" } }),
	);
const decision = materializePendingGateDecision(
	stagePendingGateDecision({
		group: "fixture-gate",
		topology: "review",
		cycle: 1,
		outcome: "pass",
		subjects: [{ runId: "member-two", digest: "b".repeat(64) }],
		decider: { runId: "member-one", digest: "c".repeat(64) },
		correlation: { agent: false, target: true, modelFamily: false, runtime: true, node: true, independent: true },
		createdAt: stamp(7),
	}),
);
process.stdout.write(JSON.stringify({ count: 150, gateId: decision.artifact.id }));
