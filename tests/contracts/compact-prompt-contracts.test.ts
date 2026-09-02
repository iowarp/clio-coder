import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ALL_TOOL_NAMES, type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { renderFleetPromptSection } from "../../src/domains/agents/catalog.js";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import {
	type CompiledSessionPrompt,
	compile,
	compileWorker,
	type RenderedPromptFragment,
	WORKER_CLAIM_GUIDANCE,
} from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";

const table = loadFragments();
const builtinRecipes = discoverAgentRecipes(process.cwd()).filter((recipe) => recipe.source === "builtin");
const fleetRoster = renderFleetPromptSection(builtinRecipes.map(normalizeAgentSpec));
const autonomyLevels: ReadonlyArray<AutonomyLevel> = ["read-only", "suggest", "auto-edit", "full-auto"];

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function mainPrompt(input: {
	autonomy?: AutonomyLevel;
	providerSupportsTools?: boolean | null;
	toolNames?: ReadonlyArray<ToolName>;
	reverse?: boolean;
}): CompiledSessionPrompt {
	const toolNames = [...(input.toolNames ?? [])];
	const hints = [...toolPromptHintsForNames(toolNames, "session")];
	const providerSupportsTools = input.providerSupportsTools === undefined ? true : input.providerSupportsTools;
	if (input.reverse) {
		toolNames.reverse();
		hints.reverse();
	}
	return compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${input.autonomy ?? "auto-edit"}`,
		sessionInputs: {
			provider: "dynamo",
			model: "qwen3.8-27b",
			contextWindow: 262_144,
			providerSupportsTools,
			thinkingGuidance:
				"For this local model, reason compactly before tool use and ground final claims in observed evidence.",
			toolNames,
			toolPromptHints: hints,
			fleetRoster,
		},
	});
}

function persona(body: string, id = "matrix"): RenderedPromptFragment {
	return {
		id: `persona.${id}`,
		relPath: `inline/${id}`,
		body,
		contentHash: sha256(body),
		dynamic: false,
	};
}

function workerPrompt(input: {
	autonomy?: AutonomyLevel;
	providerSupportsTools?: boolean | null;
	hasContext: boolean;
	hasBoundSkills: boolean;
	onPermission?: "deny" | "fail" | "escalate";
	personaBody?: string;
}): CompiledSessionPrompt {
	const toolNames = input.hasContext
		? [ToolNames.Read, ToolNames.Context, ToolNames.CodeNav]
		: [ToolNames.Read, ToolNames.CodeNav];
	const role = input.hasBoundSkills ? "bound-worker" : "worker";
	const providerSupportsTools = input.providerSupportsTools === undefined ? true : input.providerSupportsTools;
	return compileWorker(table, {
		autonomy: input.autonomy ?? "auto-edit",
		providerSupportsTools,
		toolNames,
		toolPromptHints: toolPromptHintsForNames(toolNames, role),
		hasCanonicalContext: providerSupportsTools === true && input.hasContext,
		hasBoundSkills: input.hasBoundSkills,
		onPermission: input.onPermission ?? "fail",
		persona: persona(
			input.personaBody ??
				'# Matrix worker\n\nReturn `{"mutatedPaths":[],"validations":[{"name":"read","passed":true,"evidence":"observed"}]}`.',
		),
	});
}

describe("compact prompt contracts", () => {
	it("keeps main composition deterministic across autonomy and tool input order", () => {
		const tools = [
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.CodeNav,
			ToolNames.Context,
			ToolNames.Git,
			ToolNames.Verify,
			ToolNames.Dispatch,
		];
		for (const autonomy of autonomyLevels) {
			const forward = mainPrompt({ autonomy, providerSupportsTools: true, toolNames: tools });
			const reversed = mainPrompt({ autonomy, providerSupportsTools: true, toolNames: tools, reverse: true });
			strictEqual(forward.systemPrompt, reversed.systemPrompt, `${autonomy} prompt must ignore registry order`);
			strictEqual(forward.systemPromptHash, reversed.systemPromptHash);
			deepStrictEqual(
				forward.sections.map((section) => section.id),
				[
					"identity",
					"operating-contract",
					"delegation",
					"skills",
					"safety",
					"tool-contract",
					"fleet",
					"retrieval-hints",
					"runtime",
				],
			);
			match(forward.systemPrompt, new RegExp(`Autonomy: ${autonomy}\\.`, "u"));
			strictEqual(forward.systemPrompt.includes("There is no read-only posture"), false);
		}
	});

	it("gates tool, skill, and fleet prose on the attached surface", () => {
		const unavailable = mainPrompt({
			providerSupportsTools: false,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
		});
		for (const absent of ["# Skills", "# Delegation", "# Fleet", "source=clio", 'context(scope="skills")']) {
			strictEqual(unavailable.systemPrompt.includes(absent), false, `${absent} must be absent without tool support`);
		}
		match(unavailable.systemPrompt, /Provider tool calls: unavailable\./u);

		const unknown = mainPrompt({
			providerSupportsTools: null,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
		});
		match(unknown.systemPrompt, /# Skills/u);
		match(unknown.systemPrompt, /# Delegation/u);
		match(unknown.systemPrompt, /source=clio/u);

		const narrow = mainPrompt({ providerSupportsTools: true, toolNames: [ToolNames.Read] });
		for (const absent of ["# Skills", "# Delegation", "# Fleet", "source=clio", "workers behind dispatch"]) {
			strictEqual(narrow.systemPrompt.includes(absent), false, `${absent} must follow its absent tool`);
		}
	});

	it("preserves Clio identity, safety, Fleet, receipt, evidence, and local-runtime anchors", () => {
		const compiled = mainPrompt({
			providerSupportsTools: true,
			toolNames: ALL_TOOL_NAMES.filter((name) => name !== ToolNames.Ledger),
		});
		match(compiled.systemPrompt, /You are Clio, the coding agent in IOWarp's CLIO ecosystem/u);
		match(compiled.systemPrompt, /Her documentation and source ship with the package/u);
		match(compiled.systemPrompt, /Autonomy: auto-edit\./u);
		match(compiled.systemPrompt, /Hard blocks\s+\(destructive git,/u);
		match(compiled.systemPrompt, /A sealed run receipt is the durable record/u);
		match(compiled.systemPrompt, /advisory claim until its evidence is verified/u);
		match(compiled.systemPrompt, /before repeating a "tests pass" claim/u);
		match(compiled.systemPrompt, /report receipt integrity, evidence verification, briefing\s+provenance/u);
		match(compiled.systemPrompt, /Provider: dynamo/u);
		match(compiled.systemPrompt, /Model: qwen3\.8-27b/u);
		match(compiled.systemPrompt, /Context window: 262144/u);
		match(compiled.systemPrompt, /For this local model, reason compactly/u);
		// The delegation threshold is stated once, at the top of the Delegation
		// section, as a count taken before the first edit (the Fleet block no
		// longer carries it); the skills protocol is stated once, in Skills.
		strictEqual(occurrences(compiled.systemPrompt, "count the independent file-scoped changes"), 1);
		match(compiled.systemPrompt, /only the operator\s+activates or installs a skill/u);
		match(compiled.systemPrompt, /\[Marketplace\] reminder states its\s+own offer options/u);
		strictEqual(occurrences(compiled.systemPrompt, "harness performs any install"), 0);
		strictEqual(occurrences(compiled.systemPrompt, "A sealed run receipt is the durable record"), 1);
	});

	it("keeps bound and unbound worker skills mutually exclusive", () => {
		const unbound = workerPrompt({ providerSupportsTools: true, hasContext: true, hasBoundSkills: false });
		match(unbound.systemPrompt, /no operator skill-activation channel/u);
		strictEqual(unbound.systemPrompt.includes("harness-activated recipe-bound"), false);
		strictEqual(unbound.systemPrompt.includes("Marketplace"), false);

		const bound = workerPrompt({
			providerSupportsTools: true,
			hasContext: true,
			hasBoundSkills: true,
			personaBody:
				'# Agent-Bound Skills\n\nThe harness explicitly activates these recipe-bound skills for this run.\n\nReturn `{"mutatedPaths":[],"validations":[{"name":"read","passed":true,"evidence":"observed"}]}`.',
		});
		match(bound.systemPrompt, /harness-activated recipe-bound skills named in the persona/u);
		match(bound.systemPrompt, /harness explicitly activates these recipe-bound skills/u);
		strictEqual(bound.systemPrompt.includes("explicit pending skill request"), false);
		strictEqual(bound.systemPrompt.includes("/skill <name>"), false);
		strictEqual(bound.systemPrompt.includes("Marketplace"), false);

		throws(
			() => workerPrompt({ providerSupportsTools: true, hasContext: false, hasBoundSkills: true }),
			/bound skills require canonical context/u,
		);
	});

	it("preserves worker safety, permission routing, claims, result shape, and section order", () => {
		for (const autonomy of autonomyLevels) {
			const compiled = workerPrompt({
				autonomy,
				providerSupportsTools: true,
				hasContext: true,
				hasBoundSkills: false,
			});
			deepStrictEqual(
				compiled.sections.map((section) => section.id),
				["identity", "operating-contract", "tool-contract", "safety", "persona"],
			);
			match(compiled.systemPrompt, /You are Clio, IOWarp's coding agent, running as one bounded worker/u);
			match(compiled.systemPrompt, /The assigned task is authoritative/u);
			strictEqual(occurrences(compiled.systemPrompt, WORKER_CLAIM_GUIDANCE), 1);
			match(compiled.systemPrompt, /"mutatedPaths":\[\],"validations"/u);
			match(compiled.systemPrompt, new RegExp(`Autonomy: ${autonomy}\\.`, "u"));
		}

		match(
			workerPrompt({
				providerSupportsTools: true,
				hasContext: true,
				hasBoundSkills: false,
				onPermission: "deny",
			}).systemPrompt,
			/Approval-required calls are denied immediately/u,
		);
		match(
			workerPrompt({
				providerSupportsTools: true,
				hasContext: true,
				hasBoundSkills: false,
				onPermission: "fail",
			}).systemPrompt,
			/An approval-required call fails and ends the worker run/u,
		);
		match(
			workerPrompt({
				providerSupportsTools: true,
				hasContext: true,
				hasBoundSkills: false,
				onPermission: "escalate",
			}).systemPrompt,
			/Approval-required calls pause for a bounded operator decision/u,
		);

		for (const providerSupportsTools of [false, null] as const) {
			const compiled = workerPrompt({
				providerSupportsTools,
				hasContext: true,
				hasBoundSkills: false,
			});
			strictEqual(compiled.systemPrompt.includes("no operator skill-activation channel"), false);
			strictEqual(compiled.systemPrompt.includes("source=clio"), false);
		}
	});

	it("holds fixed compact main and worker token budgets", () => {
		strictEqual(builtinRecipes.length, 13, "the fixed Fleet fixture requires the 13 shipped recipes");
		const mainToolNames = ALL_TOOL_NAMES.filter((name) => name !== ToolNames.Ledger);
		strictEqual(mainToolNames.length, 20);
		const main = mainPrompt({ providerSupportsTools: true, toolNames: mainToolNames });
		// The self-awareness paths are machine facts: the package root, the
		// settings file, and the state directory of the live home.
		const dirs = resolveClioDirs();
		const normalizedMain = main.systemPrompt
			.split(resolvePackageRoot())
			.join("{PACKAGE_ROOT}")
			.split(join(dirs.config, "settings.yaml"))
			.join("{SETTINGS}")
			.split(dirs.state)
			.join("{STATE}");
		strictEqual(normalizedMain.length, 10_504);
		strictEqual(Math.ceil(normalizedMain.length / 4), 2_626);
		ok(normalizedMain.length <= 10_800, `main prompt grew to ${normalizedMain.length} chars`);
		ok(
			Math.ceil(normalizedMain.length / 4) <= 2_700,
			`main prompt grew to ${Math.ceil(normalizedMain.length / 4)} estimated tokens`,
		);
		strictEqual(Math.ceil(main.systemPrompt.length / 4), main.tokenEstimate);
		const operatingContract = table.byId.get("operating.contract")?.body.trim();
		if (!operatingContract) throw new Error("fixed main fixture requires the operating contract");
		const identityBoundary = normalizedMain.indexOf(`\n\n${operatingContract}`);
		ok(identityBoundary > 0, "fixed main fixture must expose the identity section boundary");
		const normalizedIdentityEstimate = Math.ceil(normalizedMain.slice(0, identityBoundary).length / 4);
		deepStrictEqual(
			{
				identity: normalizedIdentityEstimate,
				...Object.fromEntries(
					main.sections.filter((section) => section.id !== "identity").map((section) => [section.id, section.tokenEstimate]),
				),
			},
			{
				identity: 298,
				"operating-contract": 164,
				delegation: 532,
				skills: 181,
				safety: 266,
				"tool-contract": 635,
				fleet: 472,
				"retrieval-hints": 36,
				runtime: 43,
			},
		);

		const coder = builtinRecipes.find((recipe) => recipe.id === "coder");
		if (!coder) throw new Error("fixed worker fixture requires the shipped coder recipe");
		const workerToolNames = [
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.Find,
			ToolNames.Ls,
			ToolNames.CodeNav,
			ToolNames.Context,
			ToolNames.Write,
			ToolNames.Edit,
			ToolNames.Bash,
			ToolNames.Git,
			ToolNames.Verify,
			ToolNames.Tasks,
			ToolNames.Artifact,
		];
		const worker = compileWorker(table, {
			autonomy: "auto-edit",
			providerSupportsTools: true,
			toolNames: workerToolNames,
			toolPromptHints: toolPromptHintsForNames(workerToolNames, "bound-worker"),
			hasCanonicalContext: true,
			hasBoundSkills: true,
			onPermission: "fail",
			persona: persona(coder.body, "coder"),
		});
		strictEqual(worker.systemPrompt.length, 5_335);
		strictEqual(worker.tokenEstimate, 1_334);
		ok(worker.systemPrompt.length <= 5_400);
		ok(worker.tokenEstimate <= 1_350);
		strictEqual(Math.ceil(worker.systemPrompt.length / 4), worker.tokenEstimate);
		deepStrictEqual(Object.fromEntries(worker.sections.map((section) => [section.id, section.tokenEstimate])), {
			identity: 62,
			"operating-contract": 257,
			"tool-contract": 372,
			safety: 253,
			persona: 389,
		});
	});
});
