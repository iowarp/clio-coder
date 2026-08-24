/**
 * `/oracle`: what the advisor is briefed on, what it is never briefed on, and
 * where its answer lands.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { isUserVisibleAgent, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import type { TaskBoardTask } from "../../src/domains/session/task-board.js";
import {
	formatOracleAnswer,
	ORACLE_COMPACTION_MAX_BYTES,
	ORACLE_DECISIONS_MAX_BYTES,
	ORACLE_DECISIONS_MAX_ROWS,
	ORACLE_DIGEST_MAX_BYTES,
	ORACLE_QUESTION_MAX_BYTES,
	ORACLE_TASKS_MAX_BYTES,
	ORACLE_TASKS_MAX_ROWS,
	ORACLE_TRUNCATION_MARKER,
	packOracleDigest,
} from "../../src/interactive/oracle.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function decisionEntry(decisions: DecisionLedgerEntry["decisions"]): DecisionLedgerEntry {
	return {
		kind: "decisionLedger",
		interviewId: "i1",
		interviewStatus: "complete",
		startedAt: "2026-08-24T10:00:00.000Z",
		endedAt: "2026-08-24T10:05:00.000Z",
		roundCount: 1,
		decisions,
	} as unknown as DecisionLedgerEntry;
}

function task(id: string, title: string, status: TaskBoardTask["status"]): TaskBoardTask {
	return { id, title, status, origin: "agent" };
}

function oracleReceipt(text: string, overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "or1",
		agentId: "oracle",
		outcome: "succeeded",
		exitCode: 0,
		output: { state: "final", text, bytes: Buffer.byteLength(text), truncated: false },
		...overrides,
	} as unknown as RunReceipt;
}

interface Harness {
	ctx: SlashCommandContext;
	requests: Array<Record<string, unknown>>;
	notes: string[];
	notices: string[];
}

function harness(
	options: {
		receipt?: RunReceipt;
		inFlight?: boolean;
		decisions?: DecisionLedgerEntry[];
		tasks?: TaskBoardTask[];
		compactionSummary?: string | null;
		briefing?: boolean;
	} = {},
): Harness {
	const requests: Array<Record<string, unknown>> = [];
	const notes: string[] = [];
	const notices: string[] = [];
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: Record<string, unknown>) => {
			requests.push(request);
			return {
				runId: "or1",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(
					options.receipt ??
						oracleReceipt(
							JSON.stringify({
								verdict: "consistent with routing.target",
								challenge: "the board still owes t2, so this widens scope",
								changesMyMind: "a receipt showing t2 already landed",
								citedDecisions: ["routing.target"],
							}),
						),
				),
			};
		},
	} as unknown as DispatchContract;
	const ctx = {
		io: { stdout: () => undefined, stderr: () => undefined },
		notice: (level: string, text: string) => notices.push(`${level}:${text}`),
		dispatch,
		bus: createSafeEventBus(),
		submitOperatorNote: (text: string) => notes.push(text),
		isTurnInFlight: () => options.inFlight === true,
		...(options.briefing === false
			? {}
			: {
					oracleBriefing: () => ({
						decisions: options.decisions ?? [],
						tasks: options.tasks ?? [],
						compactionSummary: options.compactionSummary ?? null,
					}),
				}),
		shutdown: () => undefined,
		runInit: () => undefined,
		runContextClear: () => undefined,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		listExtensions: () => [],
		listAgents: () => [],
		listDelegationAgents: () => [],
		openCost: () => undefined,
		openSideQuestion: () => undefined,
		startHandoff: () => undefined,
		openContextView: () => undefined,
		openTasks: () => undefined,
		openDecisions: () => undefined,
		openMemory: () => undefined,
		openView: () => undefined,
		openModel: () => undefined,
		providers: {} as ProvidersContract,
		applyModelRef: () => undefined,
		openSettings: () => undefined,
		openResume: () => undefined,
		startNewSession: () => undefined,
		openTree: () => undefined,
		openMessagePicker: () => undefined,
		openHelp: () => undefined,
		openAgents: () => undefined,
		openPrompts: () => undefined,
		openExtensions: () => undefined,
		runCompact: () => undefined,
		exportTranscript: () => undefined,
		verifyReceipt: () => ({ ok: false, reason: "missing" }),
		submitChat: () => undefined,
		render: () => undefined,
	} as unknown as SlashCommandContext;
	return { ctx, requests, notes, notices };
}

describe("contracts/oracle", () => {
	it("parses /oracle as one greedy question and reports usage on an empty one", () => {
		deepStrictEqual(parseSlashCommand("/oracle should we key the cache by node or by capability?"), {
			kind: "oracle",
			question: "should we key the cache by node or by capability?",
		});
		deepStrictEqual(parseSlashCommand("/oracle"), { kind: "oracle-usage" });
		deepStrictEqual(parseSlashCommand("/oracle    "), { kind: "oracle-usage" });

		const h = harness();
		dispatchSlashCommand(parseSlashCommand("/oracle"), h.ctx);
		ok(
			h.notices.some((notice) => notice.includes("usage: /oracle <question>")),
			h.notices.join(" | "),
		);
	});

	it("packs settled decisions, open tasks, and the compaction summary, and nothing else", () => {
		const digest = packOracleDigest({
			decisions: [
				decisionEntry([
					{ key: "routing.target", value: "local-lmstudio", status: "active", decidedAt: "2026-08-24T10:00:00.000Z" },
					{
						key: "cache.key",
						value: "per-node",
						status: "superseded",
						decidedAt: "2026-08-24T10:01:00.000Z",
						correction: "per-capability",
					},
				]),
			],
			tasks: [
				task("t1", "wire the cache", "completed"),
				task("t2", "add the invalidation test", "active"),
				task("t3", "document the key", "pending"),
				task("t4", "drop the old path", "cancelled"),
			],
			compactionSummary: "Earlier turns established the cache boundary.",
			question: "should we key by node?",
		});

		strictEqual(digest.truncated, false);
		ok(digest.text.includes("routing.target: local-lmstudio"));
		ok(digest.text.includes("cache.key: per-node [superseded; corrected to per-capability]"));
		// Open tasks only: a completed or cancelled task is history, not scope.
		ok(digest.text.includes("t2 [active] add the invalidation test"));
		ok(digest.text.includes("t3 [pending] document the key"));
		ok(!digest.text.includes("wire the cache"));
		ok(!digest.text.includes("drop the old path"));
		ok(digest.text.includes("Earlier turns established the cache boundary."));
		ok(digest.text.includes("should we key by node?"));
	});

	it("says so in its own sections when the record is empty", () => {
		const digest = packOracleDigest({ decisions: [], tasks: [], compactionSummary: null, question: "why?" });
		ok(digest.text.includes("(no settled decisions on this branch)"));
		ok(digest.text.includes("(no open tasks on the board)"));
		ok(digest.text.includes("(this session has not compacted)"));
		strictEqual(digest.truncated, false);
	});

	it("bounds every section and the whole digest, and marks what it cut", () => {
		const digest = packOracleDigest({
			decisions: [
				decisionEntry(
					Array.from({ length: ORACLE_DECISIONS_MAX_ROWS + 8 }, (_unused, index) => ({
						key: `k${index}`,
						value: "v".repeat(600),
						status: "active" as const,
						decidedAt: "2026-08-24T10:00:00.000Z",
					})),
				),
			],
			tasks: Array.from({ length: ORACLE_TASKS_MAX_ROWS + 8 }, (_unused, index) =>
				task(`t${index}`, "x".repeat(400), "pending"),
			),
			compactionSummary: "s".repeat(ORACLE_COMPACTION_MAX_BYTES * 3),
			question: "q".repeat(ORACLE_QUESTION_MAX_BYTES * 3),
		});

		strictEqual(digest.truncated, true);
		ok(digest.text.includes(ORACLE_TRUNCATION_MARKER.trim()));
		ok(
			Buffer.byteLength(digest.text, "utf8") <= ORACLE_DIGEST_MAX_BYTES,
			`digest is ${Buffer.byteLength(digest.text, "utf8")} bytes`,
		);

		const sections = digest.text.split("\n## ");
		const decisions = sections.find((section) => section.startsWith("Settled decisions")) ?? "";
		const tasks = sections.find((section) => section.startsWith("Open tasks")) ?? "";
		const summary = sections.find((section) => section.startsWith("Last compaction summary")) ?? "";
		const question = sections.find((section) => section.startsWith("Question")) ?? "";
		ok(Buffer.byteLength(decisions, "utf8") <= ORACLE_DECISIONS_MAX_BYTES + 64);
		ok(Buffer.byteLength(tasks, "utf8") <= ORACLE_TASKS_MAX_BYTES + 64);
		ok(Buffer.byteLength(summary, "utf8") <= ORACLE_COMPACTION_MAX_BYTES + 64);
		ok(Buffer.byteLength(question, "utf8") <= ORACLE_QUESTION_MAX_BYTES + 64);
		// One runaway section never starves another: the question survives whole
		// sections above it being cut.
		ok(question.includes("q".repeat(64)));
	});

	it("dispatches a singular read-only internal run and shares the rendered answer", async () => {
		const h = harness({
			decisions: [
				decisionEntry([
					{ key: "routing.target", value: "local-lmstudio", status: "active", decidedAt: "2026-08-24T10:00:00.000Z" },
				]),
			],
			tasks: [task("t2", "add the invalidation test", "active")],
		});
		dispatchSlashCommand(parseSlashCommand("/oracle should we widen the scope?"), h.ctx);
		await flushAsync();
		await flushAsync();

		strictEqual(h.requests.length, 1);
		const request = h.requests[0] ?? {};
		strictEqual(request.agentId, "oracle");
		strictEqual(request.requestOrigin, "internal");
		strictEqual(request.autonomy, "read-only");
		ok(typeof request.briefing === "string" && request.briefing.includes("should we widen the scope?"));
		ok(typeof request.briefing === "string" && request.briefing.includes("routing.target: local-lmstudio"));
		// The briefing is the record, never the transcript.
		ok(typeof request.briefing === "string" && !request.briefing.includes("## Transcript"));

		strictEqual(h.notes.length, 1);
		const note = h.notes[0] ?? "";
		match(note, /^\[worker result\] oracle · run or1 · ok · shared by the operator/);
		ok(note.includes("Verdict: consistent with routing.target"));
		ok(note.includes("Strongest challenge: the board still owes t2"));
		ok(note.includes("What would change its mind: a receipt showing t2 already landed"));
		ok(note.includes("Cited decisions: routing.target"));
	});

	it("refuses during an in-flight turn instead of queueing", async () => {
		const h = harness({ inFlight: true });
		dispatchSlashCommand(parseSlashCommand("/oracle is this consistent?"), h.ctx);
		await flushAsync();
		deepStrictEqual(h.requests, []);
		deepStrictEqual(h.notes, []);
		ok(
			h.notices.some((notice) => notice.includes("refused rather than queued")),
			h.notices.join(" | "),
		);
	});

	it("reports an unusable answer rather than sharing one", async () => {
		const h = harness({ receipt: oracleReceipt("I think you should just do it.") });
		dispatchSlashCommand(parseSlashCommand("/oracle is this consistent?"), h.ctx);
		await flushAsync();
		await flushAsync();
		deepStrictEqual(h.notes, []);
		ok(
			h.notices.some((notice) => notice.includes("no usable answer")),
			h.notices.join(" | "),
		);
	});

	it("renders an empty citation list as an explicit absence", () => {
		const rendered = formatOracleAnswer({
			verdict: "unclear",
			challenge: "the question presumes a boundary nobody settled",
			changesMyMind: "a decision entry naming the boundary",
			citedDecisions: [],
		});
		ok(rendered.includes("Cited decisions: none bear on this question."));
	});

	it("ships oracle as a read-only shadow recipe that /run can never reach", () => {
		const recipes = loadRecipesFromDir({
			dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
		});
		const oracle = recipes.find((entry) => entry.id === "oracle");
		ok(oracle, "oracle recipe ships");
		strictEqual(oracle.audience, "shadow");
		strictEqual(oracle.capabilityClass, "read-only");
		deepStrictEqual(oracle.resultContract, { kind: "oracle-report" });
		deepStrictEqual(oracle.tools.slice().sort(), ["code_nav", "context", "find", "grep", "ledger", "ls", "read"]);
		// User-origin `/run` and `clio-coder run --agent` admit only user-visible
		// agents, which is the gate that keeps a shadow recipe out of both.
		strictEqual(isUserVisibleAgent(normalizeAgentSpec(oracle)), false);
	});
});
