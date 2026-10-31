import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateDecisionArtifact } from "../../../../src/domains/dispatch/gate-decisions.js";
import {
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../../../src/domains/dispatch/gate-decisions.js";
import { buildEvidence } from "../../../../src/domains/evidence/index.js";
import { openCallJournal } from "../../../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../../../src/domains/telemetry/paths.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../../../../tests/harness/receipt.js";
import { writeSettledRun } from "../../../../tests/harness/settled-run.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("Fixture workspace required");
const dataDir = join(cwd, "data"),
	stateDir = join(cwd, "state");
let existing: unknown[] = [];
try {
	existing = JSON.parse(await readFile(join(stateDir, "runs.json"), "utf8"));
} catch {
	/* First seed. */
}
const envelopes = ["evidence-source", "build-source"].map((id) => ({
	...fixtureEnvelope(id),
	cwd,
	sessionId: null,
	pipeline: { fromRunId: "earlier-run", position: 2, inputBytes: 12, inputTruncated: false },
}));
await writeFile(join(stateDir, "runs.json"), JSON.stringify([...existing, ...envelopes]));
for (const envelope of envelopes) await writeSettledRun(stateDir, fixtureReceiptDraft(envelope));
const built = await buildEvidence({ dataDir, stateDir, runId: "evidence-source" });
const context = {
	sessionId: null,
	runId: "evidence-gate",
	agent: { role: "coordinator", id: "evidence-gate" },
} as const;
const journal = await openCallJournal({
	directory: telemetryRunDirectory(stateDir, context.runId),
	context,
	writer: { clioCoderVersion: "test", piVersion: "test" },
});
let gate: GateDecisionArtifact;
try {
	gate = (
		await materializePendingGateDecision(
			stagePendingGateDecision(
				{
					group: "evidence-gate",
					topology: "review",
					cycle: 1,
					outcome: "pass",
					subjects: [{ runId: "evidence-source", digest: "b".repeat(64) }],
					decider: { runId: "build-source", digest: "c".repeat(64) },
					correlation: { agent: false, target: true, modelFamily: false, runtime: true, node: true, independent: true },
					createdAt: "2026-09-01T00:00:00.000Z",
				},
				{ stateDir, telemetry: context },
			),
		)
	).artifact;
} finally {
	await journal.close();
}
for (let i = 0; i < 40; i++) {
	const id = `evidence-${String(i).padStart(3, "0")}`,
		dir = join(dataDir, "evidence", id);
	await cp(built.directory, dir, { recursive: true });
	await writeFile(
		join(dir, "gate-decisions.json"),
		JSON.stringify({ version: 1, evidenceId: id, decisions: [gate, { ...gate, outcome: "fail" }] }),
	);
	await writeFile(
		join(dir, "overview.json"),
		JSON.stringify({
			...built.overview,
			evidenceId: id,
			generatedAt: new Date(Date.UTC(2026, 8, 1, 0, Math.floor(i / 2))).toISOString(),
		}),
	);
	await writeFile(join(dir, "trust-status.json"), JSON.stringify({ ...built.trustStatus, evidenceId: id }));
}
await rm(built.directory, { recursive: true });
await rm(join(dataDir, "evidence/evidence-000/trust-status.json"));
process.stdout.write(JSON.stringify({ count: 40, runId: "build-source" }));
