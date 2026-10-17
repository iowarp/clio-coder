import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import { DispatchArtifactProvider, ReceiptArtifactProvider } from "../../src/domains/session/view-artifacts.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("dispatch and receipt views read a /run worker's sealed output and mutation paths without a dispatch tool entry", async () => {
	const scratch = await isolateClioEnv("clio-coder-view-dispatch-");
	try {
		const stateDir = join(scratch.dir, "state");
		const receiptPath = join(stateDir, "receipts", "run-view.json");
		mkdirSync(join(stateDir, "receipts"), { recursive: true });
		const result = {
			mutatedPaths: ["src/rates.mjs", "src/injected\n## Forged\u001b[31m.mjs", "src/`tick`.mjs"],
			validations: [],
			summary: "Added the percent JSDoc.",
		};
		const text = JSON.stringify(result);
		writeFileSync(
			receiptPath,
			JSON.stringify({
				runId: "run-view",
				agentId: "coder",
				wireModelId: "fake",
				targetId: "fake",
				startedAt: "2026-10-16T12:00:00Z",
				endedAt: "2026-10-16T12:00:01Z",
				tokenCount: 100,
				costUsd: 0,
				toolStats: [],
				output: {
					state: "final",
					text,
					bytes: Buffer.byteLength(text),
					truncated: false,
					structured: { version: 1, kind: "mutation-report", data: result },
				},
			}),
		);
		const row = {
			id: "run-view",
			agentId: "coder",
			task: "Add JSDoc",
			cwd: scratch.dir,
			sessionId: null,
			status: "succeeded",
			outcome: "succeeded",
			exitCode: 0,
			targetId: "fake",
			wireModelId: "fake",
			runtimeKind: "native",
			runtimeId: "fake",
			startedAt: "2026-10-16T12:00:00Z",
			endedAt: "2026-10-16T12:00:01Z",
			tokenCount: 100,
			costUsd: 0,
			receiptPath,
		} as unknown as RunEnvelope;
		const deps = {
			stateDir,
			dispatch: { listRuns: () => [row], getRun: () => row },
			readSessionEntries: () => [],
			sessionMeta: { id: "view-session", cwd: scratch.dir } as SessionMeta,
		};
		const dispatch = (await new DispatchArtifactProvider(deps).list())[0];
		const receipt = (await new ReceiptArtifactProvider(deps).list())[0];
		ok(dispatch && receipt);
		const dispatchBody = (await dispatch.load()).lines.join("\n");
		const receiptBody = (await receipt.load()).lines.join("\n");
		deepStrictEqual(
			[
				dispatchBody.includes(text),
				receiptBody.includes("- ` src/rates.mjs `"),
				receiptBody.includes("Changed paths were not recorded"),
			],
			[true, true, false],
		);
		ok(receiptBody.includes("- ` src/injected ## Forged.mjs `"));
		ok(receiptBody.includes("- `` src/`tick`.mjs ``"));
		ok(!receiptBody.includes("\n## Forged"));
		const stored = JSON.parse(readFileSync(receiptPath, "utf8"));
		stored.output.structured.data.mutatedPaths = [];
		writeFileSync(receiptPath, JSON.stringify(stored));
		const emptyReported = (await receipt.load()).lines.join("\n");
		ok(emptyReported.includes("Changed paths were not recorded."));
		ok(!emptyReported.includes("No changed paths recorded."));
		stored.checkoutChanges = { changedPaths: [] };
		writeFileSync(receiptPath, JSON.stringify(stored));
		const emptyObserved = (await receipt.load()).lines.join("\n");
		ok(emptyObserved.includes("No changed paths recorded."));
		ok(!emptyObserved.includes("Changed paths were not recorded."));
	} finally {
		scratch.restore();
	}
});
