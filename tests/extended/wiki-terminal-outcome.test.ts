import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { spendSumsOf } from "../../src/core/telemetry/pricing.js";
import type { RunUsageFacts } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { WikiPlan } from "../../src/domains/context/wiki/plan.js";
import { readWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunResult } from "../../src/domains/dispatch/types.js";
import { measuredSpend } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** A fixture run's spend in both shapes a receipt carries: its facts and the sums a total adds. */
const spent = (spend: RunUsageFacts) => ({ spend, spendSums: spendSumsOf(spend) });

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
		const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
		const unknownSpend = {
			usage: {
				input: unknown,
				output: unknown,
				cacheRead: unknown,
				cacheWrite: unknown,
				cacheWrite1h: unknown,
				reasoning: unknown,
			},
			totalTokens: unknown,
			apiCalls: unknown,
			pricing: { usd: unknown, pricedBy: "none" as const },
		};
		const counts = { input: 30, output: 10, cacheRead: 5, cacheWrite: 5 };
		const receipts: Array<Pick<RunResult, "exitCode" | "spend" | "spendSums"> | undefined> = [
			{ exitCode: 0, ...spent(measuredSpend({ input: 60, output: 20, cacheRead: 10, cacheWrite: 10 }, 1.25)) },
			{ exitCode: 0, ...spent(measuredSpend(counts, 0.75, "catalog")) },
			{ exitCode: 0, ...spent(measuredSpend(counts)) },
			{ exitCode: 0, ...spent(unknownSpend) },
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
		// A run with no receipt and one whose usage went unreported each leave a lower bound; a run nobody priced leaves
		// the cost one (#434 §11.3).
		assert.deepEqual(summaries, [
			"5 dispatched runs; reported tokens: total=≥200 (2 runs unknown), input=≥120 (2 runs unknown), output=≥40 (2 runs unknown)" +
				", cache read=≥20 (2 runs unknown), cache write=≥20 (2 runs unknown)" +
				"; reported cost=~$2.00 +?",
		]);
	} finally {
		isolated.restore();
	}
});

async function runCacheReportingFixture(
	prefix: string,
	flags: ReadonlyArray<boolean> | undefined,
): Promise<{ details: string[]; summaries: string[] }> {
	const isolated = await isolateClioEnv(prefix);
	try {
		const cwd = isolated.dir;
		const outputDir = join(cwd, ".clio-coder/wiki-staging");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const plan: WikiPlan = {
			version: 1,
			overview: "Cache fixture",
			pages: [
				{
					path: "page.md",
					title: "page",
					intent: "Explain page",
					sources: ["package.json"],
					status: "pending",
					attempts: 0,
				},
			],
		};
		// Every dispatch (writer, retry, repair) returns the same receipt so the fixture does not depend on the dispatch count.
		const cacheRead = (measured: boolean) =>
			measured
				? { kind: "measured" as const, value: 0, source: "provider" as const }
				: { kind: "unknown" as const, reason: "provider-omitted" as const };
		const spend = measuredSpend({ input: 30, output: 10, cacheRead: 0, cacheWrite: 5 }, 1);
		const receipt = {
			exitCode: 0,
			// A run whose every tracked call omitted the field folds to an unknown cache read.
			...spent(
				flags?.every((reported) => !reported)
					? { ...spend, usage: { ...spend.usage, cacheRead: cacheRead(false) } }
					: spend,
			),
			...(flags
				? {
						upstreamResponses: flags.map((reported) => ({
							usage: { ...spend.usage, cacheRead: cacheRead(reported) },
							usageScope: "call",
						})),
					}
				: {}),
		};
		let dispatched = 0;
		const dispatch = {
			abort() {},
			async dispatch() {
				dispatched += 1;
				return {
					runId: `cache-${dispatched}`,
					events: (async function* () {})(),
					finalPromise: Promise.resolve(receipt),
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
				else if (event.detail?.includes("; run=cache-")) details.push(event.detail);
			},
		});
		return { details, summaries };
	} finally {
		isolated.restore();
	}
}

it("prints cache read as unreported when no call reported the field and keeps a measured zero otherwise", async () => {
	const all = await runCacheReportingFixture("wiki-cache-unreported-", [false, false]);
	assert.ok(all.details.length > 0);
	for (const detail of all.details) assert.match(detail, /cache read=unreported, cache write=5/u);
	assert.match(all.summaries[0] ?? "", /^\d+ dispatched runs; reported tokens: .*cache read=unreported, cache write=/u);

	const mixed = await runCacheReportingFixture("wiki-cache-mixed-", [false, true, false]);
	assert.ok(mixed.details.length > 0);
	for (const detail of mixed.details) assert.match(detail, /cache read=0 \(unreported on 2\/3 calls\), cache write=5/u);
	assert.match(mixed.summaries[0] ?? "", /cache read=0 \(unreported on \d+ runs\), cache write=/u);

	const untracked = await runCacheReportingFixture("wiki-cache-untracked-", undefined);
	assert.ok(untracked.details.length > 0);
	for (const detail of untracked.details) assert.match(detail, /cache read=0, cache write=5/u);
	assert.match(untracked.summaries[0] ?? "", /cache read=0, cache write=/u);
	assert.doesNotMatch(untracked.summaries[0] ?? "", /unreported/u);
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
			...spent(measuredSpend({ input: 300, output: 100, cacheRead: 50, cacheWrite: 50 }, 2)),
		};
		const earlierSpend = measuredSpend({ input: 60, output: 20, cacheRead: 10, cacheWrite: 10 }, 0.5);
		// The earlier attempt had a call that reported no usage, so its total is unknown.
		const firstAttempt = {
			id: "retry-0",
			status: "failed",
			endedAt: "2026-01-01T00:00:00.000Z",
			lineage: { parentRunId: null, rootRunId: "retry-0", attempt: 0, depth: 0 },
			...spent({ ...earlierSpend, totalTokens: { kind: "unknown", reason: "provider-omitted" } }),
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
			assert.match(detail, /attempts=2 \(earlier: retry-0 tokens=unknown outcome=failed\)/u);
			// The earlier attempt had a call that reported no usage, so the total is a lower bound.
			assert.match(detail, /all-attempt tokens total=≥500 \(1 run unknown\)/u);
		}
		const attemptsAdmitted = details.length;
		assert.equal(summaries.length, 1);
		assert.match(
			summaries[0] ?? "",
			new RegExp(
				`^${attemptsAdmitted * 2} dispatched runs; reported tokens: total=≥${(attemptsAdmitted * 500).toLocaleString("en-US")} \\(${attemptsAdmitted} runs? unknown\\), input=${(attemptsAdmitted * 360).toLocaleString("en-US")}, output=${(attemptsAdmitted * 120).toLocaleString("en-US")}, cache read=${(attemptsAdmitted * 60).toLocaleString("en-US")}, cache write=${(attemptsAdmitted * 60).toLocaleString("en-US")}; reported cost=\\$[0-9.]+$`,
				"u",
			),
		);
		assert.doesNotMatch(summaries[0] ?? "", /\+\?/u);
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
			...spent(measuredSpend({ input: 5, output: 5 }, 0)),
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
		const sidecar = join(clioStateDir(), "runs", "retry-1", "wiki-validation.json");
		assert.ok(existsSync(sidecar), "sidecar lands under the terminal run");
		assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).runId, "retry-1");
		assert.ok(!existsSync(join(clioStateDir(), "runs", "retry-0", "wiki-validation.json")));
		assert.equal(readWikiPlanFile(outputDir)?.pages[0]?.lastFailure?.runId, "retry-1");
	} finally {
		isolated.restore();
	}
});

it("flags usage as incomplete when the attempt ledger cannot be read", async () => {
	const isolated = await isolateClioEnv("wiki-ledger-failure-");
	try {
		const cwd = isolated.dir;
		const outputDir = join(cwd, ".clio-coder/wiki-staging");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const plan: WikiPlan = {
			version: 1,
			overview: "Ledger failure fixture",
			pages: [
				{ path: "a.md", title: "a", intent: "Explain a", sources: ["package.json"], status: "pending", attempts: 0 },
			],
		};
		const terminal = {
			runId: "ledger-0",
			exitCode: 1,
			...spent(measuredSpend({ input: 5, output: 5 }, 0)),
		};
		const dispatch = {
			abort() {},
			assignments: {
				get() {
					throw new Error("ledger unavailable");
				},
			},
			getRun: () => null,
			async dispatch() {
				return {
					runId: "ledger-0",
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
		for (const detail of details) assert.match(detail, /earlier attempts unrecoverable.*\(incomplete\)/u);
		// Unrecoverable earlier attempts leave every total and the cost a lower bound.
		assert.match(summaries[0] ?? "", /total=≥\d+ \(\d+ runs? unknown\)/u);
	} finally {
		isolated.restore();
	}
});
