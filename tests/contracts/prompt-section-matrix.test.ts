import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { ALL_TOOL_NAMES, type ToolName, ToolNames } from "../../src/core/tool-names.js";
import {
	type CompiledSessionPrompt,
	type CompileInputs,
	compile,
	compileWorker,
	type SessionPromptInputs,
	type WorkerPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import { toolPromptHintsForNames } from "../../src/tools/builtin-tool-catalog.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Which gated prompt sections each condition renders. A row names one anchor per
 * section, never a sentence: the byte goldens in prompt-tier-golden.test.ts pin
 * the wording, and a row here pins that its section follows its condition.
 * Anchors match the prompt with whitespace runs collapsed to one space.
 */
type Row = {
	name: string;
	inputs: SessionRowInputs | WorkerRowInputs;
	present?: string[];
	absent?: string[];
	/** Exact section ids in order. */
	sections?: string[];
	throws?: RegExp;
};

type SessionRowInputs = {
	tier: "session";
	/** A golden tier whose inputs the row starts from. */
	fixture?: string;
	safety?: "default" | "yolo";
	headless?: boolean;
	operatorInterviews?: boolean;
	providerSupportsTools?: boolean | null;
	toolNames?: ToolName[];
	profile?: "v1" | "v2";
	session?: Partial<SessionPromptInputs>;
};

type WorkerRowInputs = {
	tier: "worker";
	readOnly?: boolean;
	providerSupportsTools?: boolean | null;
	toolNames?: ToolName[];
	profile?: "v1" | "v2";
	worker?: Partial<Omit<WorkerPromptInputs, "persona">>;
	persona?: string;
};

const table = loadFragments();

function compileSession(inputs: SessionRowInputs): CompiledSessionPrompt {
	const base: CompileInputs = inputs.fixture
		? (
				JSON.parse(
					readFileSync(new URL(`../fixtures/prompt-tiers/${inputs.fixture}.inputs.json`, import.meta.url), "utf8"),
				) as { inputs: CompileInputs }
			).inputs
		: {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.default",
				sessionInputs: {
					provider: "local",
					model: "stable-model",
					contextWindow: 32_768,
					providerSupportsTools: true,
					coordinatorCapabilities: [],
				},
			};
	return compile(table, {
		...base,
		...(inputs.safety ? { safety: `safety.${inputs.safety}` } : {}),
		sessionInputs: {
			...base.sessionInputs,
			...(inputs.headless !== undefined ? { headless: inputs.headless } : {}),
			...(inputs.operatorInterviews !== undefined ? { operatorInterviews: inputs.operatorInterviews } : {}),
			...(inputs.providerSupportsTools !== undefined ? { providerSupportsTools: inputs.providerSupportsTools } : {}),
			...(inputs.toolNames ? { toolNames: inputs.toolNames } : {}),
			...(inputs.profile ? { promptProfile: inputs.profile } : {}),
			...inputs.session,
		},
	});
}

const WORKER_PERSONA =
	'# Matrix worker\n\nReturn `{"mutatedPaths":[],"validations":[{"name":"read","passed":true,"evidence":"observed"}]}`.';

function compileWorkerRow(inputs: WorkerRowInputs): CompiledSessionPrompt {
	const toolNames = inputs.toolNames ?? [ToolNames.Read, ToolNames.Context, ToolNames.CodeNav];
	const providerSupportsTools = inputs.providerSupportsTools === undefined ? true : inputs.providerSupportsTools;
	const hasBoundSkills = inputs.worker?.hasBoundSkills ?? false;
	const body = inputs.persona ?? WORKER_PERSONA;
	return compileWorker(table, {
		...(inputs.readOnly ? { readOnly: true } : {}),
		...(inputs.profile ? { promptProfile: inputs.profile } : {}),
		providerSupportsTools,
		toolNames,
		toolPromptHints: toolPromptHintsForNames(toolNames, hasBoundSkills ? "bound-worker" : "worker"),
		hasCanonicalContext: providerSupportsTools === true && toolNames.includes(ToolNames.Context),
		hasBoundSkills,
		onPermission: "fail",
		...inputs.worker,
		persona: { id: "persona.matrix", relPath: "inline/matrix", body, contentHash: sha256(body), dynamic: false },
	});
}

// The self-knowledge, gateway and skill-policy rows share one attended surface.
const docsSurface = (session: Partial<SessionPromptInputs> = {}): SessionRowInputs => ({
	tier: "session",
	toolNames: [ToolNames.Context, ToolNames.Gateway],
	session: { coordinatorCapabilities: [ToolNames.ClioDocs, ToolNames.ClioLibrary], ...session },
});

// The compact-contract rows run a local model with every capability reachable.
const localModel = (session: Partial<SessionPromptInputs> = {}): Partial<SessionPromptInputs> => ({
	provider: "dynamo",
	model: "qwen3.8-27b",
	contextWindow: 262_144,
	thinkingGuidance:
		"For this local model, reason compactly before tool use and ground final claims in observed evidence.",
	coordinatorCapabilities: ALL_TOOL_NAMES,
	...session,
});

const SETTINGS_ROUTE = 'gateway(op="call", capability="context", args={scope:"settings"})';
const SKILL_GUIDANCE = ["# Skills", "Load a matching ready skill", "only the operator activates skills"];
const REPORT_RULE = "first line is the bottom line";
const ATTENDED_STANDING = "what you expected and did not get";

const rows: Row[] = [
	// turn-ending-contract.test.ts
	{
		name: "teaches both states and the ask_user endings where an operator can answer",
		inputs: {
			tier: "session",
			operatorInterviews: true,
			toolNames: [ToolNames.AskUser, ToolNames.Read],
			session: { coordinatorCapabilities: [ToolNames.AskUser, ToolNames.Read] },
		},
		present: ["## Ending a turn", 'ask_user "Carry out this plan?"', "It ends a turn in one of two states."],
	},
	{
		name: "keeps both turn-ending states under yolo, with no approval cards and the yolo asking rule",
		inputs: {
			tier: "session",
			safety: "yolo",
			operatorInterviews: true,
			toolNames: [ToolNames.AskUser, ToolNames.Read],
			session: { coordinatorCapabilities: [ToolNames.AskUser, ToolNames.Read] },
		},
		present: ["## Ending a turn", "The operator can still answer"],
		absent: [
			"away by contract",
			"Nobody will answer a question",
			"Under yolo every turn ends Done",
			"let their approval cards gate them",
		],
	},
	{
		name: "leaves the asking rule out of a yolo session with no ask_user, as a headless run has none",
		inputs: {
			tier: "session",
			safety: "yolo",
			headless: true,
			toolNames: [ToolNames.Read],
			session: { coordinatorCapabilities: [ToolNames.Read] },
		},
		present: ["Settle every other open choice"],
		absent: ["The operator can still answer"],
	},
	...[
		{ surface: "headless", headless: true, operatorInterviews: true },
		{ surface: "ACP", headless: undefined, operatorInterviews: undefined },
	].map(
		({ surface, headless, operatorInterviews }): Row => ({
			name: `keeps only the no-offer half in headless and ACP prompts (${surface})`,
			inputs: {
				tier: "session" as const,
				...(headless ? { headless } : {}),
				...(operatorInterviews ? { operatorInterviews } : {}),
				toolNames: [ToolNames.AskUser, ToolNames.Read],
				session: { coordinatorCapabilities: [ToolNames.AskUser, ToolNames.Read] },
			},
			// The greeting rule needs an operator to greet; headless runs leave it out.
			present: [
				"It ends a turn in one of two states.",
				"with no closing offer",
				...(headless ? [] : ["stops there, without a question"]),
			],
			absent: ["## Ending a turn", 'ask_user "', ...(headless ? ["stops there, without a question"] : [])],
		}),
	),

	// compact-prompt-contracts.test.ts
	{
		name: "disabling skill discovery preserves the agent library without unsolicited skill activation instructions",
		inputs: {
			tier: "session",
			toolNames: [ToolNames.Context, ToolNames.Gateway, ToolNames.Dispatch],
			session: localModel({ skillDiscoveryEnabled: false }),
		},
		present: ["clio_library"],
		absent: ["# Skills", "Load matching installed skills"],
	},
	{
		name: "gates tool and skill prose on the attached surface (tools unavailable)",
		inputs: {
			tier: "session",
			providerSupportsTools: false,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
			session: localModel(),
		},
		present: ["Provider tool calls: unavailable."],
		absent: ["# Skills", "# Coordinator", "# Fleet", "source=clio", 'context(scope="skills")'],
	},
	{
		name: "gates tool and skill prose on the attached surface (tool support unknown)",
		inputs: {
			tier: "session",
			providerSupportsTools: null,
			toolNames: [ToolNames.Context, ToolNames.Dispatch, ToolNames.CodeNav],
			session: localModel(),
		},
		present: ["# Skills", "# Coordinator"],
	},
	{
		name: "gates tool and skill prose on the attached surface (narrow surface)",
		inputs: { tier: "session", toolNames: [ToolNames.Read], session: localModel() },
		absent: ["# Skills", "# Coordinator", "# Fleet", "source=clio", "workers behind dispatch"],
	},
	{
		name: "preserves Clio identity, safety, coordinator, evidence, and local-runtime anchors",
		inputs: {
			tier: "session",
			toolNames: ALL_TOOL_NAMES.filter((name) => name !== ToolNames.Ledger),
			session: localModel(),
		},
		present: [
			"You are CLIO Coder",
			"Autonomy: default.",
			"# Coordinator",
			"# Skills",
			"clio_library",
			"Provider: dynamo",
			"Model: qwen3.8-27b",
			"Context window: 262144",
			"For this local model",
		],
		absent: ["Collect detached runs"],
	},
	{
		name: "keeps bound and unbound worker skills mutually exclusive (unbound)",
		inputs: { tier: "worker" },
		present: ["no operator skill-activation channel"],
		absent: ["harness-activated recipe-bound", "Marketplace"],
	},
	{
		name: "keeps bound and unbound worker skills mutually exclusive (bound)",
		inputs: {
			tier: "worker",
			worker: { hasBoundSkills: true },
			persona: "# Agent-Bound Skills\n\nThe harness explicitly activates these recipe-bound skills for this run.",
		},
		present: ["harness-activated recipe-bound"],
		absent: ["no operator skill-activation channel", "explicit pending skill request", "/skill <name>", "Marketplace"],
	},
	{
		name: "keeps bound and unbound worker skills mutually exclusive (bound without context)",
		inputs: { tier: "worker", toolNames: [ToolNames.Read, ToolNames.CodeNav], worker: { hasBoundSkills: true } },
		throws: /bound skills require canonical context/u,
	},
	...[false, true].map(
		(readOnly): Row => ({
			name: `preserves worker safety, permission routing, claims, result shape, and section order (readOnly=${readOnly})`,
			inputs: { tier: "worker" as const, readOnly },
			sections: readOnly
				? ["identity", "operating-contract", "steering", "tool-contract", "safety", "dispatch.read-only", "persona"]
				: ["identity", "operating-contract", "steering", "tool-contract", "safety", "persona"],
			present: ["running as one bounded fleet worker", "The assigned task is authoritative", "Never claim a completion"],
		}),
	),
	{
		name: "preserves worker safety, permission routing, claims, result shape, and section order (no live steering)",
		inputs: { tier: "worker", worker: { liveSteering: false } },
		sections: ["identity", "operating-contract", "tool-contract", "safety", "persona"],
	},
	...(
		[
			["deny", "Approval-required calls are denied immediately"],
			["fail", "fails and ends the worker run"],
			["escalate", "pause for a bounded operator decision"],
		] as const
	).map(
		([onPermission, anchor]): Row => ({
			name: `preserves worker safety, permission routing, claims, result shape, and section order (onPermission=${onPermission})`,
			inputs: { tier: "worker" as const, worker: { onPermission } },
			present: [anchor],
		}),
	),
	...[false, null].map(
		(providerSupportsTools): Row => ({
			name: `preserves worker safety, permission routing, claims, result shape, and section order (tools=${providerSupportsTools})`,
			inputs: { tier: "worker" as const, providerSupportsTools },
			absent: ["no operator skill-activation channel", "source=clio"],
		}),
	),

	// prompt-preconditions.test.ts (S-81)
	{
		name: "a sandboxed session reads no recognized-command list",
		inputs: {
			tier: "session",
			toolNames: [ToolNames.Bash, ToolNames.Read, ToolNames.Dispatch],
			session: { coordinatorCapabilities: [ToolNames.Bash, ToolNames.Read, ToolNames.Dispatch], sandbox: true },
		},
		present: ["inside an OS sandbox"],
		absent: ["recognized commands run", "rev-parse", "`sed -n"],
	},
	...[false, true].map(
		(headless): Row => ({
			name: `an unsandboxed session reads nothing the sandbox would hide (headless=${headless})`,
			inputs: {
				tier: "session" as const,
				...(headless ? { headless } : {}),
				toolNames: [ToolNames.Bash, ToolNames.Read, ToolNames.Dispatch],
				session: { coordinatorCapabilities: [ToolNames.Bash, ToolNames.Read, ToolNames.Dispatch], sandbox: false },
			},
			present: ["This session has no OS sandbox"],
			absent: ["are hidden", "SSH agent", "unsandboxed: true", ...(headless ? ["/rewind"] : [])],
		}),
	),
	{
		name: "a worker without a shell reads no command rules",
		inputs: {
			tier: "worker",
			readOnly: true,
			toolNames: [
				ToolNames.CodeNav,
				ToolNames.Context,
				ToolNames.Find,
				ToolNames.Gateway,
				ToolNames.Grep,
				ToolNames.Ls,
				ToolNames.Read,
			],
			worker: { onPermission: "deny" },
		},
		present: ["You run no commands"],
		absent: ["bash", "Bash", "unsandboxed", "/rewind", "main session", "Main session"],
	},

	// prompt-skill-policy.test.ts
	...(["default", "yolo"] as const).flatMap((safety) =>
		(
			[
				[false, true],
				[true, false],
			] as const
		).map(
			([context, tools]): Row => ({
				name: `omits skill activation guidance at ${safety} with context=${context}, tools=${tools}`,
				inputs: {
					tier: "session" as const,
					safety,
					providerSupportsTools: tools,
					toolNames: context ? [ToolNames.Context, ToolNames.Gateway] : [ToolNames.Gateway],
					session: { coordinatorCapabilities: context ? [ToolNames.Context] : [] },
				},
				absent: SKILL_GUIDANCE,
			}),
		),
	),

	// self-knowledge-prompt.test.ts
	...(
		[
			["default", {}],
			["skill discovery off", { skillDiscoveryEnabled: false }],
			["no ready skills", { readySkillCount: 0 }],
			["answer mode", { turnConstraints: { mode: "answer" } }],
		] as const
	).map(
		([variant, session]): Row => ({
			name: `points settings questions at the live snapshot whenever context is on the surface (${variant})`,
			inputs: docsSurface(session),
			present: [SETTINGS_ROUTE],
		}),
	),
	...(["default", "yolo"] as const).map(
		(safety): Row => ({
			name: `keeps configure_clio and setup consent procedure out of the prompt and in settings results (S-84) (${safety})`,
			inputs: { ...docsSurface({ canConfigureClio: true }), safety },
			absent: ['capability="configure_clio"', "Offer setup once"],
		}),
	),
	{
		name: "never routes to the code map file or the removed docs scope",
		inputs: docsSurface(),
		absent: ["codemap.json"],
	},
	{
		name: "offers a bounded semantic lookup only when the opt-in tool is reachable",
		inputs: docsSurface({ semanticSearchAvailable: true }),
		present: ["context(scope=semantic)"],
	},
	...(
		[
			["off", docsSurface()],
			["gateway only", { ...docsSurface({ semanticSearchAvailable: true }), toolNames: [ToolNames.Gateway] }],
			["no tool calls", { ...docsSurface({ semanticSearchAvailable: true }), providerSupportsTools: false }],
			["answer mode", docsSurface({ semanticSearchAvailable: true, turnConstraints: { mode: "answer" } })],
		] satisfies Array<[string, SessionRowInputs]>
	).map(
		([variant, inputs]): Row => ({
			name: `offers a bounded semantic lookup only when the opt-in tool is reachable (${variant})`,
			inputs,
			absent: ["context(scope=semantic)"],
		}),
	),

	// gateway-prompt.test.ts
	...(
		[
			["context and gateway", [ToolNames.Context, ToolNames.Gateway], true],
			["context only", [ToolNames.Context], true],
			["gateway only", [ToolNames.Gateway], true],
			["no tools", [], true],
			["a provider without tool calls", [ToolNames.Context, ToolNames.Gateway], false],
		] as const
	).map(([surface, toolNames, providerSupportsTools]): Row => {
		const gateway = providerSupportsTools && toolNames.some((name) => name === ToolNames.Gateway);
		const context = providerSupportsTools && toolNames.some((name) => name === ToolNames.Context);
		const gated = (on: boolean, anchors: string[]) => (on ? anchors : []);
		const gatewayAnchors = ["carry the procedure under Guidance", 'capability="clio_docs"', "clio_library kind=playbook"];
		const contextAnchors = ["# Skills", 'args={scope:"skills",query:"<task>"}'];
		return {
			name: `gates documentation and skill catalog guidance for ${surface}`,
			inputs: { ...docsSurface(), toolNames: [...toolNames], providerSupportsTools },
			present: [...gated(gateway, gatewayAnchors), ...gated(context, [...contextAnchors, "Install only when requested"])],
			absent: [
				...gated(!gateway, gatewayAnchors),
				...gated(!context, contextAnchors),
				"# CLIO Coder documentation routing",
				"only the operator activates or installs a skill",
				'context(scope="docs")',
				'context(scope="library")',
			],
		};
	}),

	// headless-approval-prompt.test.ts
	{
		name: "tells a headless session at default that approval-required calls are denied",
		inputs: { tier: "session", headless: true, toolNames: [ToolNames.Bash, ToolNames.Read] },
		present: ["No operator is attached to this headless run"],
		absent: ["pause for one operator confirmation"],
	},
	...[undefined, false].map(
		(headless): Row => ({
			name: `keeps the operator-confirmation sentence for an attached session at default (headless=${headless})`,
			inputs: {
				tier: "session" as const,
				...(headless === false ? { headless } : {}),
				toolNames: [ToolNames.Bash, ToolNames.Read],
			},
			present: ["pause for one operator confirmation"],
			absent: ["No operator is attached to this headless run"],
		}),
	),
	...[true, false].map(
		(headless): Row => ({
			name: `says nothing about approval-required calls at yolo, headless or attended (headless=${headless})`,
			inputs: { tier: "session" as const, safety: "yolo" as const, headless, toolNames: [ToolNames.Bash, ToolNames.Read] },
			present: ["refused instead of asked"],
			absent: ["pause for one operator confirmation", "No operator is attached to this headless run"],
		}),
	),
	...[true, false].map(
		(headless): Row => ({
			name: `keeps unsandboxed: true for sandbox failures, off pushes, and says the escape needs a request that names it (headless=${headless})`,
			inputs: {
				tier: "session" as const,
				headless,
				toolNames: [ToolNames.Bash, ToolNames.Read],
				session: { coordinatorCapabilities: [], sandbox: true },
			},
			present: ["unsandboxed: true"],
		}),
	),
	...[false, true].map(
		(headless): Row => ({
			name: `keeps the clio_docs lookup but leaves docs, settings and operator-control guidance out of a headless session (headless=${headless})`,
			inputs: {
				tier: "session" as const,
				headless,
				toolNames: [ToolNames.Bash, ToolNames.Read, ToolNames.Gateway, ToolNames.Context],
				session: { coordinatorCapabilities: [ToolNames.ClioDocs] },
			},
			present: headless
				? []
				: [
						"# User control and understanding",
						'Questions about CLIO Coder itself: gateway(op="call", capability="clio_docs"',
					],
			absent: [
				"# CLIO Coder documentation routing",
				"# CLIO Coder settings routing",
				...(headless ? ["# User control and understanding", "# Answering questions about Clio", "clio_docs"] : []),
			],
		}),
	),
	...(["headless-default", "headless-yolo"] as const).map(
		(fixture): Row => ({
			name: `names no interactive surface headless, and headless yolo waits in bash instead of a job (${fixture} v2)`,
			inputs: { tier: "session" as const, fixture, profile: "v2" as const },
			present: fixture === "headless-yolo" ? ["cannot own a job"] : [],
			absent: ["/rewind", "/fleet run", "ask_user", "decision tool", "- `job`", "clio_docs"],
		}),
	),
	...[true, false].map(
		(headless): Row => ({
			name: `keeps clause evidence and conditional reproduction tests in unattended prompts only (headless=${headless})`,
			inputs: { tier: "session" as const, headless },
			present: headless ? ["map each clause", "record it with limitation"] : [],
			absent: ["against active decisions", ...(headless ? [] : ["reproduction test", "map each clause"])],
		}),
	),
	...(["v1", "v2"] as const).map(
		(profile): Row => ({
			name: `tells a dispatching session an undeclared verification check id is refused with the declared ids named (${profile})`,
			inputs: {
				tier: "session" as const,
				profile,
				toolNames: [ToolNames.Read, ToolNames.Dispatch],
				session: { coordinatorCapabilities: [ToolNames.Read, ToolNames.Dispatch] },
			},
			present: [
				profile === "v2"
					? "An undeclared `intent.verification` id is refused naming the declared ids; list nothing first."
					: "an undeclared id is refused with the declared ids named, so no verify()",
			],
		}),
	),
	...(["v1", "v2"] as const).flatMap((profile): Row[] => [
		{
			name: `renders the report rule for headless and attended yolo main sessions only (${profile} headless)`,
			inputs: { tier: "session" as const, headless: true, profile },
			present: [REPORT_RULE],
			absent: [ATTENDED_STANDING, "why you are making it"],
		},
		{
			name: `renders the report rule for headless and attended yolo main sessions only (${profile} attended yolo)`,
			inputs: { tier: "session" as const, safety: "yolo" as const, profile },
			present: [REPORT_RULE],
		},
		{
			name: `renders the report rule for headless and attended yolo main sessions only (${profile} attended default)`,
			inputs: { tier: "session" as const, profile },
			present: [ATTENDED_STANDING, "why you are making it"],
			absent: [REPORT_RULE],
		},
	]),
	{
		name: "renders the report rule for headless and attended yolo main sessions only (worker)",
		inputs: { tier: "worker" },
		absent: [REPORT_RULE],
	},

	// demo-guidance.test.ts
	...[true, false, undefined].map(
		(demo): Row => ({
			name: `only an explicit interactive prompt input adds guidance; disabling restores identical prompt (demo=${demo})`,
			inputs: {
				tier: "session" as const,
				...(demo === undefined ? {} : { session: { coordinatorCapabilities: [], demo } }),
			},
			...(demo ? { present: ["## Demo guidance", "interface.demo"] } : { absent: ["## Demo guidance"] }),
		}),
	),
];

let env: IsolatedClioEnv;
before(async () => {
	env = await isolateClioEnv("clio-coder-prompt-matrix-");
});
after(() => env.restore());

test("prompt sections follow their conditions", () => {
	const failures: string[] = [];
	for (const row of rows) {
		const run = () => (row.inputs.tier === "session" ? compileSession(row.inputs) : compileWorkerRow(row.inputs));
		if (row.throws) {
			try {
				run();
				failures.push(`${row.name}: compiled, expected ${row.throws}`);
			} catch (error) {
				if (!row.throws.test(String(error))) failures.push(`${row.name}: threw ${String(error)}`);
			}
			continue;
		}
		const compiled = run();
		const text = compiled.systemPrompt.replace(/\s+/gu, " ");
		for (const anchor of row.present ?? []) if (!text.includes(anchor)) failures.push(`${row.name}: lacks ${anchor}`);
		for (const anchor of row.absent ?? []) if (text.includes(anchor)) failures.push(`${row.name}: renders ${anchor}`);
		// Every row: no template placeholder or row-condition marker survives compilation.
		const placeholder = /\{\{|\{[A-Z][A-Z_]+\}|\{[a-z_]+\} /u.exec(compiled.systemPrompt);
		if (placeholder) failures.push(`${row.name}: unresolved ${placeholder[0]}`);
		if (row.sections) {
			const ids = compiled.sections.map((section) => section.id).join(",");
			if (ids !== row.sections.join(",")) failures.push(`${row.name}: sections ${ids}`);
		}
	}
	deepStrictEqual(failures, []);
});
