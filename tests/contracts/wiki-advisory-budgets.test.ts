import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import type { WikiGenerateInput } from "../../src/domains/context/wiki/generate.js";
import { readWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixtureInput(cwd: string): WikiGenerateInput {
	const outputDir = join(cwd, ".clio-coder", "wiki-staging");
	mkdirSync(outputDir, { recursive: true });
	const plan = {
		version: 1 as const,
		overview: "Fixture",
		pages: ["api", "config"].map((name) => ({
			path: `${name}.md`,
			title: name,
			intent: `Explain ${name}`,
			sources: [`src/${name}.ts`],
			status: "pending" as const,
			attempts: 0,
		})),
	};
	return {
		cwd,
		outputDir,
		mode: "init",
		resumed: false,
		plan,
		unclaimedAreas: [],
		codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
		generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 2, sourceLines: 2, plan },
	};
}

it("lets healthy planning and every page finish beyond all ordinary wiki time estimates", async (t) => {
	const isolated = await isolateClioEnv("wiki-advisory-");
	try {
		const input = fixtureInput(isolated.dir);
		let clock = 0;
		t.mock.method(performance, "now", () => clock);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
		const requests: DispatchRequest[] = [];
		const aborted: string[] = [];
		const dispatch = {
			abort(runId: string) {
				aborted.push(runId);
			},
			async dispatch(request: DispatchRequest) {
				requests.push(request);
				return {
					runId: `healthy-${requests.length}`,
					events: (async function* () {
						// Each phase alone exceeds the old whole-run ceiling as well as
						// its per-phase ceiling. Real timer callbacks get their chance.
						clock += 61 * 60 * 1000;
						t.mock.timers.tick(61 * 60 * 1000);
						const page = /Write the file `([^`]+)` and nothing else\./u.exec(request.task)?.[1];
						if (page) writeFileSync(page, "# Completed with current source evidence\n");
						yield { type: "clio_coder_tool_finish", payload: { tool: page ? "write" : "read", outcome: "done" } };
					})(),
					finalPromise: Promise.resolve({ exitCode: 0 }),
				};
			},
		} as unknown as DispatchContract;
		await modelWikiGenerate({ dispatch })(input);
		assert.equal(requests.length, 3, "planner and both healthy pages must finish");
		assert.deepEqual(aborted, []);
		assert.ok(requests.every((request) => request.assignmentDeadlineAt === undefined));
		assert.deepEqual(
			readWikiPlanFile(input.outputDir)?.pages.map((page) => page.status),
			["written", "written"],
		);
	} finally {
		await isolated.restore();
	}
});

it("shares an explicit deadline across phases, aborts the active writer and keeps later pages pending", async (t) => {
	const isolated = await isolateClioEnv("wiki-explicit-deadline-");
	try {
		const input = fixtureInput(isolated.dir);
		let clock = 0;
		const wall = Date.now();
		t.mock.method(performance, "now", () => clock);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: wall });
		const requests: DispatchRequest[] = [];
		const aborted: unknown[] = [];
		let finish: ((receipt: { exitCode: number }) => void) | undefined;
		const dispatch = {
			abort(runId: string, options: unknown) {
				aborted.push({ runId, options });
				finish?.({ exitCode: 1 });
			},
			async dispatch(request: DispatchRequest) {
				requests.push(request);
				const planner = requests.length === 1;
				return {
					runId: planner ? "planner" : "writer",
					events: (async function* () {
						clock += planner ? 40 : 60;
						t.mock.timers.tick(planner ? 40 : 60);
						yield { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "done" } };
					})(),
					finalPromise: planner
						? Promise.resolve({ exitCode: 0 })
						: new Promise((resolve) => {
								finish = resolve;
							}),
				};
			},
		} as unknown as DispatchContract;
		await modelWikiGenerate({ dispatch, deadlineAt: wall + 100, runBudgetMs: 200 })(input);
		assert.deepEqual(
			requests.map((request) => request.assignmentDeadlineAt),
			[wall + 100, wall + 100],
		);
		assert.deepEqual(aborted, [
			{ runId: "writer", options: { cause: "timeout", detail: "explicit wiki deadline reached" } },
		]);
		const pages = readWikiPlanFile(input.outputDir)?.pages;
		assert.equal(pages?.[0]?.status, "pending");
		assert.equal(pages?.[0]?.attempts, 1);
		assert.match(pages?.[0]?.lastFailure?.detail ?? "", /timed out/u);
		assert.equal(pages?.[1]?.attempts, 0, "an expired run must not admit another page");
		t.mock.timers.tick(1_000);
		assert.equal(aborted.length, 1, "settled dispatch timers must be cleared");
	} finally {
		await isolated.restore();
	}
});

it("does not admit work when an explicit run duration has already expired", async () => {
	const isolated = await isolateClioEnv("wiki-expired-deadline-");
	try {
		let admitted = 0;
		const dispatch = {
			async dispatch() {
				admitted++;
				throw new Error("must not dispatch");
			},
		} as unknown as DispatchContract;
		const input = fixtureInput(isolated.dir);
		await modelWikiGenerate({ dispatch, runBudgetMs: 0 })(input);
		assert.equal(admitted, 0);
		assert.ok(readWikiPlanFile(input.outputDir)?.pages.every((page) => page.status === "pending" && page.attempts === 0));
	} finally {
		await isolated.restore();
	}
});
