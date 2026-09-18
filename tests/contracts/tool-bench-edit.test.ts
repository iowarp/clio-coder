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
	SPLITS,
	scenarioContentHash,
} from "../../evals/tool-bench/lib/corpus.js";
import { generateEditScenario } from "../../evals/tool-bench/lib/corpus-edit.js";
import { measureLine, runScenario } from "../../evals/tool-bench/lib/driver.js";
import { renderSuite, SUITE_DIR, suitesFor } from "../../evals/tool-bench/lib/suite-gen.js";
import { isRedactedArtifactKey } from "../../src/domains/eval/artifacts/redact.js";
import type { ToolSpec } from "../../src/tools/registry.js";

// The 100 MB template is exercised by the full-profile suite, not here.
const SMALL_KEYS = EDIT_TEMPLATES.filter((template) => !template.key.startsWith("size-100m")).map(
	(template) => template.key,
);

function smallCorpus(seed: number, split: (typeof SPLITS)[number]): EditScenario[] {
	return SMALL_KEYS.map((key) => generateEditScenario(seed, split, key));
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
		const one = generateEditScenario(1, "search", "size-64k-middle");
		const two = generateEditScenario(2, "search", "size-64k-middle");
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
		const ids = generateCorpus("edit", DEFAULT_SEED, "search").map((scenario) => scenario.id);
		strictEqual(ids.length, 22);
		for (const id of ids) match(id, /^edit\.search\.[a-z0-9-]+$/u);
		ok(!ids.includes("edit.search.size-100m-middle"), "the 100 MB case stays out of the default profile");
	});
});

describe("tool-bench edit suites", () => {
	it("match the generator output for the scenario table", () => {
		for (const suite of suitesFor("edit")) {
			const committed = readFileSync(join(SUITE_DIR, suite.file), "utf8");
			strictEqual(committed, renderSuite("edit", suite.split, suite.profile), `${suite.file} is stale; run suite-gen.ts`);
		}
	});
});

/**
 * The digests of the default search split as the C5a harness measured them.
 * Generalizing the harness to more tools must not move them. A deliberate
 * change to the edit tool's behavior or result text changes them too; then
 * re-measure and update this table in the same commit.
 */
const EDIT_SEARCH_DIGESTS: Readonly<Record<string, string>> = {
	"size-1k-head": "efc32698dca04496efc7016b142e91a4a8de8b7f394ab548eb57c1ab35b86305",
	"size-64k-middle": "6615689a45d8c693f8f038a57411ea98b2efaeb3852d7136b0826d6ccf6cece3",
	"size-4m-middle": "297505ec43cc23a27906661a2a58d6efcd95805ce65c3f5520bfe4411c5364f2",
	"size-16m-tail": "5d75b8d4c6b21ff98e66275e635b338262b003eb57423df2664be947a9a82676",
	"lines-short-64k": "caa7c93e48ab14de7d0a37c04b2f73674874b5c3153e39385492ad3c9b32ab53",
	"lines-long-256k": "58a2afba5ad9804ed8a951e8f3d52c2426082a2e3362563eace6e770abcae3ad",
	"single-line-256k": "7f8870b9de792ce0fc959204bc9f8312cf06ab865d829397787b46d4bc6999ec",
	"utf8-multibyte-middle": "757abe8fca4eab70cf849578cdca61fd5c007d5b2738c46a6f0d91097f27d410",
	"utf8-bom-head": "a21b95939889f442271426815fc1533b7d6ca329683c7302dda4341396963261",
	"crlf-64k-middle": "572cb87672a4d498254b0a44b3eec475994bcf75da4b9202b4ae61b90abad5e7",
	"crlf-4m-spread": "70e3042963f88190e36f62c7e1d8f41951568a0a83b980e1194bfe19dcbb5d7d",
	"density-64-256k": "fb7b4a3a843c92cf4d6110cba4e829cca8d8f93aa6385934053901ebcc6d5980",
	"density-256-900k": "7b7466669d5525eb0884bac45d8a5863e0731b7ee83201ba286609ca8727fe88",
	"density-512-4m": "b7db7a027136aa0347f4a47a975eab544592547bbcaeba4a5de380d1de4c9b27",
	"mode-755-middle": "fa773732ef03dc6a478d4834d6cc64c34076652f7f68dc3ef1afd5a0e0dba3f1",
	"symlink-middle": "d75db38c37124634500655a6ad5d8aab9934eb1bba08da23524655d86c555222",
	"err-missing-file": "80734c7895d2615da2f287b2cd4580935e173ffd0f2ed5cfd247c263ebead2ff",
	"err-no-match": "7adca157722d6f82e1a69764c9a9766e84fb16e0d05bd5f1f1c0af6416d1cebb",
	"err-ambiguous": "27e7176760baae52380c7e8544d5ba767fc5cbdc508b9165d3d5193fa9ca9bd4",
	"err-overlap": "4597871f38334695f8c0290712f555e948d42966c7f001be97b5a8ae810dfad7",
	"err-invalid-utf8": "381399524b21784e5cc3b5a271b3c60287152bb27db7d29697d9de1c647e7b5c",
	"err-mixed-eol": "b862e70ccb5b44d40b7556f51cec501b85659fc7dbbd5e005d06ef7e2d646ee2",
};

describe("tool-bench edit driver", () => {
	it("gives identical digests and fs_ops across two runs of every default scenario, and solves each", async () => {
		const first = new Map<string, { digest: string; fsOps: number }>();
		for (const pass of [0, 1]) {
			for (const scenario of generateCorpus("edit", DEFAULT_SEED, "search")) {
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

	it("keeps the digest of every default search scenario from before the harness served more tools", async () => {
		const scenarios = generateCorpus("edit", DEFAULT_SEED, "search");
		deepStrictEqual(
			scenarios.map((scenario) => scenario.template),
			Object.keys(EDIT_SEARCH_DIGESTS),
		);
		for (const scenario of scenarios) {
			const measured = await runScenario(scenario, { warmup: 0 });
			strictEqual(measured.digest, EDIT_SEARCH_DIGESTS[scenario.template], scenario.id);
		}
	});

	it("changes the digest when the edit tool drops an edit or reshapes its result", async () => {
		const scenario = generateEditScenario(DEFAULT_SEED, "search", "density-64-256k");
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
		const scenario = generateEditScenario(DEFAULT_SEED, "holdout", "err-no-match");
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
