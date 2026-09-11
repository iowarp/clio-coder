import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../../../src/domains/dispatch/gate-decisions.js";
import { withReceiptIntegrity } from "../../../../src/domains/dispatch/receipt-integrity.js";
import { buildEvidence } from "../../../../src/domains/evidence/index.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../../../../tests/harness/receipt.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("Fixture workspace required");
const dataDir = join(cwd, "data"),
	stateDir = join(cwd, "state");
await mkdir(join(stateDir, "receipts"), { recursive: true });
let existing: unknown[] = [];
try {
	existing = JSON.parse(await readFile(join(stateDir, "runs.json"), "utf8"));
} catch {
	/* First seed. */
}
const envelopes = ["evidence-source", "build-source"].map((id) => ({ ...fixtureEnvelope(id), cwd, sessionId: null }));
await writeFile(join(stateDir, "runs.json"), JSON.stringify([...existing, ...envelopes]));
for (const envelope of envelopes) {
	const receipt = withReceiptIntegrity(
		{
			...fixtureReceiptDraft(envelope),
			pipeline: { fromRunId: "earlier-run", position: 2, inputBytes: 12, inputTruncated: false },
		},
		envelope,
	);
	await writeFile(join(stateDir, "receipts", `${envelope.id}.json`), JSON.stringify(receipt));
}
const built = await buildEvidence({ dataDir, stateDir, runId: "evidence-source" });
const gate = materializePendingGateDecision(
	stagePendingGateDecision({
		group: "evidence-gate",
		topology: "review",
		cycle: 1,
		outcome: "pass",
		subjects: [{ runId: "evidence-source", digest: "b".repeat(64) }],
		decider: { runId: "build-source", digest: "c".repeat(64) },
		correlation: { agent: false, target: true, modelFamily: false, runtime: true, node: true, independent: true },
		createdAt: "2026-09-01T00:00:00.000Z",
	}),
).artifact;
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
