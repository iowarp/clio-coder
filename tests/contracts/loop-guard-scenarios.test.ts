import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../../src/core/guardrails.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { type TurnConstraints, turnScopeGuidance } from "../../src/core/turn-constraints.js";
import { parseExtensionRuntimeV2 } from "../../src/domains/extensions/runtime-schema-v2.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import {
	type CreateLoopGuardRegistrationOptions,
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
	readOrchTurnToolCallBudget,
} from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { reserveObservation } from "../../src/tools/observation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type GuardCall, type GuardResult, loopSafety, runGuardScenario } from "../harness/loop-guard.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Each row replays one turn's tool calls through the loop guard and names the
// fix it pins: #445 bash repeat credit, F-C13 result credit for a stateful
// tool, WTF-P 0.8.3 A1 mutation reset and A2 batch siblings, the restated prior
// failure, the per-tool budget breakdown, and WTF-P 0.8.3 B4 template budgets.

interface Row {
	name: string;
	guard: Omit<CreateLoopGuardRegistrationOptions, "safety">;
	calls: GuardCall[];
	admitted: boolean[];
	/** Block reasons by index, or every one, that must (or with `false`, must not) match. */
	reasons?: ReadonlyArray<[at: number | "every", pattern: RegExp, matches?: false]>;
}

function check(row: Row): void {
	const run = runGuardScenario(row.guard, row.calls);
	deepStrictEqual(run.admitted, row.admitted, row.name);
	for (const [at, pattern, matches = true] of row.reasons ?? []) {
		for (const reason of at === "every" ? run.reasons : [run.reasons[at] ?? ""])
			strictEqual(pattern.test(reason), matches, `${row.name}: reason ${at} ${pattern}: ${reason}`);
	}
}

const times = (count: number, make: (index: number) => GuardCall): GuardCall[] =>
	Array.from({ length: count }, (_, index) => make(index));
const each = (count: number, value: boolean): boolean[] => Array.from({ length: count }, () => value);
/** Each group is one model response, so a group's calls share a batch. */
const rounds = (...groups: GuardCall[][]): GuardCall[] =>
	groups.flatMap((group, index) => group.map((call) => ({ ...call, batch: `r${index}` })));

const poll = (result: GuardResult): GuardCall => ({
	tool: "bash",
	args: { command: "sleep 300; gh pr checks 42", timeout_ms: 600_000 },
	result,
});
const stateful = (output: string): GuardCall => ({ tool: "extension_wtfp__next_step", args: {}, result: { output } });
const pollGuard = { turnBlockBudget: 2, turnSynthesisLockout: true };

test("loop guard repeat credit: a slow or changing repeat runs on, a fast identical one blocks (#445, F-C13)", () => {
	const rows: Row[] = [
		{
			name: "still blocks a fast identical command with an identical result on its third call",
			guard: pollGuard,
			calls: times(3, () => poll({ elapsedMs: 100, output: "pending" })),
			admitted: [true, true, false],
		},
		{
			name: "locks a worker's tools on the third block of one identical call, whatever run budget is left",
			guard: { ...pollGuard, turnBlockBudget: 15 },
			calls: times(5, () => poll({ elapsedMs: 100, output: "calc.py | 2 +" })),
			admitted: [true, true, false, false, false],
			reasons: [
				[1, /disabled/u, false],
				[2, /disabled/u],
			],
		},
		{
			name: "lets a slow identical command keep polling on an unchanged result",
			guard: pollGuard,
			calls: times(12, () => poll({ elapsedMs: 300_000, output: "pending" })),
			admitted: each(12, true),
		},
		{
			name: "counts a run of exactly 5 s as slow and one just under it as fast: 5,000 ms",
			guard: pollGuard,
			calls: times(6, () => poll({ elapsedMs: 5_000, output: "pending" })),
			admitted: each(6, true),
		},
		{
			name: "counts a run of exactly 5 s as slow and one just under it as fast: 4,999 ms",
			guard: pollGuard,
			calls: times(3, () => poll({ elapsedMs: 4_999, output: "pending" })),
			admitted: [true, true, false],
		},
		{
			name:
				"lets a fast identical command keep polling while its result changes, failing results included: changing output",
			guard: pollGuard,
			calls: times(10, (index) => poll({ elapsedMs: 100, output: `pending ${index}` })),
			admitted: each(10, true),
		},
		{
			name:
				"lets a fast identical command keep polling while its result changes, failing results included: failing output",
			guard: pollGuard,
			calls: times(10, (index) => poll({ elapsedMs: 100, output: `exit 8: ${index} pending`, failed: true })),
			admitted: each(10, true),
		},
		{
			name: "leaves the turn tool budget in force over a credited poll",
			guard: { ...pollGuard, turnToolCallBudget: () => ({ soft: 5, hard: 8 }) },
			calls: times(7, () => poll({ elapsedMs: 300_000, output: "pending" })),
			admitted: [...each(5, true), false, false],
		},
		{
			name: "admits identical-argument calls whose results differ",
			guard: pollGuard,
			calls: times(6, (index) => stateful(`step ${index + 1}: draft section ${index + 1}`)),
			admitted: each(6, true),
		},
		{
			name: "still blocks the third identical call when its results were identical, and says they matched",
			guard: pollGuard,
			calls: times(3, () => stateful("step 4: review the outline")),
			admitted: [true, true, false],
			reasons: [[0, /calling it again returns the same text/u]],
		},
		{
			// FX-48: bash takes no size arguments, so its stagnation refusal names the command, not limit/offset.
			name: "tells a fast poll that settled on one output to change the command, never naming size arguments",
			guard: pollGuard,
			calls: ["pending", "done", "done", "done"].map((output) => poll({ elapsedMs: 100, output })),
			admitted: [true, true, true, false],
			reasons: [
				[0, /the same bash command returned byte-identical output 2 times in a row\. Change the command or stop/u],
				[0, /limit|offset|size argument/u, false],
			],
		},
		{
			name: "blocks once a changing tool settles on one result",
			guard: pollGuard,
			calls: ["step 1", "step 2", "done", "done", "done"].map(stateful),
			admitted: [true, true, true, true, false],
		},
	];
	for (const row of rows) check(row);
});

const READ_TRAITS = { readOnly: true, idempotent: true };
const record = (uri: string): GuardCall => ({
	tool: "extension_wtfp__read_record",
	args: { uri },
	traits: READ_TRAITS,
});
const read = record("project://manifest");
const write: GuardCall = {
	tool: "extension_wtfp__record",
	args: { uri: "project://manifest", record: {} },
	traits: { readOnly: false, idempotent: false },
};
const bash = (command: string): GuardCall => ({ tool: "bash", args: { command } });
const nextStep = (after: string, output?: string): GuardCall => ({
	tool: "extension_wtfp__next_step",
	args: { after },
	traits: { readOnly: false, idempotent: false },
	...(output === undefined ? {} : { result: { output } }),
});
const gitStatus: GuardCall = { tool: "git", args: { op: "status" } };
const gitAdd = { op: "add", paths: ["a.txt"] };
const status: GuardCall = { tool: "extension_wtfp__status", args: {}, traits: READ_TRAITS };
/** The orchestrator's guard, with its interactive budgets and the synthesis lockout. */
const orchestrator = {
	turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
	sameCallBlockLimit: INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
	turnSynthesisLockout: true,
};

test("loop guard resets identical-call counts on a mutation, and one block never disables its batch (WTF-P 0.8.3 A1, A2)", () => {
	// The traits the rows give the wtfp tools are the ones an api 2 runtime declares.
	const runtime = parseExtensionRuntimeV2({
		api: 2,
		entrypoint: "runtime/extension.ts",
		tools: [
			{ name: "read_record", description: "Read.", inputSchema: { type: "object" }, readOnly: true, idempotent: true },
			{ name: "record", description: "Write one record.", inputSchema: { type: "object" } },
		],
		permissions: { fs: { read: ["workspace"], write: [".planning"] }, exec: false, net: false },
	});
	deepStrictEqual(
		runtime.tools.map((tool) => [tool.name, { readOnly: tool.readOnly, idempotent: tool.idempotent }]),
		[
			["read_record", read.traits],
			["record", write.traits],
		],
		"parses readOnly and idempotent on an api 2 tool, and a read tool defaults to read-only",
	);
	const [a, b, c] = ["a", "b", "c"].map((family) => record(`project://${family}`)) as [GuardCall, GuardCall, GuardCall];
	const rows: Row[] = [
		{
			name: "admits read, read, write, read",
			guard: orchestrator,
			calls: rounds([read], [read], [write], [read]),
			admitted: each(4, true),
		},
		{
			name: "still blocks read, read, read with no write between",
			guard: orchestrator,
			calls: rounds([read], [read], [read]),
			admitted: [true, true, false],
			reasons: [[0, /loop detected/u]],
		},
		{
			name: "reads a bash command that may write as a mutation, and a plain read command as none: build",
			guard: orchestrator,
			calls: rounds([read], [read], [bash("pnpm run build")], [read]),
			admitted: each(4, true),
		},
		{
			name: "reads a bash command that may write as a mutation, and a plain read command as none: status",
			guard: orchestrator,
			calls: rounds([read], [read], [bash("git status --short 2>/dev/null")], [read]),
			admitted: [true, true, true, false],
		},
		{
			name: "counts a typed git add as a mutation and alternating shell inspections as none (Astra r2-4): git add",
			guard: orchestrator,
			calls: rounds([gitStatus], [gitStatus], [{ tool: "git", args: gitAdd }], [gitStatus]),
			admitted: each(4, true),
		},
		{
			name: "counts a typed git add as a mutation and alternating shell inspections as none (Astra r2-4): gateway git add",
			guard: orchestrator,
			calls: rounds(
				[gitStatus],
				[gitStatus],
				[{ tool: "gateway", args: { op: "call", capability: "git", args: gitAdd } }],
				[gitStatus],
			),
			admitted: each(4, true),
		},
		{
			name: "counts a typed git add as a mutation and alternating shell inspections as none (Astra r2-4): pwd, whoami",
			guard: orchestrator,
			calls: rounds([bash("pwd")], [bash("whoami")], [bash("pwd")], [bash("whoami")], [bash("pwd")]),
			admitted: [true, true, true, true, false],
		},
		{
			name: "never counts a tool declared neither read-only nor idempotent as a verbatim repeat",
			guard: orchestrator,
			calls: rounds(...[0, 1, 2, 3].map((index) => [nextStep("start", `step ${index}`)])),
			admitted: each(4, true),
		},
		{
			name: "leaves the other three calls of a parallel batch of four admitted",
			guard: orchestrator,
			calls: rounds([read], [read], [read, ...["sections", "sources", "evidence"].map((f) => record(`project://${f}`))]),
			admitted: [true, true, false, true, true, true],
			reasons: [[0, /disabled/u, false]],
		},
		{
			name: "keeps next_step running when two repeated reads share its batch, as in session 12a2ef54ae558d9f",
			guard: orchestrator,
			calls: rounds(
				[read, record("project://state")],
				[read, record("project://state")],
				[
					read,
					record("project://state"),
					record("project://validations/milestone-submission-01"),
					nextStep("submit-milestone"),
				],
			),
			admitted: [true, true, true, true, false, false, true, true],
			reasons: [["every", /disabled/u, false]],
		},
		{
			// Both copies of the repeat are blocked; the second locks the turn, but the
			// status call the same response emitted still runs.
			name: "locks only when the same call is blocked twice, and spares the siblings of the turn's first block",
			guard: orchestrator,
			calls: rounds([read], [read], [read, read, status], [status]),
			admitted: [true, true, false, false, true, false],
			reasons: [[1, /disabled for the rest of this turn/u]],
		},
		{
			name: "tolerates two blocks of different calls before the third locks the turn",
			guard: orchestrator,
			calls: rounds([a], [a], [b], [b], [c], [c], [a], [b], [c]),
			admitted: [...each(6, true), false, false, false],
			reasons: [
				[1, /disabled/u, false],
				[2, /disabled/u],
			],
		},
	];
	for (const row of rows) check(row);
});

test("loop guard block reasons restate a prior failure and name where the turn's calls went", () => {
	const record = (error: string): GuardCall => ({
		tool: "gateway",
		args: { op: "call", capability: "extension_desk__record", args: { uri: "project://state" } },
		result: { error },
	});
	const gateway = (capability: string, args: Record<string, unknown>): GuardCall => ({
		tool: "gateway",
		args: { op: "call", capability, args },
	});
	const read = (path: string): GuardCall => ({ tool: "read", args: { path } });
	const continues = { turnBudgetContinues: true };
	const rows: Row[] = [
		{
			name: "a blocked repeat of a failed call restates why the call failed",
			guard: { turnBlockBudget: 1, turnSynthesisLockout: true },
			calls: times(3, () => record("Not written: project://state already exists; pass expect_revision.\nDetails follow.")),
			admitted: [true, true, false],
			reasons: [
				[0, /disabled for the rest of this turn/u],
				[
					0,
					/\nThe identical call failed earlier with:\nNot written: project:\/\/state already exists; pass expect_revision\. Details follow\.\nFix/u,
				],
			],
		},
		{
			name: "a restated validation failure keeps the fields it names and drops the echoed arguments",
			guard: { turnBlockBudget: 1, turnSynthesisLockout: true },
			calls: times(3, () =>
				record(
					'Validation failed for tool "extension_desk__record":\n  - issues: unknown field\n  - next_actions: unknown field\n\nReceived arguments:\n{"uri":"x"}',
				),
			),
			admitted: [true, true, false],
			reasons: [
				[
					0,
					/\nThe identical call failed earlier with:\nValidation failed for tool "extension_desk__record": issues: unknown field; next_actions: unknown field\nFix/u,
				],
			],
		},
		{
			name: "the soft tool budget refusal names where the turn's calls went",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 18 }) },
			calls: [
				{ tool: "read", args: { path: "a.md" } },
				{ tool: "read", args: { path: "b.md" } },
				gateway("extension_desk__next_step", {}),
				gateway("extension_desk__record", { uri: "project://x" }),
			],
			admitted: [true, true, true, false],
			reasons: [
				[0, /soft budget 3/u],
				[0, /This turn's calls by tool: read 2, extension_desk__next_step 1, extension_desk__record 1\./u],
			],
		},
		{
			name:
				"a parallel batch that crosses the soft budget when a continuation follows runs whole and rolls the turn (XR-6)",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 18 }) },
			calls: rounds(
				[read("a.md")],
				[read("b.md")],
				[
					{ tool: "verify", args: { check: "typecheck" }, metadata: continues },
					{ tool: "verify", args: { check: "lint" }, metadata: continues },
					{ ...read("c.md"), metadata: continues },
				],
				[{ ...read("d.md"), metadata: continues }],
			),
			admitted: [true, true, true, true, true, false],
			reasons: [
				[0, /this turn has made its 3 tool calls/u],
				[0, /continuation turn follows automatically/u],
				[0, /end your reply\./u, false],
			],
		},
		{
			name: "a wide-parallel route's measured width scales the soft budget and the refusal names the scaling (CLI-P26)",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 18 }) },
			calls: times(7, (index) => ({ ...read(`${index}.md`), metadata: { turnBudgetScale: 2 } })),
			admitted: [true, true, true, true, true, true, false],
			reasons: [
				[
					0,
					/soft budget 6, safety\.limits\.chatToolCallsPerTurn 3 scaled x2\.0 for this route's measured calls per round/u,
				],
			],
		},
		{
			name: "a refused batch counts as one refused attempt, so its siblings never bring a later call to the hard ceiling",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 5 }) },
			calls: rounds(
				[read("a.md")],
				[read("b.md")],
				times(3, (index) => read(`${index}.md`)),
				[read("d.md")],
				[read("e.md")],
			),
			admitted: [true, true, false, false, false, false, false],
			reasons: [
				[3, /this turn has made its 3 tool calls/u],
				[3, /hard ceiling/u, false],
				[4, /passed the hard ceiling \(5\); the turn is being stopped/u],
			],
		},
		{
			name:
				"a parallel batch that exactly fills the soft budget runs whole, and without a continuation the refusal asks for a summary",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 18 }) },
			calls: rounds([read("a.md")], [read("b.md"), read("c.md")], [read("d.md"), read("e.md")]),
			admitted: [true, true, true, false, false],
			reasons: [
				["every", /continuation/u, false],
				["every", /state the single next step you propose, and end your reply\./u],
			],
		},
		{
			name:
				"a parallel batch wider than the whole soft budget keeps the per-call cut, so no continuation can refuse it again",
			guard: { turnToolCallBudget: () => ({ soft: 3, hard: 18 }) },
			calls: rounds(times(5, (index) => read(`${index}.md`))),
			admitted: [true, true, true, false, false],
			reasons: [["every", /this turn has made its 3 tool calls/u]],
		},
		{
			name:
				"two direct finish attempts called alone stay admitted past a spent budget; one beside an edit, a gateway-wrapped one or a third is refused (CLI-P43)",
			guard: { turnToolCallBudget: () => ({ soft: 2, hard: 3 }) },
			calls: [
				...times(5, (index) => read(`${index}.md`)),
				// One response: the finish would end the turn over its refused sibling.
				{ tool: "edit", args: { path: "a.ts", edits: [] }, batch: "b1" },
				{ tool: "finish", args: { state: "done" }, batch: "b1" },
				{ tool: "finish", args: { state: "partly_done" } },
				{ tool: "gateway", args: { op: "call", capability: "finish", args: { state: "done" } } },
				{ tool: "finish", args: { state: "done", remaining: ["a"] } },
				{ tool: "finish", args: { state: "done", remaining: ["b"] } },
			],
			admitted: [true, true, false, false, false, false, false, true, false, true, false],
			reasons: [
				[1, /passed the hard ceiling \(3\)/u],
				[3, /passed the hard ceiling/u],
				[4, /passed the hard ceiling/u],
				[5, /passed the hard ceiling/u],
				[6, /passed the hard ceiling/u],
			],
		},
	];
	for (const row of rows) check(row);
});

interface BudgetRow {
	name: string;
	metric: "toolCalls" | "observationBytes";
	/** `safety.limits.chatToolCallsPerTurn` or `observationBytesPerTurn`. */
	operator: number;
	/** The matching `safety.limits.template*PerTurnMax`; 0 is refused and leaves it unset. */
	ceiling: number | null;
	template?: number;
	/** Calls that ran before the refusal, or the turn's observation pool in bytes. */
	limit: number;
	/** Substrings of the refusal. */
	reason?: string[];
	/** The observation pool reports the template as what bounded it. */
	named?: boolean;
	guidance?: string;
}

const TEMPLATE = "wtfp:advance";
const OBSERVATION = DEFAULT_SETTINGS.safety.limits.observationBytesPerTurn;

/** How many calls a turn under `template` ran before the loop guard's refusal, and its reason. */
async function firstRefusal(template: number | undefined): Promise<{ ran: number; reason: string }> {
	const guard = createLoopGuardRegistration({ safety: loopSafety(), turnToolCallBudget: readOrchTurnToolCallBudget });
	const registry = createRegistry({
		safety: createWorkerSafety(),
		middleware: createMiddlewareBundle({ registrations: [guard] }).contract,
	});
	registry.register({
		name: "extension_desk__status" as ToolName,
		description: "status fixture",
		parameters: Type.Object({ n: Type.Number() }),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: "fine" }),
	});
	const turnConstraints: TurnConstraints | undefined =
		template === undefined ? undefined : { budget: { toolCalls: template, template: TEMPLATE } };
	for (let n = 1; n <= 300; n++) {
		const verdict = await registry.invoke(
			{ tool: "extension_desk__status", args: { n } },
			{ sessionId: "s1", turnId: "t1", ...(turnConstraints ? { turnConstraints } : {}) },
		);
		if (verdict.kind === "blocked") return { ran: n - 1, reason: verdict.reason };
	}
	return { ran: -1, reason: "" };
}

test("template budget: min(template, max(operator, ceiling)) bounds the turn's calls and observation pool (WTF-P 0.8.3 B4)", async () => {
	const toolCalls = "lowers the turn's tool-call limit and names the template; above the cap it gets the cap";
	const ceiling120 = "a ceiling of 120 lets a budget of 100 through, clamps 200 to 120, and lowering still works";
	const pool = "lowers the turn's observation pool and names the template; above the cap it gets the cap";
	const poolCeiling = "applies the same ceiling to the observation pool";
	const rows: BudgetRow[] = [
		{
			name: `${toolCalls}: template below operator`,
			metric: "toolCalls",
			operator: 6,
			ceiling: null,
			template: 3,
			limit: 3,
			reason: [`soft budget 3, set by prompt template "${TEMPLATE}" budget.toolCalls`],
		},
		{
			name: "unset keeps a template budget lower-only",
			metric: "toolCalls",
			operator: 6,
			ceiling: null,
			template: 50,
			limit: 6,
			reason: ["soft budget 6, safety.limits.chatToolCallsPerTurn;", "templateToolCallsPerTurnMax is unset"],
		},
		{ name: `${toolCalls}: no template`, metric: "toolCalls", operator: 6, ceiling: null, limit: 6 },
		{
			name: "is an operator setting that defaults to unset and refuses a non-positive value",
			metric: "toolCalls",
			operator: 60,
			ceiling: 0,
			template: 100,
			limit: 60,
			reason: ["templateToolCallsPerTurnMax is unset"],
		},
		{
			name: `${ceiling120}: within the ceiling`,
			metric: "toolCalls",
			operator: 60,
			ceiling: 120,
			template: 100,
			limit: 100,
			reason: ["raised within safety.limits.templateToolCallsPerTurnMax 120"],
		},
		{
			name: `${ceiling120}: above the ceiling`,
			metric: "toolCalls",
			operator: 60,
			ceiling: 120,
			template: 200,
			limit: 120,
			reason: [`soft budget 120, safety.limits.templateToolCallsPerTurnMax; prompt template "${TEMPLATE}" asked for 200`],
			guidance: "at most 120 tool calls",
		},
		{
			name: `${ceiling120}: below the operator`,
			metric: "toolCalls",
			operator: 60,
			ceiling: 120,
			template: 20,
			limit: 20,
			reason: [`soft budget 20, set by prompt template "${TEMPLATE}" budget.toolCalls`],
		},
		{
			name: `${pool}: template below operator`,
			metric: "observationBytes",
			operator: OBSERVATION,
			ceiling: null,
			template: 4096,
			limit: 4096,
			named: true,
		},
		{
			name: `${pool}: template above operator`,
			metric: "observationBytes",
			operator: OBSERVATION,
			ceiling: null,
			template: 10_000_000,
			limit: OBSERVATION,
			named: false,
		},
		{
			name: `${pool}: operator below template`,
			metric: "observationBytes",
			operator: 2048,
			ceiling: null,
			template: 4096,
			limit: 2048,
		},
		{
			name: `${poolCeiling}: above the ceiling`,
			metric: "observationBytes",
			operator: OBSERVATION,
			ceiling: 400 * 1024,
			template: 512 * 1024,
			limit: 400 * 1024,
			named: true,
		},
		{
			name: `${poolCeiling}: within the ceiling`,
			metric: "observationBytes",
			operator: OBSERVATION,
			ceiling: 400 * 1024,
			template: 300 * 1024,
			limit: 300 * 1024,
		},
		{
			name: `${poolCeiling}: below the operator`,
			metric: "observationBytes",
			operator: OBSERVATION,
			ceiling: 400 * 1024,
			template: 4096,
			limit: 4096,
		},
	];
	const env = await isolateClioEnv("clio-coder-loop-guard-scenarios-");
	try {
		for (const [index, row] of rows.entries()) {
			const calls = row.metric === "toolCalls";
			const parsed = validateSettings({
				safety: {
					limits: {
						...DEFAULT_SETTINGS.safety.limits,
						[calls ? "chatToolCallsPerTurn" : "observationBytesPerTurn"]: row.operator,
						[calls ? "templateToolCallsPerTurnMax" : "templateObservationBytesPerTurnMax"]: row.ceiling,
					},
				},
			});
			const refused = row.ceiling !== null && row.ceiling < 1;
			strictEqual(
				parsed.issues.some((issue) => JSON.stringify(issue).includes("PerTurnMax")),
				refused,
				`${row.name}: ${JSON.stringify(parsed.issues)}`,
			);
			if (refused) strictEqual(parsed.settings.safety.limits.templateToolCallsPerTurnMax, null, row.name);
			configureGuardrails(guardrailValuesFromSettings(parsed.settings));
			if (calls) {
				const refusal = await firstRefusal(row.template);
				strictEqual(refusal.ran, row.limit, row.name);
				for (const text of row.reason ?? []) ok(refusal.reason.includes(text), `${row.name}: ${refusal.reason}`);
				if (row.guidance !== undefined && row.template !== undefined) {
					const guidance = turnScopeGuidance({ budget: { toolCalls: row.template, template: TEMPLATE } });
					ok(guidance.includes(row.guidance), `${row.name}: ${guidance}`);
				}
				continue;
			}
			const reservation = reserveObservation(16 * 1024, {
				sessionId: "s1",
				turnId: `t-${index}`,
				turnConstraints: { budget: { observationBytes: row.template ?? 0, template: TEMPLATE } },
			});
			strictEqual(reservation.limitBytes, row.limit, row.name);
			if (row.limit < 16 * 1024) strictEqual(reservation.callCapBytes, row.limit, row.name);
			if (row.named !== undefined)
				strictEqual(reservation.template, row.named ? TEMPLATE : undefined, `${row.name}: template`);
		}
	} finally {
		configureGuardrails(undefined);
		env.restore();
	}
});

test("loop guard read coverage: a grep between rereads keeps the count, a fold forgets what was shown (X5)", () => {
	const read = (args: Record<string, unknown> = {}, shownCount = 40): MiddlewareHookInput => ({
		hook: "after_tool",
		turnId: "turn-1",
		toolName: "read",
		toolArgs: { path: "coverage.ts", offset: 1, limit: shownCount, ...args },
		metadata: { resultKind: "ok", resultBytes: 1000 },
		toolResultDetails: {
			file: { bytes: 4000, mtimeMs: 1 },
			observation: { tool: "read", unit: "lines", format: "text", shownCount, truncated: false },
		},
	});
	const call = (toolName: string, toolArgs: Record<string, unknown>): MiddlewareHookInput => ({
		hook: "before_tool",
		turnId: "turn-1",
		toolName,
		toolArgs,
		metadata: { callFingerprint: JSON.stringify([toolName, toolArgs]) },
	});
	const grep: MiddlewareHookInput = {
		hook: "after_tool",
		turnId: "turn-1",
		toolName: "grep",
		toolArgs: { pattern: "coverage" },
		metadata: { resultKind: "ok", resultFingerprint: "coverage.ts:1" },
	};
	// Each keeps the file's size and mtime, so only the call itself can tell coverage it is stale.
	const bash = (command: string): MiddlewareHookInput => ({
		hook: "after_tool",
		turnId: "turn-1",
		toolName: "bash",
		toolArgs: { command },
		metadata: { resultKind: "ok" },
	});
	const fold = (stage: string): MiddlewareHookInput => ({
		hook: "on_compaction",
		turnId: "turn-1",
		metadata: { stage },
	});
	let locks = 0;
	// The main session's guard: block budget 3, same-call limit 2, synthesis lockout.
	const main: Omit<CreateLoopGuardRegistrationOptions, "safety"> = {
		readResultMaxBytes: () => 64 * 1024,
		turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
		sameCallBlockLimit: INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
		turnSynthesisLockout: true,
		onSynthesisLockout: () => {
			locks += 1;
		},
	};
	const subranges = [5, 12, 30, 41, 77, 90, 120, 150].flatMap((offset) => [
		call("read", { path: "coverage.ts", offset, limit: 10 }),
		read({ offset }, 10),
	]);
	const rows: Array<{
		name: string;
		steps: MiddlewareHookInput[];
		annotations: number;
		guard?: Omit<CreateLoopGuardRegistrationOptions, "safety">;
		also?: RegExp;
	}> = [
		{
			name: "read, grep, read, grep, recall, read, grep, read of one range draws the annotation on the third reread",
			steps: [read(), grep, read(), grep, fold("working_set_recall"), read(), grep, read()],
			annotations: 1,
		},
		{
			name: "read, working-set fold, then three rereads of the same range draw none",
			steps: [read(), fold("working_set_evict"), read(), read(), read()],
			annotations: 0,
		},
		{
			name: "main session: one whole read then eight subranges annotates twice and never locks or blocks",
			steps: [call("read", { path: "coverage.ts" }), read({}, 200), ...subranges, call("read", { path: "other.ts" })],
			annotations: 2,
			guard: main,
		},
		{
			name: "four page ranges of one PDF are separate coverage",
			steps: ["1-2", "3-4", "5-6", "7-8"].map((pages) => read({ pages })),
			annotations: 0,
		},
		{
			name: "four members of one archive are separate coverage",
			steps: ["a.txt", "b.txt", "c.txt", "d.txt"].map((member) => read({ member })),
			annotations: 0,
		},
		{
			name: "a throwing cap getter turns coverage off and the rest of after_tool still runs",
			steps: [call("read", { path: "coverage.ts" }), read(), read(), read(), read()],
			annotations: 0,
			guard: {
				readResultMaxBytes: () => {
					throw new Error("settings unavailable");
				},
				toolBudgetAdvisory: true,
				toolCallSoftLimit: 1,
			},
			also: /Advisory tool estimate reached/,
		},
		...["sed -i 's/a/b/' coverage.ts", "cp -p backup.ts coverage.ts", "git checkout -- coverage.ts"].map((command) => ({
			name: `${command} between rereads forgets coverage`,
			steps: [read(), read(), bash(command), read(), read()],
			annotations: 0,
		})),
	];
	for (const row of rows) {
		locks = 0;
		// A getter cap, as the main session passes its live context.toolResultMaxBytes.
		const guard = createLoopGuardRegistration({
			safety: loopSafety(),
			...(row.guard ?? { readResultMaxBytes: () => 64 * 1024 }),
		});
		const effects = row.steps.flatMap((step) => guard.evaluate(step));
		const detail = `${row.name}: ${JSON.stringify(effects)}`;
		const shown = effects.filter(
			(effect) => effect.kind === "annotate_tool_result" && effect.message.includes("already shown"),
		);
		strictEqual(shown.length, row.annotations, detail);
		// Advice, not a block: a model reads "loop detected" or "blocked" as a refusal (ACP-H5).
		ok(
			shown.every((effect) => effect.kind === "annotate_tool_result" && !/loop detected|blocked/i.test(effect.message)),
			detail,
		);
		ok(!effects.some((effect) => effect.kind === "block_tool" || effect.kind === "lock_tools"), detail);
		strictEqual(locks, 0, detail);
		if (row.also !== undefined) {
			const also = row.also;
			ok(
				effects.some((effect) => effect.kind === "annotate_tool_result" && also.test(effect.message)),
				detail,
			);
		}
	}
});
