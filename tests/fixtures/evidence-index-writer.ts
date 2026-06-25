import { existsSync } from "node:fs";
import { writeEvidenceIndexRowQueued } from "../../src/domains/observability/evidence-index.js";

const [stateDir, runId, startFile] = process.argv.slice(2);

if (stateDir === undefined || runId === undefined) {
	throw new Error("usage: evidence-index-writer <stateDir> <runId> [startFile]");
}

async function waitForStart(path: string): Promise<void> {
	while (!existsSync(path)) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

if (startFile !== undefined) {
	await waitForStart(startFile);
}

await writeEvidenceIndexRowQueued(stateDir, {
	runId,
	evidenceId: `run-${runId}`,
	tags: [],
	firstPassSuccess: false,
	findingCount: 0,
	generatedAt: "2026-06-25T00:00:00.000Z",
});
