import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import type { WikiPlan } from "../../src/domains/context/wiki/plan.js";
import { readWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { runEventJournalPath } from "../../src/domains/dispatch/run-event-journal.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("reports incomplete publications and fails wiki generation with pending pages, including no-op updates", () => {
	for (const command of ["wiki", "refresh", "retry"]) {
		for (const status of ["generated", "noop"]) {
			for (const pending of [0, 1, 3]) {
				const result = spawnSync(
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
				assert.ifError(result.error);
				assert.equal(result.signal, null);
				assert.equal(result.status, command !== "refresh" && pending > 0 ? 1 : 0, result.stderr);
				const stdout = result.stdout;
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

it("counts every attempt of a transiently retried dispatch and pairs each run id with its own tokens", async () => {
	const isolated = await isolateClioEnv("wiki-retry-usage-");
	try {
		const cwd = isolated.dir;
		const outputDir = join(cwd, ".clio-coder/wiki-staging");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const plan: WikiPlan = {
			version: 1,
			overview: "Retry fixture",
			pages: [
				{
					path: "retried.md",
					title: "retried",
					intent: "Explain retried",
					sources: ["package.json"],
					status: "pending",
					attempts: 0,
				},
			],
		};
		const terminal = {
			runId: "retry-1",
			exitCode: 1,
			tokenCount: 500,
			inputTokenCount: 300,
			outputTokenCount: 100,
			cacheReadTokenCount: 50,
			cacheWriteTokenCount: 50,
			missingTokenCalls: 0,
			costUsd: 2,
			costProvenance: "known",
		};
		const firstAttempt = {
			id: "retry-0",
			status: "failed",
			endedAt: "2026-01-01T00:00:00.000Z",
			lineage: { parentRunId: null, rootRunId: "retry-0", attempt: 0, depth: 0 },
			tokenCount: 100,
			inputTokenCount: 60,
			outputTokenCount: 20,
			cacheReadTokenCount: 10,
			cacheWriteTokenCount: 10,
			missingTokenCalls: 1,
			costUsd: 0.5,
			costProvenance: "known",
		};
		const dispatch = {
			abort() {},
			assignments: {
				get: (id: string) =>
					id === "retry-0"
						? {
								attempts: [
									{ runId: "retry-0", attempt: 0, outcome: "failed" },
									{ runId: "retry-1", attempt: 1, outcome: "failed" },
								],
							}
						: null,
			},
			getRun: (id: string) => (id === "retry-0" ? firstAttempt : null),
			async dispatch() {
				return {
					runId: "retry-0",
					events: (async function* () {})(),
					finalPromise: Promise.resolve(terminal),
				};
			},
		} as unknown as DispatchContract;
		const details: string[] = [];
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
				else if (event.detail?.includes("; run=")) details.push(event.detail);
			},
		});
		assert.ok(details.length > 0);
		for (const detail of details) {
			assert.match(detail, /; run=retry-1; tokens: total=500,/u);
			assert.doesNotMatch(detail, /run=retry-0; tokens/u);
			assert.match(detail, /attempts=2 \(earlier: retry-0 tokens=100 outcome=failed\)/u);
			assert.match(detail, /all-attempt tokens total=600(?!\s*\(incomplete)/u);
		}
		const attemptsAdmitted = details.length;
		assert.equal(summaries.length, 1);
		assert.match(
			summaries[0] ?? "",
			new RegExp(
				`^${attemptsAdmitted * 2} dispatched runs; reported tokens: total=${attemptsAdmitted * 600}, input=${attemptsAdmitted * 360}, output=${attemptsAdmitted * 120}, cache read=${attemptsAdmitted * 60}, cache write=${attemptsAdmitted * 60}, missing-usage calls=${attemptsAdmitted}; incomplete usage breakdown=0 runs; missing-usage count unknown=0 runs`,
				"u",
			),
		);
		assert.match(summaries[0] ?? "", /unknown cost=0 runs/u);
	} finally {
		isolated.restore();
	}
});

it("records the validation sidecar and last failure under the terminal run of a retried dispatch", async () => {
	const isolated = await isolateClioEnv("wiki-retry-sidecar-");
	try {
		const cwd = isolated.dir;
		const outputDir = join(cwd, ".clio-coder/wiki-staging");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const plan: WikiPlan = {
			version: 1,
			overview: "Retry sidecar fixture",
			pages: [
				{
					path: "retried.md",
					title: "retried",
					intent: "Explain retried",
					sources: ["package.json"],
					status: "pending",
					attempts: 0,
				},
			],
		};
		const terminal = {
			runId: "retry-1",
			exitCode: 0,
			tokenCount: 10,
			missingTokenCalls: 0,
			costUsd: 0,
			costProvenance: "known",
		};
		const dispatch = {
			abort() {},
			assignments: {
				get: (id: string) =>
					id === "retry-0"
						? {
								attempts: [
									{ runId: "retry-0", attempt: 0, outcome: "failed" },
									{ runId: "retry-1", attempt: 1, outcome: "completed" },
								],
							}
						: null,
			},
			getRun: () => null,
			async dispatch() {
				return {
					runId: "retry-0",
					events: (async function* () {})(),
					finalPromise: Promise.resolve(terminal),
				};
			},
		} as unknown as DispatchContract;
		await modelWikiGenerate({ dispatch })({
			cwd,
			outputDir,
			mode: "init",
			resumed: false,
			plan,
			unclaimedAreas: [],
			codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
			generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan },
		});
		const sidecar = join(runEventJournalPath("retry-1").replace(/[^/]+$/u, ""), "wiki-validation.json");
		assert.ok(existsSync(sidecar), "sidecar lands under the terminal run");
		assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).runId, "retry-1");
		assert.ok(!existsSync(join(runEventJournalPath("retry-0").replace(/[^/]+$/u, ""), "wiki-validation.json")));
		assert.equal(readWikiPlanFile(outputDir)?.pages[0]?.lastFailure?.runId, "retry-1");
	} finally {
		isolated.restore();
	}
});
