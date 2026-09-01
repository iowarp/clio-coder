import { ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { appendTurn, persistSessionMeta, resumeSessionState, startSession } from "../../src/domains/session/manager.js";
import { createSession, readSessionFileEntries, resumeSession, sessionPaths } from "../../src/engine/session.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("session durability boundary", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-session-contract-");
	});

	afterEach(() => scratch.restore());

	it("makes atomic appends immediately visible and recovers a torn tail on reopen", () => {
		const { meta, writer } = createSession({ cwd: scratch.dir });
		writer.append({
			id: "t1",
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text: "before crash" },
		});
		const path = sessionPaths(meta).current;
		strictEqual(readSessionFileEntries(path).length, 2);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"mess`, "utf8");

		const resumed = resumeSession(meta.id);
		resumed.writer.append({
			id: "t2",
			parentId: "t1",
			at: "2026-06-11T00:00:01.000Z",
			kind: "user",
			payload: { text: "after crash" },
		});
		const warnings: string[] = [];
		const entries = readSessionFileEntries(path, { onWarning: (warning) => warnings.push(warning.message) });
		strictEqual(warnings.length, 1);
		strictEqual((entries[1] as { turnId?: string }).turnId, "t1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("persists a selected branch across close and resumes appends from that leaf", async () => {
		const first = startSession({ cwd: scratch.dir });
		const u1 = appendTurn(first, { id: "u1", parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = appendTurn(first, { id: "a1", parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		appendTurn(first, { id: "u2", parentId: a1.id, kind: "user", payload: { text: "abandoned" } });
		first.meta.pinnedLeafTurnId = a1.id;
		persistSessionMeta(first);
		await first.writer.close();

		const reopened = resumeSessionState(first.meta.id).state;
		strictEqual(reopened.meta.pinnedLeafTurnId, a1.id);
		const alternate = appendTurn(reopened, {
			id: "u3",
			parentId: a1.id,
			kind: "user",
			payload: { text: "alternate" },
		});
		strictEqual(alternate.parentId, a1.id);
		await reopened.writer.close();
	});

	it("keeps the current session open when a resume target cannot be opened", async () => {
		const current = startSession({ cwd: scratch.dir });
		appendTurn(current, { id: "current", parentId: null, kind: "user", payload: { text: "current" } });
		const broken = startSession({ cwd: scratch.dir });
		await broken.writer.close();
		const brokenMeta = sessionPaths(broken.meta).meta;
		const document = JSON.parse(readFileSync(brokenMeta, "utf8")) as Record<string, unknown>;
		document.sessionFormatVersion = 2;
		writeFileSync(brokenMeta, JSON.stringify(document));

		throws(() => resumeSessionState(broken.meta.id), /unsupported format version/u);
		appendTurn(current, {
			id: "still-current",
			parentId: "current",
			kind: "user",
			payload: { text: "still writable" },
		});
		const entries = readSessionFileEntries(sessionPaths(current.meta).current);
		strictEqual((entries.at(-1) as { turnId?: string }).turnId, "still-current");
		strictEqual(current.meta.endedAt, null);
		await current.writer.close();
	});

	it("closes an abandoned run deterministically during restart recovery", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "interrupted work",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		ledger.update(run.id, { status: "running", pid: 999_999, heartbeatAt: run.startedAt });
		await ledger.persist();

		const reopened = openLedger({ maxRuns: 10 });
		const recovered = recoverOrphanReceipts(reopened);
		strictEqual(recovered.abandoned, 1);
		strictEqual(reopened.get(run.id)?.status, "dead");
		strictEqual(reopened.get(run.id)?.outcome, "stalled");
		ok(reopened.get(run.id)?.endedAt !== null);
	});
});
