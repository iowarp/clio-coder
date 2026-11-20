import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { controlInstructions, settingControl } from "../../src/core/settings-controls.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";
import { settingsChangeKind } from "../../src/domains/config/classify.js";
import {
	type CompileInputs,
	compile,
	compileWorker,
	PROMPT_BUDGET_CHARS,
	type WorkerPromptInputs,
	workerSafetyOneLiner,
} from "../../src/domains/prompts/compiler.js";
import { type FragmentTable, loadFragments } from "../../src/domains/prompts/fragment-loader.js";

/**
 * The prompt tiers (attended and headless at default and yolo, the coder and
 * scout workers) compiled from inputs captured off live sessions, plus an ACP
 * session with no sandbox and semantic search on, so that wording gated on
 * those conditions is pinned too. A change that moves a byte of any tier fails
 * here; tests/contracts/prompt-section-matrix.test.ts pins which sections each
 * condition renders.
 * `CLIO_PROMPT_GOLDEN=update` rewrites the expected files. A worker persona
 * is read from its shipped recipe, so an edit to coder.md or scout.md moves
 * the golden; the fixture keeps only the bound-skill block dispatch appends.
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
type PersonaFixture = Omit<NonNullable<WorkerPromptInputs["persona"]>, "body" | "contentHash"> & {
	boundSkillBlock?: string;
};

function loadTier(name: string): Tier {
	const tier = JSON.parse(readFileSync(join(dir, `${name}.inputs.json`), "utf8")) as
		| { kind: "session"; inputs: CompileInputs }
		| { kind: "worker"; inputs: Omit<WorkerPromptInputs, "persona"> & { persona: PersonaFixture } };
	if (tier.kind === "session") return tier;
	const { boundSkillBlock = "", ...persona } = tier.inputs.persona;
	const source = join(resolvePackageRoot(), persona.relPath.replace(/^\/clio-coder\//u, ""));
	const recipe = parseFrontmatter(readFileSync(source, "utf8"), source).body;
	const body = [recipe, boundSkillBlock].filter((part) => part.trim().length > 0).join("\n\n");
	const contentHash = createHash("sha256").update(body).digest("hex");
	return { kind: "worker", inputs: { ...tier.inputs, persona: { ...persona, body, contentHash } } };
}

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

	it("has the seven tiers", () => {
		strictEqual(
			tiers.join(","),
			"acp-unsandboxed,attended-default,attended-yolo,headless-default,headless-yolo,worker-coder,worker-scout",
		);
	});

	for (const name of tiers) {
		it(`compiles ${name} byte-identical to its golden prompt`, () => {
			const tier = loadTier(name);
			const table = loadFragments();
			const compiled = tier.kind === "session" ? compile(table, tier.inputs) : compileWorker(table, tier.inputs);
			const actual = compiled.systemPrompt.split(resolvePackageRoot()).join("<package-root>");
			const expectedPath = join(dir, `${name}.txt`);
			if (process.env.CLIO_PROMPT_GOLDEN === "update") writeFileSync(expectedPath, actual);
			strictEqual(actual, readFileSync(expectedPath, "utf8"));
		});
	}
});

describe("read-only worker authority line (D-C)", () => {
	const promise = /workspace edits and recognized commands run/;
	const worker = (name: string, extra: Partial<WorkerPromptInputs> = {}) => {
		const tier = loadTier(name);
		if (tier.kind !== "worker") throw new Error(`${name} is not a worker tier`);
		return compileWorker(loadFragments(), { ...tier.inputs, ...extra }).systemPrompt;
	};

	it("a read-only run is not promised workspace edits; any other worker's line is unchanged", () => {
		const readOnly = worker("worker-scout");
		ok(readOnly.includes("# Read-only run"));
		ok(!promise.test(readOnly), "a read-only run must not be told workspace edits run");
		match(
			readOnly,
			/workspace edits are not permitted in this run; read-only inspection runs; other commands require approval\./,
		);
		ok(promise.test(worker("worker-scout", { readOnly: false })));
		ok(promise.test(worker("worker-coder")));
		strictEqual(
			workerSafetyOneLiner("deny"),
			"workspace edits and recognized commands run; other commands require approval. Approval-required calls are denied immediately; they are not parked for an operator.",
		);
	});
});

describe("prompts.profile v2 (S-82)", () => {
	const session = (name: string, extra: Record<string, unknown> = {}) => {
		const tier = loadTier(name);
		if (tier.kind !== "session") throw new Error(`${name} is not a session tier`);
		const inputs = { ...tier.inputs, sessionInputs: { ...tier.inputs.sessionInputs, promptProfile: "v2", ...extra } };
		return compile(loadFragments(), inputs as CompileInputs);
	};

	// The prompt names the package root and the live Clio home, which vary with the checkout and the test's
	// TMPDIR. Sizes are measured as if installed at fixed paths so the bounds check the prompt, not the host.
	const installedSize = (text: string) => {
		const dirs = resolveClioDirs();
		const paths: Array<[string, string]> = [
			[dirs.config, "/home/user/.config/clio-coder"],
			[dirs.state, "/home/user/.local/state/clio-coder"],
			[resolvePackageRoot(), "/usr/local/lib/node_modules/@iowarp/clio-coder"],
		];
		return paths.reduce((acc, [host, fixed]) => acc.split(host).join(fixed), text).length;
	};

	it("fits the D-02 size bounds on the reference fixture", () => {
		const attended = installedSize(session("attended-default").systemPrompt);
		const headless = installedSize(session("headless-default").systemPrompt);
		ok(attended <= 26_000, `attended ${attended}`);
		ok(headless <= 19_000, `headless ${headless}`);
	});

	// ACP is the attended surface without the TUI: no operator interviews unless the client offers them.
	const budgets = [
		["attended-default", PROMPT_BUDGET_CHARS.attended],
		["attended-yolo", PROMPT_BUDGET_CHARS.attended],
		["acp", PROMPT_BUDGET_CHARS.acp],
		["headless-default", PROMPT_BUDGET_CHARS.headless],
		["headless-yolo", PROMPT_BUDGET_CHARS.headlessYolo],
		["worker-coder", PROMPT_BUDGET_CHARS.worker],
		["worker-scout", PROMPT_BUDGET_CHARS.worker],
	] as const;
	const budgetCompile = (table: FragmentTable, name: string) => {
		const tier = loadTier(name === "acp" ? "attended-default" : name);
		if (tier.kind === "worker") return compileWorker(table, { ...tier.inputs, promptProfile: "v2" });
		const {
			operatorInterviews: _interviews,
			demo: _demo,
			terminal: _terminal,
			...sessionInputs
		} = tier.inputs.sessionInputs;
		return compile(table, {
			...tier.inputs,
			sessionInputs: { ...(name === "acp" ? sessionInputs : tier.inputs.sessionInputs), promptProfile: "v2" },
		});
	};
	const overBudget = (table: FragmentTable) =>
		budgets.flatMap(([name, budget]) => {
			const compiled = budgetCompile(table, name);
			const size = installedSize(compiled.systemPrompt);
			const breakdown = compiled.sections.map((section) => `${section.id}~${section.tokenEstimate}t`).join(", ");
			return size > budget ? [`${name} ${size} > ${budget}: ${breakdown}`] : [];
		});

	it("stays within PROMPT_BUDGET_CHARS per tier", () => {
		deepStrictEqual(overBudget(loadFragments()), []);
	});

	it("fails the session budgets when any rendered fragment grows by 1,000 characters", () => {
		const table = loadFragments();
		const sessionTiers = ["attended-default", "attended-yolo", "acp", "headless-default", "headless-yolo"];
		const rendered = new Set(
			sessionTiers.flatMap((name) =>
				budgetCompile(table, name).fragmentManifest.flatMap((entry) => (entry.dynamic ? [] : [entry.id])),
			),
		);
		let grown = 0;
		for (const id of rendered) {
			const fragment = table.byId.get(id);
			if (fragment === undefined) continue;
			const byId = new Map(table.byId).set(id, { ...fragment, body: `${fragment.body}\n${"x".repeat(1_000)}` });
			const bigger = { ...table, byId };
			const changed = sessionTiers.some(
				(name) => budgetCompile(bigger, name).systemPrompt !== budgetCompile(table, name).systemPrompt,
			);
			if (!changed) continue;
			grown++;
			ok(overBudget(bigger).length > 0, `${id} grew by 1,000 characters within every budget`);
		}
		ok(grown >= 5, `${grown} fragments checked`);
	});

	it("gives Mermaid drawing guidance only to a terminal session", () => {
		const mermaid = "a Mermaid fence draws as a diagram only when it fits the screen width";
		ok(session("attended-default", { terminal: true }).systemPrompt.includes(mermaid), "terminal");
		ok(!session("attended-default", { terminal: false }).systemPrompt.includes(mermaid), "ACP or GUI");
		ok(!session("headless-default").systemPrompt.includes(mermaid), "headless");
	});

	it("says when a profile change applies the way the classifier applies it", () => {
		const control = settingControl("prompts.profile");
		ok(control !== undefined);
		strictEqual(settingsChangeKind("prompts.profile"), "nextTurn");
		const text = controlInstructions(control);
		ok(text.includes("next turn") && !text.includes("next session"), text);
	});

	it("tells only a session with `job` in its map to wait through a job (S-89)", () => {
		const jobWait = "Once the job exists, end your turn";
		const bashWait = "cannot own a job, so there wait inside one bash call";
		for (const confinement of [{}, { yoloConfinement: "unconfined" }]) {
			const headless = session("headless-yolo", confinement).systemPrompt;
			ok(!headless.includes(jobWait) && !headless.includes("with a `job` through the gateway"), "headless");
			ok(headless.includes(bashWait), "headless keeps the bash wait");
			ok(session("attended-yolo", confinement).systemPrompt.includes(jobWait), "attended");
		}
	});

	it("compact profile drops map examples under a 48k window (S-87)", () => {
		const full = session("attended-default", { contextWindow: 200_000 }).systemPrompt;
		const compact = session("attended-default", { contextWindow: 32_768 }).systemPrompt;
		ok(compact.length < full.length, `${compact.length} < ${full.length}`);
		const start = compact.indexOf("## Capability map");
		const map = compact.slice(start, compact.indexOf("\n\n", start + 20));
		ok(map.length > 0 && !map.includes('args={"') && !map.includes("Example:"), map);
	});

	it("keeps the shell last and the check after the last edit", () => {
		const text = session("headless-default").systemPrompt;
		ok(text.includes("Run a shell command only when no listed tool fits."), "shell-last rule");
		ok(text.includes("After your last edit, run the"), "check after the last edit");
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
		const baseV1 = session("attended-default", { promptProfile: "v1" }).systemPrompt;
		ok(base.includes("- Finding code, never through the shell:"), "finding-code row");
		const rows: Record<string, string> = {
			job: "create a `job` that polls",
			decide: "record it with `decide`",
			tasks: "on the `tasks` board",
			code_nav: "`code_nav` for a symbol",
			grep: "`grep` tool for text",
			read: "`read` the region with `line_numbers: true` if",
		};
		for (const [tool, text] of Object.entries(rows)) {
			const tier = loadTier("attended-default");
			if (tier.kind !== "session") throw new Error("not a session tier");
			const surfaceWithout = {
				toolNames: (tier.inputs.sessionInputs.toolNames ?? []).filter((name) => name !== tool),
				coordinatorCapabilities: tier.inputs.sessionInputs.coordinatorCapabilities.filter((name) => name !== tool),
				...(tier.inputs.sessionInputs.capabilityMap
					? { capabilityMap: tier.inputs.sessionInputs.capabilityMap.filter((entry) => entry.tool !== tool) }
					: {}),
			};
			const without = session("attended-default", surfaceWithout).systemPrompt;
			ok(base.includes(text), `${tool} row missing`);
			ok(!without.includes(text), `${tool} row survives without ${tool}`);
			if (tool === "tasks" || tool === "code_nav") {
				const withoutV1 = session("attended-default", { ...surfaceWithout, promptProfile: "v1" }).systemPrompt;
				ok(baseV1.includes(text), `v1 ${tool} row missing`);
				ok(!withoutV1.includes(text), `v1 ${tool} row survives without ${tool}`);
			}
		}
	});
});
