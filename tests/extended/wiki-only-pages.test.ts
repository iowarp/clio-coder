import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import { runWikiGenerate, type WikiGenerateInput } from "../../src/domains/context/wiki/generate.js";
import { readWikiPlanFile, writeWikiPlanFile } from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function fixture(cwd: string, outputDir: string, onlyPages: string[]): WikiGenerateInput {
	const pending = { status: "pending" as const, attempts: 0 };
	const plan = {
		version: 1 as const,
		overview: "Two pages",
		pages: [
			{ path: "one.md", title: "One", intent: "One", sources: ["src/api.ts"], ...pending },
			{ path: "two.md", title: "Two", intent: "Two", sources: ["src/api.ts"], ...pending },
		],
	};
	mkdirSync(outputDir, { recursive: true });
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src/api.ts"), "export const api = 1;\n");
	writeWikiPlanFile(outputDir, plan);
	return {
		cwd,
		outputDir,
		mode: "update",
		resumed: true,
		onlyPages,
		plan,
		unclaimedAreas: [],
		codewiki: { version: 5, language: "typescript", files: [], symbols: [], edges: [] },
		generation: { requestedDepth: "simple", depth: "simple", sourceFiles: 1, sourceLines: 1, plan },
	};
}

it("writes only the named pages and leaves the rest of the plan owed", async () => {
	const isolated = await isolateClioEnv("wiki-only-pages-");
	try {
		const cwd = join(isolated.dir, "repo");
		const outputDir = join(cwd, ".clio-coder", "wiki-staging-only");
		const input = fixture(cwd, outputDir, ["two.md"]);
		const requests: DispatchRequest[] = [];
		const dispatch = {
			abort() {},
			async dispatch(spec: DispatchRequest) {
				requests.push(spec);
				writeFileSync(join(outputDir, "two.md"), "# Two\n\nThe constant is defined in `src/api.ts:1`.\n");
				return {
					runId: `wiki-${requests.length}`,
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ exitCode: 0 }),
				};
			},
		} as unknown as DispatchContract;
		await modelWikiGenerate({ dispatch })(input);
		assert.equal(requests.length, 1);
		const pages = readWikiPlanFile(outputDir)?.pages ?? [];
		assert.equal(pages.find((page) => page.path === "two.md")?.status, "written");
		assert.equal(pages.find((page) => page.path === "one.md")?.status, "pending");
	} finally {
		isolated.restore();
	}
});

it("refuses a page path the plan does not hold before any dispatch", async () => {
	const isolated = await isolateClioEnv("wiki-only-pages-unknown-");
	try {
		const cwd = join(isolated.dir, "repo");
		const input = fixture(cwd, join(cwd, ".clio-coder", "wiki-staging-only"), ["missing.md"]);
		let dispatched = 0;
		const dispatch = {
			abort() {},
			async dispatch() {
				dispatched += 1;
				throw new Error("must not dispatch");
			},
		} as unknown as DispatchContract;
		await assert.rejects(async () => modelWikiGenerate({ dispatch })(input), /missing\.md/);
		assert.equal(dispatched, 0);
	} finally {
		isolated.restore();
	}
});

it("carries the named pages from the run entry point to the generator", async () => {
	const isolated = await isolateClioEnv("wiki-only-pages-entry-");
	try {
		const cwd = join(isolated.dir, "repo");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src/api.ts"), "export const api = 1;\n");
		let seen: ReadonlyArray<string> | undefined;
		await runWikiGenerate({
			cwd,
			model: "fixture",
			onlyPages: ["two.md"],
			generate: (input) => {
				seen = input.onlyPages;
			},
		});
		assert.deepEqual(seen, ["two.md"]);
	} finally {
		isolated.restore();
	}
});
