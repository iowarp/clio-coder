import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureEnvelope, fixtureReceiptDraft } from "../../../../tests/harness/receipt.js";
import { writeSettledRun } from "../../../../tests/harness/settled-run.js";

/**
 * Seed 40 finished runs whose sealed scopes hold their assessments (#434), each with a ledger row and pipeline
 * provenance, settled one minute apart so the inventory's newest-first order is fixed.
 */
const cwd = process.argv[2];
if (!cwd) throw new Error("Fixture workspace required");
const stateDir = join(cwd, "state");
let existing: unknown[] = [];
try {
	existing = JSON.parse(await readFile(join(stateDir, "runs.json"), "utf8"));
} catch {
	/* First seed. */
}
const envelopes = Array.from({ length: 40 }, (_, i) => {
	const at = Date.UTC(2026, 8, 1, 0, i);
	return {
		...fixtureEnvelope(`evidence-${String(i).padStart(3, "0")}`),
		cwd,
		sessionId: null,
		startedAt: new Date(at - 5_000).toISOString(),
		endedAt: new Date(at).toISOString(),
		pipeline: { fromRunId: "earlier-run", position: 2, inputBytes: 12, inputTruncated: false },
	};
});
await writeFile(join(stateDir, "runs.json"), JSON.stringify([...existing, ...envelopes]));
for (const envelope of envelopes)
	await writeSettledRun(stateDir, { ...fixtureReceiptDraft(envelope), pipeline: envelope.pipeline });
process.stdout.write(JSON.stringify({ count: 40, runId: "evidence-000" }));
