import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { sessionStartFacts } from "../../src/domains/prompts/extension.js";
import { latestPriorSession } from "../../src/domains/session/history.js";
import { emptyWorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
import { cwdHash } from "../../src/engine/session.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("selects a recent closed session with two operator turns, excluding fork ancestors", async () => {
	const env = await isolateClioEnv("clio-prior-session-");
	try {
		const cwd = join(env.dir, "project");
		const root = join(clioStateDir(), "sessions", cwdHash(cwd));
		const now = Date.now();
		const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
		const write = (id: string, parent: string | null, minutesAgo: number, count: number) => {
			const dir = join(root, id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "meta.json"),
				JSON.stringify({
					id,
					cwd,
					parentSessionId: parent,
					createdAt: at(30),
					endedAt: id === "current" ? null : at(minutesAgo),
				}),
			);
			const entries = [
				{ type: "session", version: 6, id, timestamp: at(30), cwd },
				...Array.from({ length: count }, (_, index) => ({
					kind: "message",
					turnId: `${id}-${index}`,
					parentTurnId: null,
					timestamp: at(30 - index),
					role: "user",
					payload: { text: `task ${id}` },
				})),
			];
			writeFileSync(join(dir, "current.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		};
		write("grandparent", null, 3, 2);
		write("parent", "grandparent", 4, 2);
		write("independent", null, 5, 2);
		write("one-turn", null, 1, 1);
		write("current", "parent", 0, 0);
		write("future-closed", null, -5, 2);
		strictEqual(
			latestPriorSession(cwd, "", now)?.id,
			"grandparent",
			"a closed session is eligible without a ten-minute wait",
		);
		strictEqual(latestPriorSession(cwd, "current", now)?.id, "independent", "neither fork ancestor is prior");
		const facts = sessionStartFacts(cwd, "current", now, emptyWorkspaceSnapshot(cwd)).join("\n");
		match(facts, new RegExp(at(5).replaceAll(".", "\\.")));
		match(
			sessionStartFacts(cwd, "current", now, emptyWorkspaceSnapshot(cwd)).join("\n"),
			/Answer "last time" from this record; git log is not session history/,
		);
	} finally {
		env.restore();
	}
});

it("redacts secret-shaped text the prior-session line quotes from another session's first prompt", async () => {
	const env = await isolateClioEnv("clio-prior-session-secret-");
	try {
		const cwd = join(env.dir, "project");
		const dir = join(clioStateDir(), "sessions", cwdHash(cwd), "earlier");
		mkdirSync(dir, { recursive: true });
		const now = Date.now();
		const at = new Date(now - 60_000).toISOString();
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "earlier", cwd, createdAt: at, endedAt: at }));
		const turns = [0, 1].map((index) => ({
			kind: "message",
			turnId: `t${index}`,
			parentTurnId: null,
			timestamp: at,
			role: "user",
			payload: { text: "use AKIAIOSFODNN7EXAMPLE and MY_API_KEY=hunter2value" },
		}));
		writeFileSync(join(dir, "current.jsonl"), `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`);
		const facts = sessionStartFacts(cwd, "current", now, emptyWorkspaceSnapshot(cwd)).join("\n");
		match(facts, /Last recorded session here/);
		doesNotMatch(facts, /AKIAIOSFODNN7EXAMPLE|hunter2value/);
	} finally {
		env.restore();
	}
});
