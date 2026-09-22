import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type BashScenario,
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

// The 20 MB output-cap template is exercised by the full-profile suite, not here.
function smallCorpus(seed: number, split: (typeof SPLITS)[number]): Scenario[] {
	return templatesFor("bash", "full")
		.filter((template) => !template.key.includes("20m"))
		.map((template) => generateScenario("bash", seed, split, template.key));
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

describe("tool-bench bash corpus", () => {
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
		const ids = generateCorpus("bash", DEFAULT_SEED, "search").map((scenario) => scenario.id);
		strictEqual(ids.length, 23);
		for (const id of ids) match(id, /^bash\.search\.[a-z0-9-]+$/u);
		ok(!ids.some((id) => id.includes("20m")), "the output-cap case stays out of the default profile");
	});

	/**
	 * The bench must never depend on the safety net to stop a destructive
	 * command. A scenario that removes a path is one admission change away from
	 * deleting the checkout it runs in.
	 */
	it("issues no command that removes a path or reaches the network", () => {
		for (const split of SPLITS) {
			for (const scenario of smallCorpus(DEFAULT_SEED, split) as BashScenario[]) {
				const command = scenario.args.command;
				ok(!/(^|[\s;&|(])(rm|rmdir|unlink|shred|mv|dd|mkfs|truncate)\s/u.test(command), `${scenario.id}: ${command}`);
				ok(!/(^|[\s;&|(])(curl|wget|nc|ssh|scp|git|npm|pnpm|pip)\s/u.test(command), `${scenario.id}: ${command}`);
			}
		}
	});

	/**
	 * Execute-plane calls park below full-auto. A scenario that measures what
	 * bash does has to be admitted, and the two that measure the park must not
	 * be; if that ever inverts, these scenarios stop measuring what they name.
	 */
	it("runs execution scenarios at full-auto and the parked ones at their declared autonomy", () => {
		for (const scenario of smallCorpus(DEFAULT_SEED, "search") as BashScenario[]) {
			if (scenario.template.startsWith("parked-")) {
				ok(scenario.autonomy !== "full-auto", `${scenario.id} must not be admitted`);
				continue;
			}
			strictEqual(scenario.autonomy, "full-auto", scenario.id);
		}
	});

	it("leaves the seeded input in place except where the scenario writes", () => {
		for (const scenario of smallCorpus(DEFAULT_SEED, "search")) {
			const paths = scenario.expect.files.map((entry) => entry.path);
			ok(paths.includes("data/input.txt"), `${scenario.id} must account for the seeded input`);
		}
	});

	it("matches the committed suites", () => {
		for (const suite of suitesFor("bash")) {
			const committed = readFileSync(join(SUITE_DIR, suite.file), "utf8");
			strictEqual(committed, renderSuite("bash", suite.split, suite.profile), `${suite.file} is stale; run suite-gen.ts`);
		}
	});
});

describe("tool-bench bash driver", () => {
	it("gives identical digests and fs_ops across two runs of every default scenario, and solves each", async () => {
		const first = new Map<string, { digest: string; fsOps: number }>();
		for (const pass of [0, 1]) {
			for (const scenario of generateCorpus("bash", DEFAULT_SEED, "search")) {
				const measured = await runScenario(scenario, { warmup: pass === 0 ? 1 : 0 });
				ok(measured.solved, `${scenario.id}: ${measured.errorMessage ?? "post-state or output mismatch"}`);
				if (pass === 0) {
					first.set(scenario.id, { digest: measured.digest, fsOps: measured.fsOps });
					continue;
				}
				deepStrictEqual({ digest: measured.digest, fsOps: measured.fsOps }, first.get(scenario.id), scenario.id);
			}
		}
	});

	it("changes the digest when bash drops the last line of command output", async () => {
		const scenario = generateScenario("bash", DEFAULT_SEED, "search", "read-input-64k");
		const honest = await runScenario(scenario, { warmup: 0 });
		const dropsLastLine = (original: ToolSpec): ToolSpec => ({
			...original,
			run: async (args, options): Promise<ToolResult> => {
				const result = await original.run(args, options);
				if (result.kind !== "ok") return result;
				return { ...result, output: result.output.split("\n").slice(0, -1).join("\n") };
			},
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: dropsLastLine });
		notStrictEqual(faulty.digest, honest.digest);
	});

	it("changes the digest when bash reports the wrong exit code", async () => {
		const scenario = generateScenario("bash", DEFAULT_SEED, "search", "exit-42");
		const honest = await runScenario(scenario, { warmup: 0 });
		const rewritesExitCode = (original: ToolSpec): ToolSpec => ({
			...original,
			run: async (args, options): Promise<ToolResult> => {
				const result = await original.run(args, options);
				const details = result.details as Record<string, unknown> | undefined;
				if (details?.exitCode === undefined) return result;
				return { ...result, details: { ...details, exitCode: 0 } };
			},
		});
		const faulty = await runScenario(scenario, { warmup: 0, replaceTool: rewritesExitCode });
		notStrictEqual(faulty.digest, honest.digest);
	});

	it("denies the parked call instead of running it", async () => {
		const scenario = generateScenario("bash", DEFAULT_SEED, "search", "parked-at-auto-edit");
		const measured = await runScenario(scenario, { warmup: 0 });
		ok(measured.solved, measured.errorMessage ?? "parked scenario did not hold");
		strictEqual(measured.outcome, "error");
		match(measured.errorMessage ?? "", /no operator attends this call/u);
	});
});
