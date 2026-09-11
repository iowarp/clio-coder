import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeEvalArtifactV4 } from "../../../../src/domains/eval/artifacts/store.js";
import type { EvalArtifactV4 } from "../../../../src/domains/eval/schema/artifact.js";
import { createEvalId } from "../../../../src/domains/eval/store.js";
import type { SessionEntry } from "../../../../src/domains/session/entries.js";
import { cwdHash } from "../../../../src/engine/session.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("Fixture workspace required");
// Same explicit-link v4 shape as the root artifact-namespacing fixture.
const ids: string[] = [];
for (let i = 0; i < 13; i++) {
	const id = createEvalId(new Date(Date.UTC(2026, 8, 1, 0, i)), "b".repeat(64));
	ids.push(id);
	const artifact: EvalArtifactV4 = {
		version: 4,
		evalId: id,
		suite: { id: "fixture-suite", hash: "b".repeat(64) },
		clioCoder: { version: "0.4.7", commit: null, entry: "host-only-entry" },
		environment: { platform: "linux", node: process.version },
		matrix: { target: "fixture-target", model: "fixture-model", thinking: null },
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			wallTimeMs: 1000,
			tokens:
				i === 0
					? { measured: false, runs: 1, measuredRuns: 0 }
					: { measured: true, runs: 1, measuredRuns: 1, input: 7, output: 5, cacheRead: 10, cacheWrite: 0, total: 22 },
		},
		results: [
			{
				taskId: "fixture-task",
				repeatIndex: 0,
				target: { id: "fixture-target", model: "fixture-model", thinking: null },
				pass: true,
				failureClass: null,
				assignmentId: null,
				terminalReceiptDigest: null,
				metrics: { wallTimeMs: 1000 },
				artifacts: { session: "host-only-transcript" },
			},
		],
	};
	await writeEvalArtifactV4(join(cwd, "data"), artifact);
}
await writeFile(join(cwd, "data/evals/corrupt.json"), "broken");
const base = { parentTurnId: null, timestamp: new Date(Date.now() - 1000).toISOString() };
const entries: SessionEntry[] = [
	{ ...base, kind: "modelChange", turnId: "model", provider: "fixture-target", modelId: "fixture-model" },
	...[1, 2].map((index) => ({
		...base,
		kind: "message" as const,
		role: "assistant" as const,
		turnId: `turn-${index}`,
		payload: {
			usage: { input: 7, output: 5, cacheRead: 10, cacheWrite: 0, reasoning: 2, totalTokens: 22, cost: { total: 0.01 } },
		},
	})),
];
const sessions = join(cwd, "state/sessions", cwdHash(cwd), "usage-fixture");
await mkdir(sessions, { recursive: true });
await writeFile(join(sessions, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
process.stdout.write(JSON.stringify({ ids }));
