import { deepStrictEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { RunEnvelope, RunResultDraft } from "../../src/domains/dispatch/types.js";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import { DispatchArtifactProvider, RunRecordArtifactProvider } from "../../src/domains/session/view-artifacts.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

test("dispatch and run record views read a /run worker's settled output and mutation paths without a dispatch tool entry", async () => {
	const scratch = await isolateClioEnv("clio-coder-view-dispatch-");
	try {
		const stateDir = join(scratch.dir, "state");
		const result = {
			mutatedPaths: ["src/rates.mjs", "src/injected\n## Forged\u001b[31m.mjs", "src/`tick`.mjs"],
			validations: [],
			summary: "Added the percent JSDoc.",
		};
		const rows: RunEnvelope[] = [];
		const seed = async (runId: string, change: (draft: RunResultDraft) => RunResultDraft) => {
			const row: RunEnvelope = {
				...fixtureEnvelope(runId),
				task: "Add JSDoc",
				cwd: scratch.dir,
				sessionId: null,
				startedAt: "2026-10-16T12:00:00.000Z",
				endedAt: "2026-10-16T12:00:01.000Z",
			};
			rows.push(row);
			const text = JSON.stringify(result);
			await writeSettledRun(
				stateDir,
				change({
					...fixtureReceiptDraft(row),
					output: {
						state: "final",
						text,
						bytes: Buffer.byteLength(text),
						truncated: false,
						structured: { version: 1, kind: "mutation-report", data: structuredClone(result) },
					},
				}),
			);
			return text;
		};
		const text = await seed("run-view", (draft) => draft);
		await seed("run-observed", (draft) => ({
			...draft,
			checkoutChanges: {
				cwd: scratch.dir,
				changedPaths: ["src/observed\n## Forged\u001b[31m.mjs"],
				attribution: "observed-delta",
			},
		}));
		await seed("run-empty-reported", (draft) => {
			const output = draft.output;
			ok(output);
			return {
				...draft,
				output: {
					...output,
					structured: { version: 1, kind: "mutation-report", data: { ...result, mutatedPaths: [] } },
				},
			};
		});
		await seed("run-empty-observed", (draft) => ({
			...draft,
			checkoutChanges: { cwd: scratch.dir, changedPaths: [], attribution: "observed-delta" },
		}));
		const deps = {
			stateDir,
			dispatch: { listRuns: () => rows, getRun: (id: string) => rows.find((row) => row.id === id) ?? null },
			readSessionEntries: () => [],
			sessionMeta: { id: "view-session", cwd: scratch.dir } as SessionMeta,
		};
		const byId = async <T extends { id: string }>(list: Promise<T[]>, id: string) =>
			(await list).find((a) => a.id === id);
		const dispatch = await byId(new DispatchArtifactProvider(deps).list(), "run-view");
		const record = await byId(new RunRecordArtifactProvider(deps).list(), "run-view");
		ok(dispatch && record);
		const dispatchBody = (await dispatch.load()).lines.join("\n");
		const recordBody = (await record.load()).lines.join("\n");
		deepStrictEqual(
			[
				dispatchBody.includes(text),
				recordBody.includes("- `src/rates.mjs`"),
				recordBody.includes("Changed paths were not recorded"),
			],
			[true, true, false],
		);
		for (const body of [dispatchBody, recordBody]) {
			ok(body.includes("## What changed"));
			ok(body.includes("Paths reported by the worker:"));
			ok(body.includes("- `src/rates.mjs`"));
			ok(body.includes("- `src/injected ## Forged.mjs`"));
			ok(body.includes("- ``src/`tick`.mjs``"));
			ok(!body.includes("\n## Forged"));
		}
		for (const artifact of [
			await byId(new DispatchArtifactProvider(deps).list(), "run-observed"),
			await byId(new RunRecordArtifactProvider(deps).list(), "run-observed"),
		]) {
			ok(artifact);
			const body = (await artifact.load()).lines.join("\n");
			const changes = body.split("## What changed")[1]?.split(/\nagent output:|\n## /u)[0] ?? "";
			ok(changes.includes("- `src/observed ## Forged.mjs`"));
			ok(!changes.includes("Paths reported by the worker:"));
			ok(!changes.includes("src/rates.mjs"));
		}
		const emptyReported = await byId(new RunRecordArtifactProvider(deps).list(), "run-empty-reported");
		ok(emptyReported);
		const emptyReportedBody = (await emptyReported.load()).lines.join("\n");
		ok(emptyReportedBody.includes("Changed paths were not recorded."));
		ok(!emptyReportedBody.includes("No changed paths recorded."));
		const emptyObserved = await byId(new RunRecordArtifactProvider(deps).list(), "run-empty-observed");
		ok(emptyObserved);
		const emptyObservedBody = (await emptyObserved.load()).lines.join("\n");
		ok(emptyObservedBody.includes("No changed paths recorded."));
		ok(!emptyObservedBody.includes("Changed paths were not recorded."));
	} finally {
		scratch.restore();
	}
});
