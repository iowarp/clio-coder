import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clioStateDir } from "../../../../src/core/xdg.js";
import type { SessionEntry } from "../../../../src/domains/session/entries.js";
import { openCallJournal } from "../../../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../../../src/domains/telemetry/paths.js";
import { cwdHash } from "../../../../src/engine/session.js";
import { telemetryCall } from "../../../../tests/harness/telemetry-view.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("Fixture workspace required");
const base = { parentTurnId: null, timestamp: new Date(Date.now() - 1000).toISOString() };
const entries: SessionEntry[] = [
	{ ...base, kind: "modelChange", turnId: "model", provider: "fixture-target", modelId: "fixture-model" },
	...[1, 2].map((index) => ({
		...base,
		kind: "message" as const,
		role: "assistant" as const,
		turnId: `turn-${index}`,
		payload: { stopReason: "stop" },
	})),
];
const sessions = join(cwd, "state/sessions", cwdHash(cwd), "usage-fixture");
await mkdir(sessions, { recursive: true });
await writeFile(join(sessions, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

const sessionId = "usage-fixture";
const journal = await openCallJournal({
	directory: telemetrySessionDirectory(clioStateDir(), sessionId),
	context: { sessionId, agent: { role: "main", id: sessionId } },
	writer: { clioCoderVersion: "test", piVersion: "test" },
});
try {
	for (const index of [1, 2]) {
		for (const record of telemetryCall(sessionId, {
			turnId: `turn-${index}`,
			targetId: "fixture-target",
			at: base.timestamp,
			usage: { input: 7, output: 5, cacheRead: 10, cacheWrite: 0, reasoning: 2 },
			usd: 0.01,
			pricedBy: "catalog",
		})) {
			if (record.k !== "call.started" && record.k !== "call.settled") throw new Error("unexpected fixture event");
			journal.enqueue({
				kind: record.k,
				data: record.data,
				ctx: record.ctx,
				wallMs: Date.parse(record.t),
				mono: record.mono,
			} as Parameters<typeof journal.enqueue>[0]);
		}
	}
} finally {
	await journal.close();
}
