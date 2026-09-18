import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_SEED,
	EDIT_TEMPLATES,
	type EditScenario,
	generateCorpus,
	generateScenario,
	SPLITS,
	scenarioContentHash,
} from "../../evals/tool-bench/lib/corpus.js";
import { measureLine, runScenario } from "../../evals/tool-bench/lib/driver.js";
import { EDIT_SUITES, renderEditSuite, SUITE_DIR } from "../../evals/tool-bench/lib/suite-gen.js";
import { isRedactedArtifactKey } from "../../src/domains/eval/artifacts/redact.js";
import type { ToolSpec } from "../../src/tools/registry.js";

// The 100 MB template is exercised by the full-profile suite, not here.
const SMALL_KEYS = EDIT_TEMPLATES.filter((template) => !template.key.startsWith("size-100m")).map(
	(template) => template.key,
);

function smallCorpus(seed: number, split: (typeof SPLITS)[number]): EditScenario[] {
	return SMALL_KEYS.map((key) => generateScenario(seed, split, key));
}

function fileHashes(scenarios: readonly EditScenario[]): Set<string> {
	const out = new Set<string>();
	for (const scenario of scenarios) {
		for (const entry of scenario.files) {
			if (entry.kind === "file") out.add(createHash("sha256").update(entry.bytes).digest("hex"));
		}
	}
	return out;
}

describe("tool-bench edit corpus", () => {
	it("is byte-identical for the same seed and split", () => {
		for (const split of SPLITS) {
			const first = smallCorpus(DEFAULT_SEED, split);
			const second = smallCorpus(DEFAULT_SEED, split);
			strictEqual(first.length, second.length);
			for (const [index, scenario] of first.entries()) {
				const again = second[index] as EditScenario;
				strictEqual(scenarioContentHash(scenario), scenarioContentHash(again));
				deepStrictEqual(scenario.args, again.args);
				deepStrictEqual(scenario.expect, again.expect);
				for (const [fileIndex, entry] of scenario.files.entries()) {
					const other = again.files[fileIndex];
					if (entry.kind === "file" && other?.kind === "file")
						ok(entry.bytes.equals(other.bytes), `${scenario.id} ${entry.path}`);
					else deepStrictEqual(entry, other);
				}
			}
		}
	});

	it("keeps the search and holdout splits disjoint in ids, scenario hashes, and file contents", () => {
		const search = smallCorpus(DEFAULT_SEED, "search");
		const holdout = smallCorpus(DEFAULT_SEED, "holdout");
		const searchIds = new Set(search.map((scenario) => scenario.id));
		for (const scenario of holdout) ok(!searchIds.has(scenario.id), scenario.id);
		const searchHashes = new Set(search.map(scenarioContentHash));
		for (const scenario of holdout) ok(!searchHashes.has(scenarioContentHash(scenario)), scenario.id);
		const searchFiles = fileHashes(search);
		for (const hash of fileHashes(holdout)) ok(!searchFiles.has(hash), hash);
		strictEqual(searchHashes.size, search.length, "scenario hashes are unique within a split");
	});

	it("changes content with the seed and keeps ids stable", () => {
		const one = generateScenario(1, "search", "size-64k-middle");
		const two = generateScenario(2, "search", "size-64k-middle");
		strictEqual(one.id, two.id);
		notStrictEqual(scenarioContentHash(one), scenarioContentHash(two));
	});

	it("expects a changed file for every ok scenario and an untouched one for every error path", () => {
		for (const scenario of smallCorpus(DEFAULT_SEED, "search")) {
			const target = scenario.files.find((entry) => entry.kind === "file");
			const expected = scenario.expect.files.find((entry) => entry.kind === "file");
			ok(target?.kind === "file" && expected?.kind === "file", scenario.id);
			const before = createHash("sha256").update(target.bytes).digest("hex");
			if (scenario.expect.outcome === "ok") notStrictEqual(expected.sha256, before, scenario.id);
			else strictEqual(expected.sha256, before, scenario.id);
		}
	});

	it("covers the default profile with ids that name tool, split, and template", () => {
		const ids = generateCorpus(DEFAULT_SEED, "search").map((scenario) => scenario.id);
		strictEqual(ids.length, 22);
		for (const id of ids) match(id, /^edit\.search\.[a-z0-9-]+$/u);
		ok(!ids.includes("edit.search.size-100m-middle"), "the 100 MB case stays out of the default profile");
	});
});

describe("tool-bench edit suites", () => {
	it("match the generator output for the scenario table", () => {
		for (const suite of EDIT_SUITES) {
			const committed = readFileSync(join(SUITE_DIR, suite.file), "utf8");
			strictEqual(committed, renderEditSuite(suite.split, suite.profile), `${suite.file} is stale; run suite-gen.ts`);
		}
	});
});

describe("tool-bench edit driver", () => {
	it("gives identical digests and fs_ops across two runs of every default scenario, and solves each", async () => {
		const first = new Map<string, { digest: string; fsOps: number }>();
		for (const pass of [0, 1]) {
			for (const scenario of generateCorpus(DEFAULT_SEED, "search")) {
				const measured = await runScenario(scenario, { warmup: 1 });
				strictEqual(measured.solved, true, `${scenario.id}: ${measured.errorMessage ?? "post-state mismatch"}`);
				if (pass === 0) {
					first.set(scenario.id, { digest: measured.digest, fsOps: measured.fsOps });
					continue;
				}
				deepStrictEqual({ digest: measured.digest, fsOps: measured.fsOps }, first.get(scenario.id), scenario.id);
			}
		}
	});

	it("changes the digest when the edit tool drops an edit or reshapes its result", async () => {
		const scenario = generateScenario(DEFAULT_SEED, "search", "density-64-256k");
		const honest = await runScenario(scenario, { warmup: 0 });
		const dropsLastEdit = (original: ToolSpec): ToolSpec => ({
			...original,
			run: (args, options) => original.run({ ...args, edits: (args.edits as unknown[]).slice(0, -1) }, options),
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: dropsLastEdit });
		notStrictEqual(faulty.digest, honest.digest);
		strictEqual(faulty.solved, false);

		const rewordsOutput = (original: ToolSpec): ToolSpec => ({
			...original,
			run: async (args, options) => {
				const result = await original.run(args, options);
				return result.kind === "ok" ? { ...result, output: `${result.output} ` } : result;
			},
		});
		const reshaped = await runScenario(scenario, { warmup: 0, replaceTool: rewordsOutput });
		notStrictEqual(reshaped.digest, honest.digest);
		strictEqual(reshaped.solved, true, "the file state is right; only the shaped result differs");
	});

	it("emits only keys and values the eval measure channel admits", async () => {
		const scenario = generateScenario(DEFAULT_SEED, "holdout", "err-no-match");
		const measured = await runScenario(scenario, { warmup: 0 });
		const line = JSON.parse(measureLine(measured, scenario, 0)) as { schema: string; metrics: Record<string, unknown> };
		strictEqual(line.schema, "clio-coder.eval.measure.v1");
		for (const key of [
			"custom.latency.wall_ms",
			"custom.counters.fs_ops",
			"custom.memory.max_rss_kb",
			"custom.cpu.user_ms",
			"custom.cpu.system_ms",
			"custom.digest.behavior",
		]) {
			ok(key in line.metrics, key);
		}
		for (const [key, value] of Object.entries(line.metrics)) {
			// The admission rules at src/domains/eval/suites/run.ts:496-517.
			ok(key.startsWith("custom.") && /^[A-Za-z0-9._-]{1,128}$/u.test(key), key);
			ok(!isRedactedArtifactKey(key), key);
			if (key.startsWith("custom.digest.")) match(String(value), /^[0-9a-f]{64}$/u);
			else ok(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), key);
		}
		strictEqual(line.metrics["custom.corpus.holdout"], true);
		strictEqual(measured.outcome, "error");
		strictEqual(measured.errorClass, "Error");
	});
});
