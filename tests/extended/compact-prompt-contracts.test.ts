import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOL_NAMES, type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { TurnConstraints } from "../../src/core/turn-constraints.js";
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
const autonomyLevels: ReadonlyArray<AutonomyLevel> = ["default", "yolo"];

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function mainPrompt(input: {
	autonomy?: AutonomyLevel;
	providerSupportsTools?: boolean | null;
	toolNames?: ReadonlyArray<ToolName>;
	reverse?: boolean;
	skillDiscoveryEnabled?: boolean;
}): CompiledSessionPrompt {
	const toolNames = [...(input.toolNames ?? [])];
	const providerSupportsTools = input.providerSupportsTools === undefined ? true : input.providerSupportsTools;
	if (input.reverse) {
		toolNames.reverse();
	}
	return compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${input.autonomy ?? "default"}`,
		sessionInputs: {
			provider: "dynamo",
			model: "qwen3.8-27b",
			contextWindow: 262_144,
			providerSupportsTools,
			thinkingGuidance:
				"For this local model, reason compactly before tool use and ground final claims in observed evidence.",
			toolNames,
			coordinatorCapabilities: ALL_TOOL_NAMES,
			...(input.skillDiscoveryEnabled !== undefined ? { skillDiscoveryEnabled: input.skillDiscoveryEnabled } : {}),
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
	readOnly?: boolean;
	turnConstraints?: TurnConstraints;
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
		...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
		...(input.readOnly ? { readOnly: true } : {}),
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
	it("disabling skill discovery preserves the agent library without unsolicited skill activation instructions", () => {
		const prompt = mainPrompt({
			toolNames: [ToolNames.Context, ToolNames.Gateway, ToolNames.Dispatch],
			skillDiscoveryEnabled: false,
		}).systemPrompt;
		strictEqual(prompt.includes("# Skills"), false);
		strictEqual(prompt.includes("Load matching installed skills"), false);
		match(prompt, /clio_library/u);
	});

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
					"retrieval-hints",
					"harness-awareness",
					"runtime",
				],
			);
			match(forward.systemPrompt, new RegExp(`Autonomy: ${autonomy}\\.`, "u"));
			strictEqual(forward.systemPrompt.includes("There is no read-only posture"), false);
		}
	});

	it("gates tool and skill prose on the attached surface", () => {
		const unavailable = mainPrompt({
			providerSupportsTools: false,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
		});
		for (const absent of ["# Skills", "# Coordinator", "# Fleet", "source=clio", 'context(scope="skills")']) {
			strictEqual(unavailable.systemPrompt.includes(absent), false, `${absent} must be absent without tool support`);
		}
		match(unavailable.systemPrompt, /Provider tool calls: unavailable\./u);

		const unknown = mainPrompt({
			providerSupportsTools: null,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
		});
		match(unknown.systemPrompt, /# Skills/u);
		match(unknown.systemPrompt, /# Coordinator/u);

		const narrow = mainPrompt({ providerSupportsTools: true, toolNames: [ToolNames.Read] });
		for (const absent of ["# Skills", "# Coordinator", "# Fleet", "source=clio", "workers behind dispatch"]) {
			strictEqual(narrow.systemPrompt.includes(absent), false, `${absent} must follow its absent tool`);
		}
	});

	it("preserves Clio identity, safety, coordinator, evidence, and local-runtime anchors", () => {
		const compiled = mainPrompt({
			providerSupportsTools: true,
			toolNames: ALL_TOOL_NAMES.filter((name) => name !== ToolNames.Ledger),
		});
		match(compiled.systemPrompt, /You are Clio, the coding agent in IOWarp's CLIO ecosystem/u);
		match(compiled.systemPrompt, /Her documentation and source ship with the package/u);
		match(compiled.systemPrompt, /Autonomy: default\./u);
		match(compiled.systemPrompt, /Hard blocks\s+\(destructive git,/u);
		match(compiled.systemPrompt, /Use receipts for synthesis/u);
		match(compiled.systemPrompt, /spot-check consequential evidence/u);
		strictEqual(compiled.systemPrompt.includes("Collect detached runs"), false);
		match(compiled.systemPrompt, /clio_library/u);
		match(compiled.systemPrompt, /Provider: dynamo/u);
		match(compiled.systemPrompt, /Model: qwen3\.8-27b/u);
		match(compiled.systemPrompt, /Context window: 262144/u);
		match(compiled.systemPrompt, /For this local model, reason compactly/u);
		match(compiled.systemPrompt, /Load a matching ready skill through gateway/u);
		match(compiled.systemPrompt, /Install only when requested or approved/u);
		match(compiled.systemPrompt, /Honor a \[Marketplace\] reminder's exact/u);
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
		for (const readOnly of [false, true]) {
			const compiled = workerPrompt({
				readOnly,
				providerSupportsTools: true,
				hasContext: true,
				hasBoundSkills: false,
			});
			deepStrictEqual(
				compiled.sections.map((section) => section.id),
				readOnly
					? ["identity", "operating-contract", "steering", "tool-contract", "safety", "dispatch.read-only", "persona"]
					: ["identity", "operating-contract", "steering", "tool-contract", "safety", "persona"],
			);
			match(compiled.systemPrompt, /You are Clio, IOWarp's coding agent, running as one bounded worker/u);
			match(compiled.systemPrompt, /The assigned task is authoritative/u);
			strictEqual(occurrences(compiled.systemPrompt, WORKER_CLAIM_GUIDANCE), 1);
			match(compiled.systemPrompt, /"mutatedPaths":\[\],"validations"/u);
			match(compiled.systemPrompt, /Permit: git inspect, asks fail\./u);
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
});

it("worker scope changes leave its constitutional prefix and assigned-task role stable", () => {
	const base = workerPrompt({ hasContext: true, hasBoundSkills: false });
	const scoped = workerPrompt({
		hasContext: true,
		hasBoundSkills: false,
		turnConstraints: { mode: "answer", allowedTools: [], skills: "disabled" },
	});
	deepStrictEqual(scoped.stablePrefix, base.stablePrefix);
	strictEqual(
		scoped.systemPrompt.slice(0, scoped.systemPrompt.indexOf("# Tool Contract")),
		base.systemPrompt.slice(0, base.systemPrompt.indexOf("# Tool Contract")),
	);
	strictEqual(scoped.sections.at(-1)?.id, "turn-scope");
	strictEqual(scoped.systemPrompt.endsWith("Use no tools for this turn."), true);
	strictEqual(
		scoped.sections.some((section) => section.id === "delegation" || section.id === "skills"),
		false,
	);
});
