import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import {
	type CompileInputs,
	compile,
	compileWorker,
	PROMPT_BUDGET_CHARS,
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

describe("prompts.profile v2 (S-82)", () => {
	const session = (name: string, extra: Record<string, unknown> = {}) => {
		const tier = JSON.parse(readFileSync(join(dir, `${name}.inputs.json`), "utf8")) as Tier;
		if (tier.kind !== "session") throw new Error(`${name} is not a session tier`);
		const inputs = { ...tier.inputs, sessionInputs: { ...tier.inputs.sessionInputs, promptProfile: "v2", ...extra } };
		return compile(loadFragments(), inputs as CompileInputs);
	};

	it("fits the D-02 size bounds on the reference fixture", () => {
		const attended = session("attended-default").systemPrompt.length;
		const headless = session("headless-default").systemPrompt.length;
		ok(attended <= 26_000, `attended ${attended}`);
		ok(headless <= 19_000, `headless ${headless}`);
	});

	it("stays within PROMPT_BUDGET_CHARS per tier (S-87)", () => {
		const check = (tier: string, name: string, budget: number) => {
			const compiled = session(name);
			const size = compiled.systemPrompt.length;
			const breakdown = compiled.sections.map((section) => `${section.id}~${section.tokenEstimate}t`).join(", ");
			ok(size <= budget, `${tier} ${size} > ${budget}: ${breakdown}`);
		};
		check("attended", "attended-default", PROMPT_BUDGET_CHARS.attended);
		check("headless", "headless-default", PROMPT_BUDGET_CHARS.headless);
	});

	it("compact profile drops map examples under a 48k window (S-87)", () => {
		const full = session("attended-default", { contextWindow: 200_000 }).systemPrompt;
		const compact = session("attended-default", { contextWindow: 32_768 }).systemPrompt;
		ok(compact.length < full.length, `${compact.length} < ${full.length}`);
		const start = compact.indexOf("## Capability map");
		const map = compact.slice(start, compact.indexOf("\n\n", start + 20));
		ok(map.length > 0 && !map.includes('args={"') && !map.includes("Example:"), map);
	});

	it("lays sections in the D-02 order and drops the v1 core fragments", () => {
		const compiled = session("attended-default");
		const ids = compiled.sections.map((section) => section.id);
		const order = ["identity", "operating-contract", "harness", "tool-contract", "safety", "operator"];
		deepStrictEqual(
			ids.filter((id) => order.includes(id)),
			order,
		);
		const manifest = compiled.fragmentManifest.map((fragment) => fragment.id);
		for (const gone of [
			"identity.clio",
			"identity.clio-attended",
			"identity.self-awareness-attended",
			"operating.contract",
			"operating.contract-attended",
			"operating.user-control",
			"operating.coordinator",
			"operating.discovered-skills",
		])
			ok(!manifest.includes(gone), gone);
		for (const name of ["attended-default", "attended-yolo", "headless-default", "headless-yolo"]) {
			const text = session(name).systemPrompt;
			for (const banned of ["If you want", "Offer setup", "## Ending a turn", "# Demo guidance"])
				ok(!text.includes(banned), `${name}: ${banned}`);
		}
	});

	it("renders each harness row only with its capability", () => {
		const base = session("attended-default").systemPrompt;
		const rows: Record<string, string> = {
			job: "create a `job` that polls",
			decide: "record it with `decide`",
			tasks: "on the `tasks` board",
		};
		for (const [tool, text] of Object.entries(rows)) {
			const tier = JSON.parse(readFileSync(join(dir, "attended-default.inputs.json"), "utf8")) as Tier;
			if (tier.kind !== "session") throw new Error("not a session tier");
			const without = session("attended-default", {
				toolNames: (tier.inputs.sessionInputs.toolNames ?? []).filter((name) => name !== tool),
				coordinatorCapabilities: tier.inputs.sessionInputs.coordinatorCapabilities.filter((name) => name !== tool),
				...(tier.inputs.sessionInputs.capabilityMap
					? { capabilityMap: tier.inputs.sessionInputs.capabilityMap.filter((entry) => entry.tool !== tool) }
					: {}),
			}).systemPrompt;
			ok(base.includes(text), `${tool} row missing`);
			ok(!without.includes(text), `${tool} row survives without ${tool}`);
		}
	});
});
