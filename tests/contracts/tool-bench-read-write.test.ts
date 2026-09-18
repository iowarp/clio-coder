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
import { measureLine, runScenario } from "../../evals/tool-bench/lib/driver.js";
import { renderSuite, SUITE_DIR, suitesFor } from "../../evals/tool-bench/lib/suite-gen.js";
import { isRedactedArtifactKey } from "../../src/domains/eval/artifacts/redact.js";
import type { ToolSpec } from "../../src/tools/registry.js";

const TOOLS = ["read", "write"] as const;
const DEFAULT_COUNTS = { read: 21, write: 16 } as const;

/**
 * Scenarios that expect a refusal the tool path does not give yet. Each stays
 * in its suite and reads unsolved. When the gap closes this test fails, and
 * the entry comes out.
 */
const KNOWN_GAPS = new Set(["write.search.err-symlink-escape"]);

// The 100 MB templates are exercised by the full-profile suites, not here.
function smallCorpus(tool: (typeof TOOLS)[number], seed: number, split: (typeof SPLITS)[number]): Scenario[] {
	return templatesFor(tool, "full")
		.filter((template) => !template.key.includes("100m"))
		.map((template) => generateScenario(tool, seed, split, template.key));
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

for (const tool of TOOLS) {
	describe(`tool-bench ${tool} corpus`, () => {
		it("is byte-identical for the same seed and split", () => {
			for (const split of SPLITS) {
				const first = smallCorpus(tool, DEFAULT_SEED, split);
				const second = smallCorpus(tool, DEFAULT_SEED, split);
				for (const [index, scenario] of first.entries()) {
					const again = second[index] as Scenario;
					strictEqual(scenarioContentHash(scenario), scenarioContentHash(again), scenario.id);
					deepStrictEqual(scenario.args, again.args);
					deepStrictEqual(scenario.expect, again.expect);
				}
			}
		});

		it("keeps the search and holdout splits disjoint in ids, scenario hashes, and file contents", () => {
			const search = smallCorpus(tool, DEFAULT_SEED, "search");
			const holdout = smallCorpus(tool, DEFAULT_SEED, "holdout");
			const searchIds = new Set(search.map((scenario) => scenario.id));
			for (const scenario of holdout) ok(!searchIds.has(scenario.id), scenario.id);
			const searchHashes = new Set(search.map(scenarioContentHash));
			for (const scenario of holdout) ok(!searchHashes.has(scenarioContentHash(scenario)), scenario.id);
			const searchFiles = fileHashes(search);
			for (const hash of fileHashes(holdout)) ok(!searchFiles.has(hash), hash);
			strictEqual(searchHashes.size, search.length, "scenario hashes are unique within a split");
		});

		it("changes content with the seed and keeps ids stable", () => {
			const key = tool === "read" ? "size-64k-head" : "create-nested-64k";
			const one = generateScenario(tool, 1, "search", key);
			const two = generateScenario(tool, 2, "search", key);
			strictEqual(one.id, two.id);
			notStrictEqual(scenarioContentHash(one), scenarioContentHash(two));
		});

		it("covers the default profile with ids that name tool, split, and template", () => {
			const ids = generateCorpus(tool, DEFAULT_SEED, "search").map((scenario) => scenario.id);
			strictEqual(ids.length, DEFAULT_COUNTS[tool]);
			for (const id of ids) match(id, new RegExp(`^${tool}\\.search\\.[a-z0-9-]+$`, "u"));
			ok(!ids.some((id) => id.includes("100m")), "the 100 MB cases stay out of the default profile");
		});
	});

	describe(`tool-bench ${tool} suites`, () => {
		it("match the generator output for the scenario table", () => {
			for (const suite of suitesFor(tool)) {
				const committed = readFileSync(join(SUITE_DIR, suite.file), "utf8");
				strictEqual(committed, renderSuite(tool, suite.split, suite.profile), `${suite.file} is stale; run suite-gen.ts`);
			}
		});
	});
}

describe("tool-bench read corpus expectations", () => {
	it("expects every read to leave the scratch root as it found it", () => {
		for (const scenario of smallCorpus("read", DEFAULT_SEED, "search")) {
			const before = scenario.files
				.map((entry) =>
					entry.kind === "file"
						? {
								kind: "file",
								path: entry.path,
								size: entry.bytes.length,
								sha256: createHash("sha256").update(entry.bytes).digest("hex"),
								mode: entry.mode,
							}
						: entry,
				)
				.sort((left, right) => left.path.localeCompare(right.path));
			deepStrictEqual(scenario.expect.files, before, scenario.id);
		}
	});
});

describe("tool-bench read and write driver", () => {
	it("gives identical digests and fs_ops across two runs of every default scenario, and solves each outside the known gaps", async () => {
		const first = new Map<string, { digest: string; fsOps: number }>();
		for (const pass of [0, 1]) {
			for (const tool of TOOLS) {
				for (const scenario of generateCorpus(tool, DEFAULT_SEED, "search")) {
					const measured = await runScenario(scenario, { warmup: 1 });
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
		}
	});

	it("records a parked escape as an error and a symlink escape as a write outside the scratch root", async () => {
		const parked = await runScenario(generateScenario("write", DEFAULT_SEED, "search", "err-escape"), { warmup: 0 });
		strictEqual(parked.outcome, "error");
		strictEqual(parked.errorClass, "Error");
		ok((parked.behavior as { parked?: unknown }).parked !== undefined, "admission parked the call");
		strictEqual(parked.solved, true);

		const escaped = await runScenario(generateScenario("write", DEFAULT_SEED, "search", "err-symlink-escape"), {
			warmup: 0,
		});
		const outside = (escaped.behavior as { outside?: Array<{ path: string }> }).outside;
		deepStrictEqual(
			outside?.map((entry) => entry.path),
			["escape.txt"],
		);
		strictEqual(escaped.solved, false);
	});

	it("changes the digest when read drops the last line of its window", async () => {
		const scenario = generateScenario("read", DEFAULT_SEED, "search", "size-64k-head");
		const honest = await runScenario(scenario, { warmup: 0 });
		const dropsLastLine = (original: ToolSpec): ToolSpec => ({
			...original,
			run: (args, options) => original.run({ ...args, limit: (args.limit as number) - 1 }, options),
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: dropsLastLine });
		notStrictEqual(faulty.digest, honest.digest);
		strictEqual(faulty.solved, false, "the window's last sentinel is missing");
	});

	it("changes the digest when write skips the final byte", async () => {
		const scenario = generateScenario("write", DEFAULT_SEED, "search", "create-1k");
		const honest = await runScenario(scenario, { warmup: 0 });
		const skipsFinalByte = (original: ToolSpec): ToolSpec => ({
			...original,
			run: (args, options) => original.run({ ...args, content: (args.content as string).slice(0, -1) }, options),
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: skipsFinalByte });
		notStrictEqual(faulty.digest, honest.digest);
		strictEqual(faulty.solved, false);
	});

	it("emits only keys and values the eval measure channel admits", async () => {
		for (const tool of TOOLS) {
			const scenario = generateScenario(tool, DEFAULT_SEED, "holdout", "err-directory");
			const measured = await runScenario(scenario, { warmup: 0 });
			const line = JSON.parse(measureLine(measured, scenario, 0)) as { schema: string; metrics: Record<string, unknown> };
			strictEqual(line.schema, "clio-coder.eval.measure.v1");
			strictEqual(Object.keys(line.metrics).length, 9);
			for (const [key, value] of Object.entries(line.metrics)) {
				// The admission rules at src/domains/eval/suites/run.ts:496-517.
				ok(key.startsWith("custom.") && /^[A-Za-z0-9._-]{1,128}$/u.test(key), key);
				ok(!isRedactedArtifactKey(key), key);
				if (key.startsWith("custom.digest.")) match(String(value), /^[0-9a-f]{64}$/u);
				else ok(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), key);
			}
			strictEqual(line.metrics["custom.corpus.holdout"], true);
			strictEqual(measured.outcome, "error");
		}
	});
});
