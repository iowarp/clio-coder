import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EMPTY_WORKING_SET_VIEW, type PolicyInput } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildEvictionFields, planEviction } from "../../src/domains/context/working-set/engine.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { protectionCutoffIndex } from "../../src/domains/context/working-set/horizon.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { structuralV2Policy } from "../../src/domains/context/working-set/policies/index.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import { isProtected } from "../../src/domains/context/working-set/protect.js";
import { resolveRecall } from "../../src/domains/context/working-set/recall.js";
import { createRunEffectsRecorder, recordToolExecutionEffects } from "../../src/domains/safety/run-effects.js";
import { captureSkillContext } from "../../src/domains/session/compaction/compact.js";
import { type SessionEntry, SKILL_CONTEXT_STATE, type SkillContextState } from "../../src/domains/session/entries.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { runGatewayChain } from "../../src/tools/gateway/chain.js";
import { gatewayChainSteps } from "../../src/tools/gateway-display.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";
import { expandChainMessages, gatewayChainReceipts } from "../../src/tools/surface.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const timestamp = "2026-09-26T00:00:00.000Z";
const CWD = "/work";

type Role = "user" | "assistant" | "tool_call" | "tool_result";

/** A linear ledger: every entry parents onto the one before it, so the active path is the whole slice. */
function ledger() {
	const entries: SessionEntry[] = [];
	const push = (turnId: string, role: Role, payload: unknown): void => {
		entries.push({ kind: "message", turnId, parentTurnId: entries.at(-1)?.turnId ?? null, timestamp, role, payload });
	};
	return { entries, push };
}

/** The persisted form of a result, as the agent adapter hands it to turn persistence. */
function persisted(result: ToolResult): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	return {
		content: [{ type: "text", text: result.kind === "ok" ? result.output : result.message }],
		details: { ...result.details, kind: result.kind },
	};
}

/** A real chain aggregate over stub capabilities: reads return a large body, writes a short echo. */
async function chainResult(steps: Array<{ id: string; capability: string; args: { path: string } }>) {
	return persisted(
		await runGatewayChain(steps, {
			getSpec: () => undefined,
			call: async (capability, args) => ({
				kind: "ok",
				output: capability === "read" ? `${String(args.path)}\n${"const value = 1;\n".repeat(80)}` : `Wrote ${args.path}`,
				details: { chainAdmission: { outcome: "ok", decision: "allowed", actionClass: capability } },
			}),
		}),
	);
}

async function chainedSession(options: {
	chain: Array<{ id: string; capability: string; args: Record<string, unknown>; after?: string[] }>;
	/** The persisted aggregate; the stub chain over `chain` when absent. */
	result?: ReturnType<typeof persisted>;
	laterWrites: string[];
	/** The operator speaks again after the work, so the chain's turn is closed. */
	closeTurn?: boolean;
}) {
	const { entries, push } = ledger();
	const chainArgs = { op: "chain", steps: options.chain };
	push("u1", "user", { text: "refactor both modules" });
	push("a1", "assistant", { content: [{ type: "toolCall", id: "c1", name: "gateway", arguments: chainArgs }] });
	push("c1-call", "tool_call", { toolCallId: "c1", name: "gateway", args: chainArgs });
	const result =
		options.result ??
		(await chainResult(options.chain as Array<{ id: string; capability: string; args: { path: string } }>));
	push("c1-result", "tool_result", {
		toolCallId: "c1",
		toolName: "gateway",
		isError: result.details.kind === "error",
		result,
	});
	for (const [index, path] of options.laterWrites.entries()) {
		const id = `w${index + 1}`;
		const args = { path, content: "rewritten\n" };
		push(`a-${id}`, "assistant", { content: [{ type: "toolCall", id, name: "write", arguments: args }] });
		push(`${id}-call`, "tool_call", { toolCallId: id, name: "write", args });
		push(`${id}-result`, "tool_result", {
			toolCallId: id,
			toolName: "write",
			isError: false,
			result: { content: [{ type: "text", text: `Wrote ${path}` }] },
		});
	}
	if (options.closeTurn === true) push("u2", "user", { text: "now tidy the tests" });
	push("a-done", "assistant", { content: [{ type: "text", text: "Both modules are rewritten." }] });
	return entries;
}

function resultText(entry: SessionEntry | undefined): string | undefined {
	if (entry?.kind !== "message") return undefined;
	return (entry.payload as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;
}

function policyInput(entries: SessionEntry[], pressureTokens = 0): PolicyInput {
	return {
		entries,
		view: EMPTY_WORKING_SET_VIEW,
		cwd: CWD,
		// One protected step: everything before the final reply is a candidate.
		settings: { ...DEFAULT_WORKING_SET_SETTINGS, protectLastTurns: 1, protectLastSteps: 1 },
		pressure: { tokens: pressureTokens, contextWindow: 100_000, threshold: 0.8, target: 0.6 },
		estimateTokens: (entry) => Math.ceil(JSON.stringify(entry).length / 4),
	};
}

function aggregateProtected(entries: SessionEntry[]): boolean {
	const input = policyInput(entries);
	const entryIndex = entries.findIndex((entry) => entry.turnId === "c1-result");
	const entry = entries[entryIndex];
	ok(entry);
	return isProtected(entry, {
		entryIndex,
		cutoffIndex: protectionCutoffIndex(entries, input.settings),
		input,
		index: buildPathIndex(entries, { cwd: CWD }),
	});
}

const TWO_READS = [
	{ id: "ra", capability: "read", args: { path: "a.ts" } },
	{ id: "rb", capability: "read", args: { path: "b.ts" } },
];

describe("chain aggregate output", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-chain-output-");
	});
	afterEach(() => env.restore());

	it("shows raw multi-line file content under a step header instead of an escaped JSON string", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "yolo" });
		registerAllTools(registry, { mcpCapabilities: false });
		const content = 'export const greeting = "say \\"hi\\"";\n\tconst dir = "C:\\\\temp";\nline three\n';
		const source = join(env.dir, "greeting.ts");
		writeFileSync(source, content);
		const verdict = await registry.invoke({
			tool: "gateway",
			args: { op: "chain", steps: [{ id: "src", capability: "read", args: { path: source } }] },
		});
		ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
		const text = verdict.result.output;
		match(text, /^Chain complete: 1 of 1 step settled\.\n\n### step src \(read\): ok\n/u);
		ok(text.includes(content.trimEnd()), `the file bytes reach the model unescaped:\n${text}`);
		ok(!text.includes('\\"say'), "no JSON string escaping");
		deepStrictEqual(verdict.result.details?.steps, [{ id: "src", capability: "read", kind: "ok", truncated: false }]);
	});

	it("keeps a chained skill load provable for compaction's skill context", async () => {
		const body = "Follow the scientific workflow step by step.\n".repeat(900);
		const activation = {
			name: "diagram",
			filePath: "/skills/diagram/SKILL.md",
			hash: "a".repeat(64),
			source: "clio-coder",
			sourceOrigin: "project",
			triggeredBy: "tool" as const,
			turnId: "request",
			drift: "match" as const,
		};
		const bytes = Buffer.byteLength(body);
		const loadArgs = { scope: "skills", name: "diagram" };
		const chainArgs = {
			op: "chain",
			steps: [
				{ id: "load", capability: "context", args: loadArgs },
				{ id: "save", capability: "write", after: ["load"], args: { path: "never.txt", content: "x" } },
			],
		};
		const aggregate = persisted(
			await runGatewayChain(chainArgs.steps, {
				getSpec: () => undefined,
				call: async () => ({
					kind: "ok",
					output: body,
					details: {
						name: activation.name,
						path: activation.filePath,
						hash: activation.hash,
						source: activation.source,
						sourceOrigin: activation.sourceOrigin,
						scope: "project",
						sourceInfo: { path: activation.filePath, scope: "project", source: "project" },
						drift: "match",
						observation: { truncated: false, shownBytes: bytes, totalBytes: bytes },
					},
				}),
			}),
		);
		const text = aggregate.content[0]?.text ?? "";
		match(text, /^Chain paused: 1 of 2 steps settled\. Pending: save\.\nBoundary: skill loaded by load; /u);
		ok(text.includes(`### step load (context): ok\n${body}`), "the activation body is not cut by the step allowance");

		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "request",
				parentTurnId: null,
				timestamp,
				role: "user",
				payload: { text: "[Skill request] diagram", operatorText: "" },
			},
			{
				kind: "message",
				turnId: "assistant",
				parentTurnId: "request",
				timestamp,
				role: "assistant",
				payload: { content: [{ type: "toolCall", id: "load", name: "gateway", arguments: chainArgs }] },
			},
			{
				kind: "message",
				turnId: "call",
				parentTurnId: "assistant",
				timestamp,
				role: "tool_call",
				payload: { toolCallId: "load", name: "gateway", args: chainArgs },
			},
			{ kind: "skillActivation", turnId: "activation", parentTurnId: "request", timestamp, activation },
			{
				kind: "message",
				turnId: "result",
				parentTurnId: "call",
				timestamp,
				role: "tool_result",
				payload: {
					toolCallId: "load",
					toolName: "gateway",
					isError: false,
					outcome: "ok",
					resultSummary: { bytes: Buffer.byteLength(text), truncated: false },
					result: aggregate,
				},
			},
			{
				kind: "message",
				turnId: "task",
				parentTurnId: "result",
				timestamp,
				role: "user",
				payload: { text: "Continue the map." },
			},
		];
		const selection: SkillContextState = { version: 1, activationRefs: ["activation"] };
		const captured = captureSkillContext(entries, selection);
		ok(captured, "the chained load is recovered from the plain-text aggregate");
		deepStrictEqual(captured.skills[0]?.content, [{ type: "text", text: body }]);
		strictEqual(captured.skills[0]?.resultRef, "result");

		// Replay parity: the verified, selected load is rebuilt whole for the
		// model, past the ordinary replay cap; unselected, it keeps the cap.
		const replayedLoad = (ledger: SessionEntry[]) => {
			const message = buildModelReplayAgentMessagesFromTurns(ledger).find(
				(candidate) => candidate.role === "toolResult" && candidate.toolCallId === "load",
			) as { content?: Array<{ text?: string }> } | undefined;
			return message?.content?.map((block) => block.text ?? "").join("") ?? "";
		};
		ok(text.length > 20_000, "the load is larger than the replay cap");
		const selected: SessionEntry[] = [
			...entries,
			{
				kind: "custom",
				turnId: "skill-state",
				parentTurnId: "task",
				timestamp,
				customType: SKILL_CONTEXT_STATE,
				data: selection,
			},
		];
		strictEqual(replayedLoad(selected), text, "a verified selected skill load replays whole");
		match(replayedLoad(entries), /more characters truncated from replay context\]$/u, "no selection, no exemption");

		const steps = aggregate.details.steps as Array<{ truncated: boolean }>;
		ok(steps[0]);
		steps[0].truncated = true;
		strictEqual(captureSkillContext(entries, selection), undefined, "a step marked truncated proves nothing");
		steps[0].truncated = false;
		aggregate.content[0] = { type: "text", text: text.replace(body, body.slice(0, -1)) };
		strictEqual(
			captureSkillContext(entries, selection),
			undefined,
			"a body that is not whole under its header proves nothing",
		);
	});
});

describe("chain aggregate eviction", () => {
	it("evicts a chain whose every member went stale as one unit, with a marker and recall for the whole body", async () => {
		const entries = await chainedSession({ chain: TWO_READS, laterWrites: ["a.ts", "b.ts"] });
		const input = policyInput(entries);
		deepStrictEqual(structuralV2Policy.select(input), [
			{ ref: { entry: "c1-result" }, reason: "stale_after_mutation", by: "w1-result" },
		]);
		const plan = planEviction(structuralV2Policy, input);
		ok(plan);
		strictEqual(plan.items.length, 1);
		const eviction: SessionEntry = {
			...buildEvictionFields(plan, { trigger: "pressure", pressureBefore: 0.9, snapshotIdBefore: null }),
			turnId: "eviction",
			parentTurnId: entries.at(-1)?.turnId ?? null,
			timestamp,
		};
		const withEviction = [...entries, eviction];
		const view = foldWorkingSet(withEviction);
		const marker = resultText(projectWorkingSet(withEviction, view).find((entry) => entry.turnId === "c1-result"));
		match(marker ?? "", /^\[evicted ref=r1 reason=stale_after_mutation by=w1-result tool=gateway /u);
		match(marker ?? "", /preview="Chain complete: 2 of 2 steps settled\./u);
		const recalled = resolveRecall(withEviction, view, "r1");
		ok(recalled.ok);
		strictEqual(
			recalled.result.body,
			resultText(entries.find((entry) => entry.turnId === "c1-result")),
			"recall returns the full aggregate, every step section",
		);
		match(recalled.result.body, /### step ra \(read\): ok\na\.ts\n[\s\S]*### step rb \(read\): ok\nb\.ts\n/u);
	});

	it("keeps a chain with one live member, and gives it up under pressure only for the weakest reason", async () => {
		const entries = await chainedSession({ chain: TWO_READS, laterWrites: ["a.ts"] });
		strictEqual(aggregateProtected(entries), false, "no member is kept on its own");
		deepStrictEqual(structuralV2Policy.select(policyInput(entries)), [], "b.ts is still live, so the whole body stays");
		// Age explains every member; the aggregate then leaves for age rather
		// than for the stale read, because age is what let the live read go.
		deepStrictEqual(structuralV2Policy.select(policyInput(entries, 1_000_000)), [
			{ ref: { entry: "c1-result" }, reason: "age_horizon" },
		]);

		// A chained write is judged as a standalone write: kept while the turn
		// that made it is in flight, then evictable by age like any echo.
		const chain = [
			{ id: "ra", capability: "read", args: { path: "a.ts" } },
			{ id: "wc", capability: "write", args: { path: "c.ts" } },
		];
		const active = await chainedSession({ chain, laterWrites: ["a.ts"] });
		strictEqual(aggregateProtected(active), true, "the turn in flight still stands on the chained write");
		deepStrictEqual(structuralV2Policy.select(policyInput(active, 1_000_000)), []);
		const closed = await chainedSession({ chain, laterWrites: ["a.ts"], closeTurn: true });
		strictEqual(aggregateProtected(closed), false, "a closed-turn write is no stricter than a standalone one");
		deepStrictEqual(structuralV2Policy.select(policyInput(closed)), [], "without pressure the write has no reason");
		deepStrictEqual(structuralV2Policy.select(policyInput(closed, 1_000_000)), [
			{ ref: { entry: "c1-result" }, reason: "age_horizon" },
		]);
	});
});

describe("chain step whose result binding failed", () => {
	/** A read, a write bound to that read's result, and two steps the failure must keep from running. */
	const PLAN = (bindingPath: string[]) => [
		{ id: "ra", capability: "read", args: { path: "a.ts" } },
		{ id: "wb", capability: "write", args: { path: { $from: "ra", path: bindingPath }, content: "x\n" } },
		{ id: "rc", capability: "read", args: { path: "c.ts" }, after: ["wb"] },
		{ id: "rd", capability: "read", args: { path: "d.ts" } },
	];
	const run = async (bindingPath: string[]) => {
		const calls: string[] = [];
		const result = persisted(
			await runGatewayChain(PLAN(bindingPath), {
				getSpec: () => undefined,
				call: async (capability, args) => {
					calls.push(`${capability}:${JSON.stringify(args.path)}`);
					return {
						kind: "ok",
						output: capability === "read" ? `${String(args.path)}\n${"const value = 1;\n".repeat(80)}` : `Wrote ${args.path}`,
						details: {
							...(capability === "read" ? { file: "b.ts" } : {}),
							chainAdmission: { outcome: "ok", decision: "allowed", actionClass: capability },
						},
					};
				},
			}),
		);
		return { result, calls };
	};

	it("settles as a visible failed step that never ran, stops scheduling, and records no effect", async () => {
		const { result, calls } = await run(["details", "missing"]);
		deepStrictEqual(calls, ['read:"a.ts"'], "only the read ran; the write never executed");
		strictEqual(result.details.kind, "error");
		deepStrictEqual(result.details.pending, ["rc", "rd"], "scheduling stopped at the failure");
		deepStrictEqual(
			(result.details.steps as Array<{ id: string; kind: string }>).map((row) => [row.id, row.kind]),
			[
				["ra", "ok"],
				["wb", "error"],
			],
		);
		const wire = result.details.chainResults as Array<Record<string, unknown>>;
		const failed = wire.find((child) => child.id === "wb");
		ok(failed, "the failed attempt is in the receipt contract");
		strictEqual(failed.bindingError, "missing result path for ra");
		strictEqual("args" in failed, false, "no resolved arguments are fabricated");
		deepStrictEqual(failed.requestedArgs, PLAN(["details", "missing"])[1]?.args);

		const aggregate = { details: result.details };
		deepStrictEqual(
			gatewayChainSteps("gateway", aggregate).map((step) => [step.id, step.isError, step.bindingError ?? null]),
			[
				["ra", false, null],
				["wb", true, "missing result path for ra"],
			],
			"displays show the failed step",
		);
		deepStrictEqual(
			gatewayChainReceipts("gateway", aggregate).map((child) => child.id),
			["ra"],
			"receipts count only operations that ran",
		);
		const entry = {
			kind: "message",
			role: "tool_result",
			turnId: "t",
			payload: { toolCallId: "c1", toolName: "gateway", isError: true, result },
		};
		deepStrictEqual(
			expandChainMessages([entry])
				.slice(1)
				.map((child) => (child as { payload: { toolCallId: string } }).payload.toolCallId),
			["c1:ra", "c1:ra"],
			"ledger expansion yields no call or result for the unresolved step",
		);
		const recorder = createRunEffectsRecorder(CWD);
		recordToolExecutionEffects(recorder, {
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "gateway",
			args: { op: "chain", steps: PLAN(["details", "missing"]) },
		});
		recordToolExecutionEffects(recorder, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "gateway",
			result,
			isError: true,
		});
		const effects = recorder.snapshot();
		deepStrictEqual([...effects.mutatedPaths], []);
		deepStrictEqual([...effects.failedMutationPaths], [], "a write that never ran is not a refused attempt");
	});

	it("keeps the aggregate through eviction selection while its failure is unresolved", async () => {
		const failed = (await run(["details", "missing"])).result;
		const resolved = (await run(["details", "file"])).result;
		strictEqual(resolved.details.kind, "ok");
		// The read went stale, the turn closed, and pressure is high: every rung
		// but the unresolved failure argues for eviction, and the body is far
		// above the floor, so nothing but the failure can keep it.
		const session = (result: ReturnType<typeof persisted>) =>
			chainedSession({ chain: PLAN([]), result, laterWrites: ["a.ts", "b.ts"], closeTurn: true });
		const control = await session(resolved);
		deepStrictEqual(
			structuralV2Policy.select(policyInput(control, 1_000_000)).map((item) => item.ref.entry),
			["c1-result"],
			"the same aggregate with the binding resolved is evictable",
		);
		const entries = await session(failed);
		strictEqual(aggregateProtected(entries), true);
		deepStrictEqual(structuralV2Policy.select(policyInput(entries, 1_000_000)), []);
	});
});
