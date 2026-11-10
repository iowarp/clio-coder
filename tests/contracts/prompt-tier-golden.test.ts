import { strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import {
	type CompileInputs,
	compile,
	compileWorker,
	type WorkerPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";

/**
 * The six prompt tiers (attended and headless at default and yolo, the coder
 * and scout workers) compiled from inputs captured off live sessions. The
 * expected text was produced by the compiler before fragment preconditions
 * existed; a change that moves a byte of any tier fails here.
 * `CLIO_PROMPT_GOLDEN=update` rewrites the expected files.
 */
const dir = fileURLToPath(new URL("../fixtures/prompt-tiers/", import.meta.url));
const tiers = readdirSync(dir)
	.filter((name) => name.endsWith(".inputs.json"))
	.map((name) => name.slice(0, -".inputs.json".length))
	.sort();
const homeEnv = {
	CLIO_CODER_CONFIG_DIR: "/clio-home/config",
	CLIO_CODER_DATA_DIR: "/clio-home/data",
	CLIO_CODER_STATE_DIR: "/clio-home/state",
	CLIO_CODER_CACHE_DIR: "/clio-home/cache",
};
const saved: Record<string, string | undefined> = {};

type Tier = { kind: "session"; inputs: CompileInputs } | { kind: "worker"; inputs: WorkerPromptInputs };

describe("prompt tiers", () => {
	before(() => {
		for (const [key, value] of Object.entries(homeEnv)) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
	});
	after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("has the six tiers", () => {
		strictEqual(
			tiers.join(","),
			"attended-default,attended-yolo,headless-default,headless-yolo,worker-coder,worker-scout",
		);
	});

	for (const name of tiers) {
		it(`compiles ${name} byte-identical to its golden prompt`, () => {
			const tier = JSON.parse(readFileSync(join(dir, `${name}.inputs.json`), "utf8")) as Tier;
			const table = loadFragments();
			const compiled = tier.kind === "session" ? compile(table, tier.inputs) : compileWorker(table, tier.inputs);
			const actual = compiled.systemPrompt.split(resolvePackageRoot()).join("<package-root>");
			const expectedPath = join(dir, `${name}.txt`);
			if (process.env.CLIO_PROMPT_GOLDEN === "update") writeFileSync(expectedPath, actual);
			strictEqual(actual, readFileSync(expectedPath, "utf8"));
		});
	}
});
