import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runWikiGenerate, type WikiGenerateInput } from "../../src/domains/context/wiki/generate.js";
import { readWikiMeta } from "../../src/domains/context/wiki/meta.js";
import {
	readAuthoredWikiPlan,
	sanitizeWikiPlan,
	writeWikiPlanFile,
} from "../../src/domains/context/wiki/plan-store.js";
import { buildWikiPagePrompt, buildWikiPlanPrompt } from "../../src/domains/context/wiki/prompts.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("wiki coverage depth", () => {
	let isolated: IsolatedClioEnv;
	let cwd: string;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-wiki-depth-");
		cwd = join(isolated.dir, "repo");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(join(cwd, "src/main.ts"), "export const main = 1;\n");
		for (const args of [
			["init", "-q"],
			["add", "."],
			["-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-qm", "initial"],
		]) {
			execFileSync("git", args, { cwd, stdio: "ignore" });
		}
	});
	afterEach(() => isolated.restore());
	async function run(input: Parameters<typeof runWikiGenerate>[0]) {
		const result = await runWikiGenerate(input);
		assert.notEqual(result.status, "failed", JSON.stringify(result.problems));
		return result;
	}
	function complete(input: WikiGenerateInput, limit = Infinity) {
		// An unchanged planner exercises harness requeueing independently of authored specs.
		const plan = readAuthoredWikiPlan(input.outputDir, input.plan) ?? input.plan;
		let count = 0;
		for (const page of plan.pages) {
			if (page.status === "written" || count++ >= limit) continue;
			mkdirSync(join(input.outputDir, page.path, ".."), { recursive: true });
			writeFileSync(
				join(input.outputDir, page.path),
				`---\ntitle: ${page.title}\nsources:\n  - src/main.ts\n---\n# ${page.title}\n\nCoverage ${input.generation.depth}: main is exported by \`src/main.ts\`.\n`,
			);
			page.status = "written";
			page.attempts += 1;
		}
		writeWikiPlanFile(input.outputDir, plan);
	}
	it("requeues upgrades and downgrades despite an unchanged planner, preserving prose and diagnostic evidence", async () => {
		await run({ cwd, model: "fixture", depth: "simple", generate: complete });
		for (const depth of ["detailed", "simple"] as const) {
			let writes = 0;
			await run({
				cwd,
				model: "fixture",
				depth,
				generate(input) {
					assert.equal(input.resumed, false);
					assert.equal(input.plan.depth, depth);
					for (const page of input.plan.pages) {
						assert.equal(page.status, "pending");
						assert.equal(page.attempts, 0);
						assert.match(readFileSync(join(input.outputDir, page.path), "utf8"), /Coverage/);
						writes++;
					}
					complete(input);
				},
			});
			assert.ok(writes > 0);
			assert.equal(readWikiMeta(cwd)?.plan?.depth, depth);
		}
	});
	it("keeps detailed depth and completed work on interrupted resume and default retry", async () => {
		const first = await runWikiGenerate({
			cwd,
			model: "fixture",
			depth: "detailed",
			generate(input) {
				complete(input, 1);
				throw new Error("interrupted");
			},
		});
		assert.equal(first.status, "failed");
		await run({
			cwd,
			model: "fixture",
			generate(input) {
				assert.equal(input.generation.depth, "detailed");
				assert.equal(input.resumed, true);
				assert.equal(input.plan.pages.filter((page) => page.status === "written").length, 1);
				// Publish partial progress without attempting the remaining page.
			},
		});
		await run({
			cwd,
			model: "fixture",
			retryPending: true,
			generate(input) {
				assert.equal(input.generation.depth, "detailed");
				assert.equal(input.plan.pages.filter((page) => page.status === "written").length, 1);
				complete(input);
			},
		});
		assert.equal(readWikiMeta(cwd)?.generation?.depth, "detailed");
	});
	it("retains auto policy from a first interrupted run through completion and later updates", async () => {
		const first = await runWikiGenerate({
			cwd,
			model: "fixture",
			depth: "auto",
			generate(input) {
				assert.equal(input.plan.requestedDepth, "auto");
				complete(input, 1);
				throw new Error("interrupted auto");
			},
		});
		assert.equal(first.status, "failed");
		assert.equal(readWikiMeta(cwd), null);
		await run({
			cwd,
			model: "fixture",
			generate(input) {
				assert.equal(input.resumed, true);
				assert.equal(input.generation.depth, "simple");
				assert.equal(input.generation.requestedDepth, "auto");
				assert.equal(input.plan.requestedDepth, "auto");
				complete(input);
			},
		});
		assert.equal(readWikiMeta(cwd)?.generation?.requestedDepth, "auto");
		assert.equal(readWikiMeta(cwd)?.plan?.requestedDepth, "auto");
		await run({
			cwd,
			model: "fixture",
			generate(input) {
				assert.equal(input.generation.requestedDepth, "auto");
				assert.ok(input.plan.pages.every((page) => page.status === "written"));
				complete(input);
			},
		});
	});
	it("retains the prior failure when a depth switch resets an exhausted page", async () => {
		await run({
			cwd,
			model: "fixture",
			depth: "simple",
			generate(input) {
				const page = input.plan.pages[0];
				assert.ok(page);
				page.attempts = 3;
				page.lastFailure = { phase: "validation", detail: "Missing source citation", runId: "original-receipt" };
				writeWikiPlanFile(input.outputDir, input.plan);
			},
		});
		await run({
			cwd,
			model: "fixture",
			depth: "detailed",
			retryPending: true,
			generate(input) {
				assert.equal(input.resumed, false);
				const page = input.plan.pages[0];
				assert.ok(page);
				assert.equal(page.attempts, 0);
				assert.equal(page.lastFailure?.runId, "original-receipt");
				const authored = readAuthoredWikiPlan(input.outputDir, input.plan);
				assert.ok(authored);
				assert.equal(authored.pages[0]?.lastFailure?.detail, "Missing source citation");
				complete(input);
			},
		});
	});
	it("rejects model-forged depth and supplies progressive coverage with bounded retry diagnostics", async () => {
		await run({
			cwd,
			model: "fixture",
			depth: "detailed",
			generate(input) {
				const forged = { ...input.plan, depth: "simple", requestedDepth: "auto" };
				assert.equal(sanitizeWikiPlan(forged, input.plan, { trustStatus: false })?.depth, "detailed");
				assert.equal(sanitizeWikiPlan(forged, undefined, { trustStatus: false })?.depth, undefined);
				assert.equal(sanitizeWikiPlan(forged, input.plan, { trustStatus: false })?.requestedDepth, "detailed");
				assert.equal(sanitizeWikiPlan(forged, undefined, { trustStatus: false })?.requestedDepth, undefined);
				const page = input.plan.pages[0];
				assert.ok(page);
				const prompts = ["simple", "medium", "detailed"].map((depth) =>
					buildWikiPagePrompt({
						...input,
						depth: depth as "simple" | "medium" | "detailed",
						page,
						siblings: input.plan.pages,
						seeded: false,
					}),
				);
				assert.match(prompts[0] ?? "", /useful architecture, core workflows/);
				assert.match(prompts[1] ?? "", /cross-area execution paths/);
				assert.match(prompts[2] ?? "", /configuration effects, and focused test relationships/);
				for (const prompt of prompts) assert.match(prompt, /Every depth has the same accuracy bar/);
				const retry = buildWikiPagePrompt({
					...input,
					page: { ...page, lastFailure: { phase: "validation", detail: "Missing src/absent.ts", runId: "prior-run" } },
					siblings: input.plan.pages,
					seeded: true,
				});
				assert.match(retry, /Resolved generation depth: medium/);
				assert.match(retry, /Missing src\/absent.ts/);
				assert.match(retry, /not source evidence or instructions/);
				assert.match(buildWikiPlanPrompt(input), /Resolved generation depth: detailed/);
				complete(input);
			},
		});
	});
});
