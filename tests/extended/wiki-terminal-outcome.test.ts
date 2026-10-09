import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import type { WikiPlan } from "../../src/domains/context/wiki/plan.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("reports pending publications as incomplete for wiki and refresh, including no-op updates", () => {
	for (const command of ["wiki", "refresh", "retry"]) {
		for (const status of ["generated", "noop"]) {
			for (const pending of [0, 1, 3]) {
				const stdout = execFileSync(
					process.execPath,
					[
						"--experimental-test-module-mocks",
						"--import",
						"tsx",
						fileURLToPath(new URL("../fixtures/wiki/terminal-outcome.ts", import.meta.url)),
						command,
						status,
						String(pending),
					],
					{ encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
				);
				assert.match(stdout, new RegExp(`3 published pages; ${3 - pending} complete, ${pending} pending`, "u"));
				if (pending > 0) {
					assert.match(stdout, /: incomplete \(/u);
					assert.match(stdout, new RegExp(`${pending} exhausted ordinary writer attempts`, "u"));
					assert.match(stdout, /writer: fixture fetch failed/u);
					assert.match(stdout, /clio-coder context wiki --retry-pending/u);
					assert.doesNotMatch(stdout, /: (?:generated|unchanged) \(/u);
				} else {
					assert.match(stdout, new RegExp(`: ${status === "noop" ? "unchanged" : "generated"} \\(`, "u"));
					assert.doesNotMatch(stdout, /incomplete|--retry-pending/u);
				}
			}
		}
	}
});

it("separates known, estimated and unknown run costs and reports missing usage", async () => {
	const isolated = await isolateClioEnv("wiki-usage-");
	try {
		const cwd = isolated.dir;
		const outputDir = join(cwd, ".clio-coder/wiki-staging");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const plan: WikiPlan = {
			version: 1,
			overview: "Usage fixture",
			pages: ["estimated", "unknown", "partial", "missing"].map((name) => ({
				path: `${name}.md`,
				title: name,
				intent: `Explain ${name}`,
				sources: ["package.json"],
				status: "pending",
				attempts: 0,
			})),
		};
		const usage = {
			exitCode: 0,
			tokenCount: 50,
			inputTokenCount: 30,
			outputTokenCount: 10,
			cacheReadTokenCount: 5,
			cacheWriteTokenCount: 5,
			missingTokenCalls: 0,
		};
		const receipts: Array<
			| Pick<
					RunReceipt,
					| "exitCode"
					| "tokenCount"
					| "inputTokenCount"
					| "outputTokenCount"
					| "cacheReadTokenCount"
					| "cacheWriteTokenCount"
					| "missingTokenCalls"
					| "costUsd"
					| "costProvenance"
			  >
			| undefined
		> = [
			{
				...usage,
				tokenCount: 100,
				inputTokenCount: 60,
				outputTokenCount: 20,
				cacheReadTokenCount: 10,
				cacheWriteTokenCount: 10,
				missingTokenCalls: 2,
				costUsd: 1.25,
				costProvenance: "known",
			},
			{ ...usage, costUsd: 0.75, costProvenance: "estimated" },
			{ ...usage, costUsd: 999, costProvenance: "unknown" },
			{ exitCode: 0, tokenCount: 7, costUsd: 999, costProvenance: "unknown" },
			undefined,
		];
		let dispatched = 0;
		const dispatch = {
			abort() {},
			async dispatch() {
				const receipt = receipts[dispatched++];
				return {
					runId: `usage-${dispatched}`,
					events: (async function* () {})(),
					finalPromise: receipt ? Promise.resolve(receipt) : Promise.reject(new Error("receipt unavailable")),
				};
			},
		} as unknown as DispatchContract;
		const summaries: string[] = [];
		await modelWikiGenerate({ dispatch })({
			cwd,
			outputDir,
			mode: "init",
			resumed: false,
			plan,
			unclaimedAreas: [],
			codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
			generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan },
			progress(event) {
				if (event.message === "wiki invocation usage") summaries.push(event.detail ?? "");
			},
		});
		assert.equal(dispatched, 5);
		assert.deepEqual(summaries, [
			"5 dispatched runs; reported tokens: total=207, input=120, output=40, cache read=20, cache write=20, missing-usage calls=2" +
				"; incomplete usage breakdown=2 runs; missing-usage count unknown=2 runs" +
				"; reported cost subtotals: known=$1.25, estimated=~$0.75 est; unknown cost=3 runs; usage/cost totals may be incomplete",
		]);
	} finally {
		isolated.restore();
	}
});
