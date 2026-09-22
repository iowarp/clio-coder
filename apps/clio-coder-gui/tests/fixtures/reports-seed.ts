import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "../../../../src/domains/session/entries.js";
import { cwdHash } from "../../../../src/engine/session.js";

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
		payload: {
			usage: { input: 7, output: 5, cacheRead: 10, cacheWrite: 0, reasoning: 2, totalTokens: 22, cost: { total: 0.01 } },
		},
	})),
];
const sessions = join(cwd, "state/sessions", cwdHash(cwd), "usage-fixture");
await mkdir(sessions, { recursive: true });
await writeFile(join(sessions, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
