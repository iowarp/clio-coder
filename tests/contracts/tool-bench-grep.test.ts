import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_SEED,
	generateCorpus,
	generateScenario,
	type Scenario,
	SPLITS,
	scenarioContentHash,
	templatesFor,
} from "../../evals/tool-bench/lib/corpus.js";
import { runScenario } from "../../evals/tool-bench/lib/driver.js";
import { renderSuite, SUITE_DIR, suitesFor } from "../../evals/tool-bench/lib/suite-gen.js";
import type { ToolResult, ToolSpec } from "../../src/tools/registry.js";

/**
 * Scenarios that expect behavior the tool path does not give yet. Each stays
 * in its suite and reads unsolved. When a gap closes this test fails, and the
 * entry comes out. invalid-utf8: rg reports a line that is not UTF-8 as bytes,
 * and grep drops the match.
 */
const KNOWN_GAPS = new Set(["grep.search.invalid-utf8"]);

// The 100 MB and 50 000 file templates are exercised by the full-profile suites, not here.
function smallCorpus(seed: number, split: (typeof SPLITS)[number]): Scenario[] {
	return templatesFor("grep", "full")
		.filter((template) => !template.key.includes("100m") && !template.key.includes("50k"))
		.map((template) => generateScenario("grep", seed, split, template.key));
}

function fileHashes(scenarios: readonly Scenario[]): Set<string> {
	const out = new Set<string>();
	for (const scenario of scenarios) {
		for (const entry of scenario.files) {
			if (entry.kind === "file" && entry.bytes.length > 0) out.add(createHash("sha256").update(entry.bytes).digest("hex"));
		}
	}
	return out;
}

describe("tool-bench grep corpus", () => {
	it("is byte-identical for the same seed and split", () => {
		for (const split of SPLITS) {
			const first = smallCorpus(DEFAULT_SEED, split);
			const second = smallCorpus(DEFAULT_SEED, split);
			for (const [index, scenario] of first.entries()) {
				const again = second[index] as Scenario;
				strictEqual(scenarioContentHash(scenario), scenarioContentHash(again), scenario.id);
				deepStrictEqual(scenario.args, again.args);
				deepStrictEqual(scenario.expect, again.expect);
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

	it("covers the default profile with ids that name tool, split, and template", () => {
		const ids = generateCorpus("grep", DEFAULT_SEED, "search").map((scenario) => scenario.id);
		strictEqual(ids.length, 17);
		for (const id of ids) match(id, /^grep\.search\.[a-z0-9-]+$/u);
		ok(!ids.some((id) => id.includes("100m") || id.includes("50k")), "the largest cases stay out of the default profile");
	});

	it("expects every search to leave the scratch root as it found it", () => {
		for (const scenario of smallCorpus(DEFAULT_SEED, "search")) {
			const written = scenario.files.filter((entry) => entry.kind !== "dir").length;
			strictEqual(scenario.expect.files.length, written, scenario.id);
		}
	});

	it("matches the committed suites", () => {
		for (const suite of suitesFor("grep")) {
			const committed = readFileSync(join(SUITE_DIR, suite.file), "utf8");
			strictEqual(committed, renderSuite("grep", suite.split, suite.profile), `${suite.file} is stale; run suite-gen.ts`);
		}
	});
});

describe("tool-bench grep driver", () => {
	it("gives identical digests and fs_ops across two runs of every default scenario, and solves each outside the known gaps", async () => {
		const first = new Map<string, { digest: string; fsOps: number }>();
		for (const pass of [0, 1]) {
			for (const scenario of generateCorpus("grep", DEFAULT_SEED, "search")) {
				const measured = await runScenario(scenario, { warmup: pass === 0 ? 1 : 0 });
				strictEqual(
					measured.solved,
					!KNOWN_GAPS.has(scenario.id),
					`${scenario.id}: ${measured.errorMessage ?? "post-state or output mismatch"}`,
				);
				if (pass === 0) {
					first.set(scenario.id, { digest: measured.digest, fsOps: measured.fsOps });
					continue;
				}
				deepStrictEqual({ digest: measured.digest, fsOps: measured.fsOps }, first.get(scenario.id), scenario.id);
			}
		}
	});

	it("changes the digest when grep drops the last match", async () => {
		const scenario = generateScenario("grep", DEFAULT_SEED, "search", "regex-100");
		const honest = await runScenario(scenario, { warmup: 0 });
		const dropsLastMatch = (original: ToolSpec): ToolSpec => ({
			...original,
			run: async (args, options): Promise<ToolResult> => {
				const result = await original.run(args, options);
				if (result.kind !== "ok") return result;
				const lines = result.output.split("\n");
				let last = lines.length - 1;
				while (last >= 0 && !/:\d+: /u.test(lines[last] as string)) last -= 1;
				return { ...result, output: lines.filter((_, index) => index !== last).join("\n") };
			},
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: dropsLastMatch });
		notStrictEqual(faulty.digest, honest.digest);
		strictEqual(faulty.solved, false, "one expected match is missing");
	});
});
