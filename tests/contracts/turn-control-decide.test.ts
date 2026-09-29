import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { parse } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { settingsChangeKind } from "../../src/domains/config/classify.js";
import type {
	TurnControlSettings,
	TurnFacts,
	TurnInterpretation,
	WorkflowDecision,
} from "../../src/domains/turn-control/index.js";
import {
	decide,
	decisionHash,
	factsDigest,
	fingerprintEquals,
	orientationQuestion,
	renderCollectedBlock,
	renderDirectionBlock,
	renderOrientationBlock,
	renderOrientationUnavailable,
} from "../../src/domains/turn-control/index.js";

const facts: TurnFacts = {
	operatorText: "explore this repo",
	turnIndex: 0,
	continuation: false,
	explicitConstraints: false,
	taskEstablished: false,
	clarificationStreak: 1,
	workspace: { cwd: "/repo", gitHead: "head", dirtyTreeHash: "clean", codemapHash: "map" },
	capabilities: { dispatch: true, scoutRecipeId: "scout", readOnlyGit: true, monitor: true },
	priorOrientation: null,
	finishedDetachedBatchIds: [],
	autonomy: "default",
};
const interpretation: TurnInterpretation = {
	intent: "inspect",
	orientation: { wanted: true, breadth: "repository" },
	direction: { requested: false },
};
const settings = DEFAULT_SETTINGS.turnControl;
const prior = { runId: "prior-run", receiptDigest: "digest", fingerprint: { ...facts.workspace } };

it("decides workflow cases in the required order, including each reachable none reason", () => {
	const direction = {
		...interpretation,
		orientation: { ...interpretation.orientation, wanted: false },
		direction: { requested: true },
	};
	const cases: Array<{
		name: string;
		interpretation: TurnInterpretation | null;
		facts: TurnFacts;
		settings: TurnControlSettings;
		expected: WorkflowDecision;
	}> = [
		{
			name: "constraints still precede collection on continuations",
			interpretation,
			facts: { ...facts, continuation: true, explicitConstraints: true, finishedDetachedBatchIds: ["batch"] },
			settings,
			expected: { kind: "none", reason: "constraints" },
		},
		{
			name: "finished batches are collected on continuations without interpretation",
			interpretation: null,
			facts: { ...facts, continuation: true, finishedDetachedBatchIds: ["batch"] },
			settings,
			expected: { kind: "collect", batchIds: ["batch"] },
		},
		{
			name: "continuation without finished batches performs no other workflow",
			interpretation,
			facts: { ...facts, continuation: true },
			settings,
			expected: { kind: "none", reason: "continuation" },
		},
		{
			name: "constraints",
			interpretation,
			facts: { ...facts, explicitConstraints: true },
			settings,
			expected: { kind: "none", reason: "constraints" },
		},
		{
			name: "off",
			interpretation,
			facts,
			settings: { ...settings, workflows: [] },
			expected: { kind: "none", reason: "off" },
		},
		{
			name: "no interpretation",
			interpretation: null,
			facts,
			settings,
			expected: { kind: "none", reason: "no-interpretation" },
		},
		{
			name: "explicit implementation vetoes orientation",
			interpretation: { ...interpretation, intent: "implement" },
			facts,
			settings,
			expected: { kind: "none", reason: "below-threshold" },
		},
		{
			name: "missing capability",
			interpretation,
			facts: { ...facts, capabilities: { ...facts.capabilities, dispatch: false } },
			settings,
			expected: { kind: "none", reason: "capability-missing" },
		},
		{
			name: "established task",
			interpretation: direction,
			facts: { ...facts, taskEstablished: true },
			settings,
			expected: { kind: "none", reason: "task-established" },
		},
		{
			name: "orientation with unknown intent, with changed fingerprint",
			interpretation: { ...interpretation, intent: "unknown" },
			facts: { ...facts, priorOrientation: { ...prior, fingerprint: { ...prior.fingerprint, dirtyTreeHash: "old" } } },
			settings,
			expected: {
				kind: "orientation",
				question: orientationQuestion(facts.operatorText, "repository", 4),
				breadth: "repository",
				reuse: null,
				budget: { maxScouts: 4, toolCallsPerScout: 36 },
			},
		},
		{
			name: "area orientation with answer intent reuses unchanged fingerprint",
			interpretation: {
				...interpretation,
				intent: "answer",
				orientation: { ...interpretation.orientation, breadth: "area" },
			},
			facts: { ...facts, priorOrientation: prior },
			settings,
			expected: {
				kind: "orientation",
				question: orientationQuestion(facts.operatorText, "area", 4),
				breadth: "area",
				reuse: { runId: "prior-run", receiptDigest: "digest" },
				budget: { maxScouts: 4, toolCallsPerScout: 36 },
			},
		},
		{
			name: "direction",
			interpretation: direction,
			facts,
			settings,
			expected: { kind: "direction", observations: ["git-status", "git-log", "tree", "codemap"] },
		},
		{
			name: "collect precedes orientation",
			interpretation,
			facts: { ...facts, finishedDetachedBatchIds: ["batch-1", "batch-2"] },
			settings,
			expected: { kind: "collect", batchIds: ["batch-1", "batch-2"] },
		},
		{
			name: "focused breadth stays with the model",
			interpretation: { ...interpretation, orientation: { ...interpretation.orientation, breadth: "focused" } },
			facts,
			settings,
			expected: { kind: "none", reason: "below-threshold" },
		},
	];
	strictEqual(cases.length, 14);
	for (const entry of cases)
		deepStrictEqual(decide(entry.interpretation, entry.facts, entry.settings), entry.expected, entry.name);
	for (const intent of ["implement", "continue", "interview"] as const) {
		deepStrictEqual(
			decide({ ...interpretation, intent }, facts, settings),
			{ kind: "none", reason: "below-threshold" },
			`${intent} veto`,
		);
	}
	deepStrictEqual(
		decide({ ...interpretation, orientation: { ...interpretation.orientation, wanted: false } }, facts, settings),
		{ kind: "none", reason: "below-threshold" },
		"orientation needs the site to have asked for it",
	);
	deepStrictEqual(
		decide(null, { ...facts, finishedDetachedBatchIds: ["batch-1", "batch-2"] }, settings),
		{ kind: "collect", batchIds: ["batch-1", "batch-2"] },
		"collect requires no interpretation",
	);
});

it("lets an expected dispatch suppress the scout only when it reads at least as strongly as the orientation", () => {
	const read = (orientation: number, dispatch: number): WorkflowDecision =>
		decide(
			{
				...interpretation,
				orientation: { wanted: true, breadth: "repository", probability: orientation },
				dispatch: { expected: true, probability: dispatch },
			},
			facts,
			settings,
		);
	// "Give me a tour of this codebase.": the request is an orientation the model then did not dispatch for.
	strictEqual(read(0.98, 0.71).kind, "orientation");
	// A request that names the delegation: dispatch outweighs the orientation, so the model's own dispatch stands.
	deepStrictEqual(read(0.84, 0.97), { kind: "none", reason: "model-dispatching" });
	// A producer that gives no probabilities keeps the plain expectation.
	deepStrictEqual(decide({ ...interpretation, dispatch: { expected: true } }, facts, settings), {
		kind: "none",
		reason: "model-dispatching",
	});
});

it("hashes sorted nested facts and decisions, covers operator text, and compares every fingerprint component", () => {
	const reordered = Object.fromEntries(Object.entries(facts).reverse()) as unknown as TurnFacts;
	deepStrictEqual(factsDigest(reordered), factsDigest(facts));
	strictEqual(
		factsDigest({ ...facts, workspace: { codemapHash: "map", dirtyTreeHash: "clean", gitHead: "head", cwd: "/repo" } }),
		factsDigest(facts),
	);
	match(factsDigest(facts), /^[a-f0-9]{64}$/);
	notStrictEqual(factsDigest({ ...facts, operatorText: "give me a tour" }), factsDigest(facts));
	strictEqual(decisionHash({ reason: "off", kind: "none" }), decisionHash({ kind: "none", reason: "off" }));
	notStrictEqual(decisionHash({ kind: "none", reason: "off" }), decisionHash({ kind: "none", reason: "constraints" }));
	ok(fingerprintEquals(facts.workspace, { ...facts.workspace }));
	for (const key of ["cwd", "gitHead", "dirtyTreeHash", "codemapHash"] as const)
		strictEqual(fingerprintEquals(facts.workspace, { ...facts.workspace, [key]: "changed" }), false, key);
});

it("renders complete cited findings within 4000 characters and bounds the request to 300 code points", () => {
	const findings = Array.from({ length: 5 }, (_, index) => ({
		claim: `${index}: ${"x".repeat(1000)}`,
		path: `src/${index}.ts`,
		line: index + 1,
	}));
	const rendered = renderOrientationBlock({
		runId: "run",
		receiptDigest: "123456789012abcdef",
		findings,
		ungrounded: [],
		toolCalls: 12,
		budget: 36,
		split: null,
		groundingLine: "validation: cited",
	});
	ok(rendered.length <= 4000);
	const included = rendered.split("\n").filter((entry) => entry.startsWith("- "));
	deepStrictEqual(
		included,
		findings.slice(0, 3).map((finding) => `- ${finding.claim} (${finding.path}:${finding.line})`),
	);
	match(rendered, /receipt 123456789012\)/);
	match(rendered, /Limitations: 12\/36 tool calls; split: none; validation: cited/);
	ok(rendered.endsWith("Answer the user from these findings. Use focused reads only for specific facts still missing."));
	const raw = `  ${"😀  ".repeat(350)}tail `;
	const question = orientationQuestion(raw, "repository", 4);
	const text = Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, 300).join("");
	strictEqual(
		question,
		`Orient a newcomer to this repository for the request: "${text}".\nReport purpose, top-level layout, entry points, how it is built and checked, key boundaries or\ninvariants, and where the request's subject lives if it names one. Cite paths. If independent\nareas need separate investigation, return a split of at most 4 subtasks.`,
	);
	strictEqual(Array.from(text).length, 300);
	match(question, /split of at most 4 subtasks\.$/);
	strictEqual(
		renderCollectedBlock("sealed findings"),
		"[Collected]\nThese detached runs finished and Clio collected them; their sealed receipts are the durable record. Use these results for synthesis and do not call monitor to collect them again.\n\nsealed findings",
	);
	match(
		renderDirectionBlock({ cwd: "/repo", git: null, tree: ["src", "tests"], codemap: null }),
		/cwd: \/repo\ngit: none\ntree: src, tests\ncodemap: none/,
	);
	strictEqual(renderOrientationUnavailable("run", "canceled").split("\n").length, 1);
});

it("round-trips turn-control defaults and validates workflows and bounds with next-turn timing", () => {
	const defaults = validateSettings(parse(DEFAULT_SETTINGS_YAML));
	deepStrictEqual(defaults.issues, []);
	deepStrictEqual(defaults.settings.turnControl, DEFAULT_SETTINGS.turnControl);
	const unknown = validateSettings({ turnControl: { workflows: ["orientation", "invented"] } });
	strictEqual(unknown.issues[0]?.path, "turnControl.workflows[1]");
	match(unknown.issues[0]?.message ?? "", /orientation.*direction.*ledger-facts.*detached-collection/);
	for (const maxSplit of [0, 5, 1.5])
		strictEqual(
			validateSettings({ turnControl: { orientation: { maxSplit } } }).issues[0]?.path,
			"turnControl.orientation.maxSplit",
		);
	const valid = validateSettings({
		turnControl: {
			workflows: [],
			orientation: { maxSplit: 1, maxCostUsdPerTurn: 0.5 },
		},
	});
	deepStrictEqual(valid.issues, []);
	deepStrictEqual(valid.settings.turnControl, {
		workflows: [],
		orientation: { maxSplit: 1, maxCostUsdPerTurn: 0.5 },
	});
	for (const key of [
		"turnControl",
		"turnControl.workflows",
		"turnControl.orientation.maxSplit",
		"turnControl.orientation.maxCostUsdPerTurn",
	])
		strictEqual(settingsChangeKind(key), "nextTurn", key);
});
