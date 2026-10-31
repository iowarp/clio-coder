import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { AccountabilityArtifactProvider } from "../../src/interactive/view/artifacts.js";
import { fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

// Run scopes are machine-wide. `/view` folds their sealed assessments for a
// session, so it must fold only the runs that session can see: its own, plus
// runs recorded in the same project, never another project's (#434).
test("/view accountability folds the runs the session sees and excludes other projects", async () => {
	const home = await isolateClioEnv("clio-session-accountability-");
	try {
		const project = join(home.dir, "project");
		const otherProject = join(home.dir, "other-project");
		mkdirSync(project);
		mkdirSync(otherProject);
		const ledger = openLedger();
		const runs = [
			{ sessionId: "session-a", cwd: project, success: true },
			{ sessionId: "session-b", cwd: project, success: false },
			{ sessionId: "session-c", cwd: otherProject, success: true },
			{ sessionId: null, cwd: project, success: false },
		] as const;
		for (const [index, item] of runs.entries()) {
			const run = ledger.create({
				agentId: `worker-${index}`,
				executionRole: "builder",
				task: "accountability fixture",
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: item.sessionId,
				cwd: item.cwd,
			});
			const endedAt = new Date().toISOString();
			ledger.update(run.id, { endedAt, status: "completed" });
			const settled = { ...run, endedAt };
			await writeSettledRun(clioStateDir(), {
				...fixtureReceiptDraft(settled),
				sessionId: item.sessionId,
				lineage: { parentRunId: null, rootRunId: run.id, attempt: item.success ? 0 : 1, depth: 0 },
				verification: { state: "verified", basis: "validation-tool" },
			});
		}
		await ledger.persist();
		const provider = new AccountabilityArtifactProvider({
			stateDir: clioStateDir(),
			sessionMeta: {
				id: "session-a",
				cwd: project,
				cwdHash: "fixture",
				createdAt: "2026-09-25T00:00:00Z",
				endedAt: null,
				model: null,
				target: null,
				clioCoderVersion: "0.5.6",
				piMonoVersion: "fixture",
				platform: "linux",
				nodeVersion: process.version,
				sessionFormatVersion: 4,
			},
		});
		const [artifact] = await provider.list();
		const loaded = await artifact?.load();
		deepStrictEqual(loaded?.lines.slice(0, 5), [
			"# Accountability",
			"",
			"first-pass success: 1/3 (33%)",
			"unverified successes: 0",
			"ungrounded claims: 0",
		]);
	} finally {
		home.restore();
	}
});
