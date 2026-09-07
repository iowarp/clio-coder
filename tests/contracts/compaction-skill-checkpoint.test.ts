import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { withModelSkillActivation } from "../../src/core/skill-activation.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { resolveRecall } from "../../src/domains/context/working-set/recall.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import {
	type CompactInput,
	type CompactResult,
	captureSkillContext,
	compact,
} from "../../src/domains/session/compaction/compact.js";
import { findCutPoint } from "../../src/domains/session/compaction/cut-point.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import {
	isSessionEntry,
	mainSkillContextState,
	type SessionEntry,
	SKILL_CONTEXT_STATE,
	type SkillContextState,
	verifiedSkillContextCheckpoint,
} from "../../src/domains/session/entries.js";
import { filterEntriesToActivePath } from "../../src/domains/session/tree/active-path.js";
import type { EngineModel } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import type { TurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnRecovery } from "../../src/interactive/turn-recovery.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

const timestamp = "2026-09-06T00:00:00.000Z";
const model = {
	id: "source",
	name: "source",
	api: "openai-completions",
	provider: "source",
	baseUrl: "https://source.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32768,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as EngineModel;
const summarize = async () => ({
	text: "Progress checkpoint intentionally omitting every skill and task instruction.",
});
const selection: SkillContextState = { version: 1, activationRefs: ["activation"] };
function message(
	turnId: string,
	role: "user" | "assistant" | "tool_call" | "tool_result",
	payload: unknown,
	parentTurnId: string | null,
): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp, role, payload };
}
function history(body = `Complete historical skill\r\n${"instruction ".repeat(2400)}END_SKILL`) {
	const activation = {
		name: "diagram",
		filePath: "/historical/SKILL.md",
		hash: "a".repeat(64),
		source: "clio-coder",
		sourceOrigin: "project",
		triggeredBy: "tool" as const,
		turnId: "request",
		drift: "match" as const,
	};
	const entries: SessionEntry[] = [
		message("request", "user", { text: "[Skill request] diagram", operatorText: "" }, null),
		message(
			"assistant",
			"assistant",
			{ content: [{ type: "toolCall", id: "load", name: "context", arguments: { scope: "skills", name: "diagram" } }] },
			"request",
		),
		message(
			"call",
			"tool_call",
			{ toolCallId: "load", name: "context", args: { scope: "skills", name: "diagram" } },
			"assistant",
		),
		{ kind: "skillActivation", turnId: "activation", parentTurnId: "request", timestamp, activation },
		message(
			"result",
			"tool_result",
			{
				toolCallId: "load",
				toolName: "context",
				isError: false,
				outcome: "ok",
				resultSummary: { bytes: Buffer.byteLength(body), truncated: false },
				result: {
					content: [{ type: "text", text: body }],
					details: {
						kind: "ok",
						name: "diagram",
						path: activation.filePath,
						hash: activation.hash,
						source: activation.source,
						sourceOrigin: "project",
						scope: "project",
						sourceInfo: { path: activation.filePath, scope: "project", source: "project" },
						drift: "match",
						observation: { truncated: false, shownBytes: Buffer.byteLength(body), totalBytes: Buffer.byteLength(body) },
					},
				},
			},
			"call",
		),
		message(
			"task",
			"user",
			{ text: "transient wrapper", operatorText: "Map the real source.\r\nPreserve this exact task." },
			"result",
		),
		message(
			"work",
			"assistant",
			{ text: "read evidence ".repeat(2400), usage: { input: 32000, output: 100, totalTokens: 32100 } },
			"task",
		),
		message("tail", "assistant", { text: "Recent work" }, "work"),
	];
	return { entries, body };
}
function checkpoint(result: CompactResult, id: string): SessionEntry {
	return {
		kind: "compactionSummary",
		turnId: id,
		parentTurnId: result.firstKeptTurnId,
		timestamp,
		summary: result.summary,
		firstKeptTurnId: result.firstKeptTurnId ?? "",
		tokensBefore: result.tokensBefore,
		...(result.skillContext ? { skillContext: result.skillContext } : {}),
		...(result.userContext ? { userContext: result.userContext } : {}),
	};
}
const run = (entries: SessionEntry[], skillContextState?: SkillContextState) =>
	compact({
		entries,
		model,
		summarize,
		keepRecentTokens: 100,
		preserveUserTurnId: "task",
		...(skillContextState ? { skillContextState } : {}),
	});

/** A short skill activation can exhaust request space without crossing the input-only threshold. */
function overflowFixture(activeTask = false) {
	const { entries: original, body } = history(`Exact selected skill ${"instruction ".repeat(650)}END_SKILL`);
	const entries = original
		.filter((entry) => activeTask || entry.turnId !== "task")
		.flatMap((entry) => {
			if (entry.turnId === "tail") return [{ ...entry, parentTurnId: "work-5" }];
			if (entry.turnId !== "work") return [entry];
			// Several observations permit a structural cut, as in the saved activation.
			return Array.from({ length: 6 }, (_, index) =>
				message(
					`work-${index}`,
					"assistant",
					{ text: "source evidence ".repeat(200) },
					index > 0 ? `work-${index - 1}` : activeTask ? "task" : "result",
				),
			);
		});
	entries.push({
		kind: "custom",
		turnId: "selected",
		parentTurnId: "tail",
		timestamp,
		customType: SKILL_CONTEXT_STATE,
		data: selection,
	});
	const state = createTurnState("off");
	state.activeUserTurnId = activeTask ? "task" : null;
	state.lastTurnId = "selected";
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.maxOutputTokens = 8192;
	const requests: string[] = [];
	const runtime = {
		targetId: "source",
		runtimeId: "source",
		wireModelId: "source",
		runtimeResolution: { capabilityDecisions: { tools: true }, contextWindowDetails: { effectiveContextWindow: 32768 } },
		agent: {
			state: { systemPrompt: "", tools: [], messages: [], model, thinkingLevel: "off" },
			prompt: async (text: string) => {
				requests.push(text);
			},
		},
	} as unknown as AgentRuntime;
	state.runtime = runtime;
	const budgets: Array<{
		trigger: string | undefined;
		budget: Pick<CompactInput, "keepRecentTokens" | "preserveUserTurnId" | "skillContextState"> | undefined;
	}> = [];
	const results: CompactResult[] = [];
	let compiledText = "";
	const context = createTurnContext({
		state,
		getSettings: () => settings,
		providers: {} as ProvidersContract,
		readSessionEntries: () => entries,
		prompts: {
			inputEpoch: () => 0,
			compileSessionPrompt: async () => ({
				systemPrompt: compiledText,
				systemPromptHash: "compiled",
				tokenEstimate: Math.ceil(compiledText.length / 4),
				sections: [],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
		middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
		emitNotice: () => {},
		autoCompact: async (_instructions, trigger, budget) => {
			budgets.push({ trigger, budget });
			const result = await compact({ entries, model, summarize, ...budget });
			results.push(result);
			if (!result.summary) return null;
			entries.push(checkpoint(result, `checkpoint-${results.length}`));
			state.lastTurnId = entries.at(-1)?.turnId ?? null;
			return result;
		},
	});
	context.refreshAgentMessagesFromSession(runtime);
	const priceAt = (tokens: number, pending = "") => {
		runtime.agent.state.systemPrompt = "";
		const withoutSystem = context.liveContextEstimate(runtime, pending).tokens;
		ok(tokens > withoutSystem);
		runtime.agent.state.systemPrompt = "s".repeat((tokens - withoutSystem) * 4);
	};
	return {
		state,
		context,
		runtime,
		settings,
		entries,
		body,
		budgets,
		results,
		requests,
		priceAt,
		compileNext: (text: string) => {
			compiledText = text;
		},
	};
}

describe("mandatory request-fit compaction", () => {
	it("recovers a resumed selected skill when the next turn only grants optional model activation", async () => {
		const f = overflowFixture();
		const pending = "Create the exact source-backed map; keep tracked source unchanged.";
		f.priceAt(25000, pending);
		// This is the policy submit creates on auto-edit/full-auto after a cold resume.
		const policy = withModelSkillActivation(undefined, true);
		strictEqual(await f.context.runAutoCompact(f.runtime, true, undefined, "overflow", pending, policy), true);
		strictEqual(f.results[0]?.skillContext?.skills[0]?.content[0]?.text, f.body);
		ok(f.context.liveContextEstimate(f.runtime, pending).tokens + 8192 <= 32768);
		strictEqual(policy?.loadedSkillNames.size, 0, "historical content does not reconstruct live tool authority");
	});

	it("keeps explicit off, unknown selection and pending replacement authoritative with an empty model grant", () => {
		const f = overflowFixture();
		const grant = withModelSkillActivation(undefined, true);
		deepStrictEqual(mainSkillContextState(f.entries, grant), selection);
		for (const data of [
			{ version: 1 as const, activationRefs: [] },
			{ version: 1 as const, activationRefs: [], unknown: true },
		]) {
			const state: SessionEntry = {
				kind: "custom",
				turnId: "changed",
				parentTurnId: "selected",
				timestamp,
				customType: SKILL_CONTEXT_STATE,
				data,
			};
			deepStrictEqual(mainSkillContextState([...f.entries, state], grant), data);
		}
		ok(grant);
		strictEqual(
			mainSkillContextState(f.entries, {
				...grant,
				requests: [{ name: "replacement", args: "", source: "slash-command", installed: true }],
			}),
			null,
		);
	});

	for (const autonomy of ["read-only", "auto-edit", "full-auto"] as const) {
		it(`routes resumed ${autonomy} submit through overflow with the recorded skill selection`, async () => {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.safety.autonomy = autonomy;
			settings.chat.target = "source";
			settings.chat.model = "source";
			settings.chat.maxOutputTokens = 8192;
			settings.chat.prewarm = false;
			const capabilities = {
				chat: true,
				tools: true,
				reasoning: false,
				vision: false,
				audio: false,
				embeddings: false,
				rerank: false,
				fim: false,
				contextWindow: 32768,
				maxTokens: 8192,
			};
			const target = {
				id: "source",
				runtime: "source",
				url: "https://source.invalid",
				defaultModel: "source",
				capabilities: { contextWindow: 32768 },
			};
			const runtime = {
				id: "source",
				displayName: "Offline",
				kind: "http",
				tier: "cloud",
				apiFamily: "openai-completions",
				auth: "none",
				defaultCapabilities: capabilities,
				synthesizeModel: () => structuredClone(model),
			};
			const providers = {
				getTarget: () => target,
				getRuntime: () => runtime,
				getDetectedReasoning: () => false,
				list: () => [
					{
						target,
						runtime,
						capabilities,
						available: true,
						discoveredModels: ["source"],
						discoveredModelsSource: "probe",
						probeCapabilities: null,
					},
				],
			} as unknown as ProvidersContract;
			const { entries } = overflowFixture();
			const entryCount = entries.length;
			const order: string[] = [];
			let budget: Pick<CompactInput, "keepRecentTokens" | "preserveUserTurnId" | "skillContextState"> | undefined;
			const loop = createChatLoop({
				getSettings: () => settings,
				providers,
				knownTargets: () => new Set(["source"]),
				readSessionEntries: () => entries,
				createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
					agent: {
						state: options?.initialState,
						subscribe: () => () => {},
						abort: () => {},
						prompt: async () => {
							throw new Error("No provider call is allowed in this caller-boundary contract");
						},
					},
				})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
				prompts: {
					inputEpoch: () => 0,
					compileSessionPrompt: async () => {
						order.push("compile");
						return {
							systemPrompt: "p".repeat(140000),
							systemPromptHash: "grown",
							tokenEstimate: 35000,
							sections: [],
							fragmentManifest: [],
						};
					},
				} as unknown as PromptsContract,
				autoCompact: async (_instructions, trigger, requested) => {
					order.push(trigger ?? "unspecified");
					budget = requested;
					return null;
				},
			});
			try {
				loop.resetForSession("selected", buildModelReplayAgentMessagesFromTurns(entries));
				await loop.submit("Create the current architecture map.");
				deepStrictEqual(order, ["compile", "overflow"]);
				ok((budget?.keepRecentTokens ?? 20000) < 20000);
				deepStrictEqual(budget?.skillContextState, selection);
				strictEqual(entries.length, entryCount, "failed preflight must not append the pending operator turn");
			} finally {
				loop.dispose();
			}
		});
	}

	it("recovers output overflow below the automatic threshold while manual force keeps its default", async () => {
		const f = overflowFixture();
		const pending = "Create the exact source-backed map; keep tracked source unchanged.";
		f.priceAt(25000, pending);
		ok(25000 < 32768 * f.settings.context.compaction.threshold);
		ok(25000 + 8192 > 32768);
		strictEqual(await f.context.runAutoCompact(f.runtime, false, undefined, undefined, pending), false);
		strictEqual(f.budgets.length, 0);
		strictEqual(await f.context.runAutoCompact(f.runtime, true, undefined, "force", pending), false);
		strictEqual(f.budgets[0]?.budget?.keepRecentTokens, undefined);
		strictEqual(f.budgets[0]?.budget?.preserveUserTurnId, undefined);
		strictEqual(f.results[0]?.messagesSummarized, 0);
		strictEqual(await f.context.runAutoCompact(f.runtime, true, undefined, "overflow", pending), true);
		ok((f.budgets[1]?.budget?.keepRecentTokens ?? 20000) < 20000);
		strictEqual(f.results[1]?.skillContext?.skills[0]?.content[0]?.text, f.body);
		ok(f.context.liveContextEstimate(f.runtime, pending).tokens + 8192 <= 32768);
		ok(JSON.stringify(f.runtime.agent.state.messages).includes(f.body));
		strictEqual(
			f.entries.some(
				(entry) =>
					entry.kind === "message" && entry.role === "user" && (entry.payload as { text?: string }).text === pending,
			),
			false,
			"pending operator text stays uncommitted until admission",
		);
	});

	it("prices the freshly compiled prompt when the first automatic precheck did not need compaction", async () => {
		const f = overflowFixture();
		const pending = "Map the current source with the loaded skill.";
		f.priceAt(21000, pending);
		ok(f.context.liveContextEstimate(f.runtime, pending).tokens + 8192 < 32768);
		strictEqual(await f.context.runAutoCompact(f.runtime, false, undefined, undefined, pending), false);
		strictEqual(f.budgets.length, 0);
		f.compileNext(`${f.runtime.agent.state.systemPrompt}${"new context ".repeat(1400)}`);
		ok(await f.context.ensureSessionPrompt(f.runtime));
		const before = f.context.liveContextEstimate(f.runtime, pending);
		ok(before.tokens + 8192 > 32768);
		strictEqual(await f.context.runAutoCompact(f.runtime, true, undefined, "overflow", pending), true);
		const expectedKeep = Math.floor(
			(Math.min(32768 * f.settings.context.compaction.threshold, before.tokens + 1024) -
				before.breakdown.systemPromptTokens -
				before.breakdown.pendingUserTokens) /
				2,
		);
		strictEqual(f.budgets[0]?.budget?.keepRecentTokens, expectedKeep);
		ok(f.context.liveContextEstimate(f.runtime, pending).tokens + 8192 <= 32768);
		strictEqual(f.results[0]?.skillContext?.skills[0]?.content[0]?.text, f.body);
	});

	it("keeps the provider-overflow caller compatible and preserves its already admitted operator task", async () => {
		const f = overflowFixture(true);
		f.priceAt(25000);
		// Mandatory provider recovery remains available even when automatic compaction is disabled.
		f.settings.context.compaction.auto = false;
		const recovery = createTurnRecovery({
			state: f.state,
			context: f.context,
			persistence: {} as TurnPersistence,
			retrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, streamStallMs: 1 }),
			markPersistedUserEcho: async (_text, prompt) => prompt(),
			emitRetryStatus: () => {},
			emitFailureMessage: () => {},
			emitNotice: () => {},
		});
		const task = "Map the real source.\r\nPreserve this exact task.";
		await recovery.runCompactAndRetry(f.runtime, task, {
			kind: "context-overflow",
			message: "context window exceeded",
		} as Parameters<typeof recovery.runCompactAndRetry>[2]);
		strictEqual(f.budgets[0]?.trigger, "overflow");
		strictEqual(f.budgets[0]?.budget?.preserveUserTurnId, "task");
		ok((f.budgets[0]?.budget?.keepRecentTokens ?? 20000) < 20000);
		strictEqual(f.results[0]?.userContext?.text, task);
		strictEqual(f.results[0]?.skillContext?.skills[0]?.content[0]?.text, f.body);
		deepStrictEqual(f.requests, [task]);
	});
});

describe("typed historical skill checkpoints (pure source)", () => {
	for (const priorSuffix of [false, true]) {
		it(`summarizes ${priorSuffix ? "the prior retained suffix" : "new older work"} while retaining the newest parallel batch`, async () => {
			const f = overflowFixture();
			const first = await compact({
				entries: f.entries,
				model,
				summarize,
				keepRecentTokens: 500,
				skillContextState: selection,
			});
			const entries = [...f.entries, checkpoint(first, "prior")];
			let startIndex = entries.length;
			const task = "Build the map; keep source unchanged.";
			entries.push(message("new-task", "user", { text: task, operatorText: task }, "tail"));
			entries.push(message("old-work", "assistant", { text: "earlier source evidence ".repeat(800) }, "new-task"));
			if (priorSuffix) {
				entries.push({
					...checkpoint(first, "prior-live-tail"),
					parentTurnId: "old-work",
					firstKeptTurnId: "new-task",
					userContext: { turnId: "new-task", text: task },
				} as SessionEntry);
				startIndex = entries.length;
			}
			const latestIndex = entries.length;
			entries.push(
				message(
					"parallel",
					"assistant",
					{
						content: [
							{ type: "toolCall", id: "schema", name: "read", arguments: { path: "schema.json" } },
							{ type: "toolCall", id: "example", name: "read", arguments: { path: "example.json" } },
						],
					},
					priorSuffix ? "prior-live-tail" : "old-work",
				),
			);
			for (const [id, parent] of [
				["schema", "parallel"],
				["example", "schema-call"],
			] as const) {
				entries.push(
					message(`${id}-call`, "tool_call", { toolCallId: id, name: "read", args: { path: `${id}.json` } }, parent),
				);
			}
			for (const [id, parent] of [
				["schema", "example-call"],
				["example", "schema-result"],
			] as const) {
				entries.push(
					message(
						`${id}-result`,
						"tool_result",
						{
							toolCallId: id,
							toolName: "read",
							result: { content: [{ type: "text", text: `${id} evidence `.repeat(1500) }] },
						},
						parent,
					),
				);
			}
			const original = JSON.stringify(entries);
			strictEqual(findCutPoint(entries, 1000, { startIndex }).firstKeptEntryIndex, latestIndex);
			let summaryCalls = 0;
			const result = await compact({
				entries,
				model,
				keepRecentTokens: 1000,
				preserveUserTurnId: "new-task",
				summarize: async ({ userText }) => {
					match(userText, /earlier source evidence/);
					summaryCalls++;
					return { text: "Checkpoint of earlier work." };
				},
			});
			strictEqual(summaryCalls, 1);
			ok(result.messagesSummarized > 0);
			strictEqual(result.userContext?.text, task);
			strictEqual(result.skillContext?.skills[0]?.content[0]?.text, f.body);
			const replay = buildModelReplayAgentMessagesFromTurns([...entries, checkpoint(result, "second")]);
			const calls = replay.flatMap((entry) =>
				entry.role === "assistant"
					? entry.content.filter((block) => block.type === "toolCall").map((block) => block.id)
					: [],
			);
			const results = replay.flatMap((entry) => (entry.role === "toolResult" ? [entry.toolCallId] : []));
			for (const id of ["schema", "example"]) {
				strictEqual(calls.filter((call) => call === id).length, 1);
				strictEqual(results.filter((call) => call === id).length, 1);
			}
			strictEqual(JSON.stringify(entries), original);
			const orphaned = structuredClone(entries);
			const lastResult = orphaned.at(-1);
			ok(lastResult?.kind === "message");
			lastResult.payload = { ...(lastResult.payload as object), toolCallId: "unknown-call" };
			strictEqual(
				findCutPoint(orphaned, 1000, { startIndex }).firstKeptEntryIndex,
				startIndex,
				"an unowned result must not introduce a cut that drops its unknown call",
			);
			ok(
				findCutPoint(entries, 1000, { startIndex: latestIndex + 1 }).firstKeptEntryIndex > latestIndex,
				"do not reach through the caller's prior-checkpoint boundary",
			);
			if (priorSuffix) {
				const unexpectedSummary = async () => {
					throw new Error("no reclaimable prior work");
				};
				const immediateRepeat = await compact({
					entries: [...entries, checkpoint(result, "settled")],
					model,
					keepRecentTokens: 1000,
					summarize: unexpectedSummary,
				});
				strictEqual(immediateRepeat.messagesSummarized, 0, "no repeated summary without new retained work");
				const barePrior = structuredClone(entries);
				const prior = barePrior[startIndex - 1];
				ok(prior?.kind === "compactionSummary");
				prior.firstKeptTurnId = "";
				const onlySummary = await compact({
					entries: barePrior,
					model,
					keepRecentTokens: 1000,
					summarize: unexpectedSummary,
				});
				strictEqual(onlySummary.messagesSummarized, 0, "a bare prior summary is not reclaimable suffix work");
			}
		});
	}

	it("retains exact instructions through two checkpoints, fresh replay, raw usage and recall", async () => {
		const { entries, body } = history();
		const original = JSON.stringify(entries);
		const result = await run(entries, selection);
		ok(result.messagesSummarized > 0);
		strictEqual(result.skillContext?.skills[0]?.content[0]?.text, body);
		strictEqual(result.userContext?.text, "Map the real source.\r\nPreserve this exact task.");
		const first = checkpoint(result, "checkpoint1");
		ok(isSessionEntry(first));
		const once = [...entries, first];
		const replay = buildModelReplayAgentMessagesFromTurns(once);
		ok(JSON.stringify(replay).includes("END_SKILL"), "preserved body bypasses the 20000-character summary cap");
		deepStrictEqual(buildModelReplayAgentMessagesFromTurns(JSON.parse(JSON.stringify(once))), replay);
		const grown = [
			...once,
			message("more", "assistant", { text: "new evidence ".repeat(3000) }, "tail"),
			message("more2", "assistant", { text: "later evidence ".repeat(3000) }, "more"),
			message("end", "assistant", { text: "Newest" }, "more2"),
		];
		const second = await run(grown);
		deepStrictEqual(second.skillContext, result.skillContext, "activation before prior summary boundary remains exact");
		const twice = [...grown, checkpoint(second, "checkpoint2")];
		const restarted = buildModelReplayAgentMessagesFromTurns(JSON.parse(JSON.stringify(twice)));
		strictEqual(JSON.stringify(restarted).split("END_SKILL").length - 1, 1);
		strictEqual(JSON.stringify(entries), original);
		ok(estimateTokens(first) > body.length / 4);
		const recall = resolveRecall(twice, foldWorkingSet(twice), "result");
		ok(recall.ok);
		strictEqual(recall.result.body, body);
	});

	it("accepts old ledgers and strictly rejects malformed new checkpoint/state data", async () => {
		const { entries } = history();
		const row = checkpoint(await run(entries, selection), "checkpoint");
		ok(isSessionEntry(row));
		const old = { ...row } as Record<string, unknown>;
		delete old.skillContext;
		ok(isSessionEntry(old));
		for (const value of [null, {}, { version: 2, skills: [] }, { version: 1, skills: [null] }])
			strictEqual(isSessionEntry({ ...row, skillContext: value }), false);
		const invalid = structuredClone(row);
		ok(invalid.kind === "compactionSummary" && invalid.skillContext);
		const firstBlock = invalid.skillContext.skills[0]?.content[0];
		ok(firstBlock);
		firstBlock.text += "tampered";
		strictEqual(isSessionEntry(invalid), true);
		strictEqual(verifiedSkillContextCheckpoint(invalid.skillContext), false);
		doesNotMatch(JSON.stringify(buildModelReplayAgentMessagesFromTurns([...entries, invalid])), /END_SKILL/);
		const state = {
			kind: "custom",
			turnId: "off",
			parentTurnId: "tail",
			timestamp,
			customType: SKILL_CONTEXT_STATE,
			data: { version: 1, activationRefs: [] },
		};
		ok(isSessionEntry(state));
		for (const data of [null, {}, { version: 1, activationRefs: [1] }])
			strictEqual(isSessionEntry({ ...state, data }), false);
	});

	it("keeps protection with unknown, incomplete, ambiguous, mismatched or worker evidence", async () => {
		const mutations: Array<(entries: SessionEntry[]) => void> = [
			(entries) => {
				entries.splice(4, 1);
			},
			(entries) => {
				const entry = entries[4];
				ok(entry);
				entries.splice(5, 0, { ...structuredClone(entry), turnId: "duplicate-result" });
			},
			(entries) => {
				const entry = entries[3];
				ok(entry);
				if (entry.kind === "skillActivation") entry.activation.runId = "worker";
			},
			(entries) => {
				const entry = entries[3];
				ok(entry);
				if (entry.kind === "skillActivation") entry.activation.hash = "b".repeat(64);
			},
			(entries) => {
				const entry = entries[3];
				ok(entry);
				if (entry.kind === "skillActivation") entry.activation.drift = "mismatch";
			},
			(entries) => {
				const entry = entries[4];
				ok(entry);
				if (entry.kind === "message")
					(
						entry.payload as { result: { details: { observation: { truncated: boolean } } } }
					).result.details.observation.truncated = true;
			},
			(entries) => {
				const entry = entries[4];
				ok(entry);
				if (entry.kind === "message")
					(entry.payload as { result: { details: { sourceOrigin: string } } }).result.details.sourceOrigin = "foreign";
			},
		];
		strictEqual((await run(history().entries)).messagesSummarized, 0);
		for (const mutate of mutations) {
			const { entries } = history();
			mutate(entries);
			strictEqual(captureSkillContext(entries, selection), undefined);
			strictEqual((await run(entries, selection)).messagesSummarized, 0);
		}
	});

	it("does not promote checkpoint instructions after off/replacement or on a sibling branch", async () => {
		const { entries } = history();
		const first = checkpoint(await run(entries, selection), "checkpoint");
		for (const activationRefs of [[], ["replacement"]]) {
			const state: SessionEntry = {
				kind: "custom",
				turnId: "state",
				parentTurnId: "tail",
				timestamp,
				customType: SKILL_CONTEXT_STATE,
				data: { version: 1, activationRefs },
			};
			const replay = buildModelReplayAgentMessagesFromTurns([...entries, first, state]);
			doesNotMatch(JSON.stringify(replay), /END_SKILL/);
			deepStrictEqual(
				buildModelReplayAgentMessagesFromTurns(JSON.parse(JSON.stringify([...entries, first, state]))),
				replay,
			);
		}
		const fork = [...entries, first, message("sibling", "user", { text: "Independent branch" }, "request")];
		doesNotMatch(
			JSON.stringify(buildModelReplayAgentMessagesFromTurns(fork, { activeLeafTurnId: "sibling" })),
			/END_SKILL/,
		);
		strictEqual(captureSkillContext(filterEntriesToActivePath(fork, "sibling"), selection), undefined);
	});

	it("uses authoritative state, refuses pending replacement, and retires same-name old receipts", async () => {
		const { entries } = history();
		strictEqual(mainSkillContextState(entries, undefined), undefined);
		const policy = {
			allowedSkillNames: ["diagram"],
			requests: [{ name: "diagram", args: "", source: "slash-command" as const, installed: true }],
			loadedSkillNames: new Set(["diagram"]),
			loadedSkillPolicies: new Map([["diagram", { allowedTools: ["read"] }]]),
		};
		deepStrictEqual(mainSkillContextState(entries, policy), selection);
		strictEqual(mainSkillContextState(entries, { ...policy, loadedSkillNames: new Set() }), null);
		const replacement: SessionEntry[] = JSON.parse(
			JSON.stringify(history("REPLACED_WORKFLOW").entries),
			(key, value: unknown) =>
				key !== "role" &&
				typeof value === "string" &&
				["request", "assistant", "call", "activation", "result", "task", "work", "tail", "load"].includes(value)
					? `new-${value}`
					: value,
		);
		const first = replacement[0];
		ok(first);
		first.parentTurnId = "tail";
		const combined = [...entries, ...replacement];
		strictEqual(captureSkillContext(combined, selection), undefined);
		const next = captureSkillContext(combined, { version: 1, activationRefs: ["new-activation"] });
		strictEqual(next?.skills[0]?.content[0]?.text, "REPLACED_WORKFLOW");
	});

	it("rejects masked, partial, byte-mismatched and tampered evidence without bricking replay", async () => {
		for (const change of ["mask", "partial", "bytes", "observation"] as const) {
			const { entries } = history();
			const entry = entries[4];
			ok(entry?.kind === "message");
			const payload = entry.payload as {
				resultSummary: { bytes: number; truncated: boolean };
				result: { details: { contextCompaction?: unknown; observation: { totalBytes: number } } };
			};
			if (change === "mask") payload.result.details.contextCompaction = { masked: true };
			if (change === "partial") payload.resultSummary.truncated = true;
			if (change === "bytes") payload.resultSummary.bytes--;
			if (change === "observation") payload.result.details.observation.totalBytes++;
			strictEqual(captureSkillContext(entries, selection), undefined);
			strictEqual((await run(entries, selection)).messagesSummarized, 0);
		}
		const { entries } = history();
		const result = await run(entries, selection);
		const row = checkpoint(result, "checkpoint");
		const raw = entries[4];
		ok(raw?.kind === "message");
		const content = (raw.payload as { result: { content: Array<{ text: string }> } }).result.content[0];
		ok(content);
		content.text = `X${content.text.slice(1)}`;
		doesNotMatch(JSON.stringify(buildModelReplayAgentMessagesFromTurns([...entries, row])), /END_SKILL/);
		const grown = [
			...entries,
			row,
			message("one", "assistant", { text: "evidence ".repeat(3000) }, "tail"),
			message("two", "assistant", { text: "more ".repeat(3000) }, "one"),
		];
		await rejects(run(grown), /no longer matches/);
	});

	it("keeps typed operator instructions after a long summary and out of subsequent summary input", async () => {
		const { entries } = history();
		let calls = 0;
		const result = await compact({
			entries,
			model,
			keepRecentTokens: 100,
			preserveUserTurnId: "task",
			skillContextState: selection,
			summarize: async () => ({ text: ++calls === 1 ? "summary ".repeat(3000) : "Short second summary" }),
		});
		const row = checkpoint(result, "long");
		const replay = JSON.stringify(buildModelReplayAgentMessagesFromTurns([...entries, row]));
		ok(replay.includes(JSON.stringify("Map the real source.\r\nPreserve this exact task.").slice(1, -1)));
		const grown = [
			...entries,
			row,
			message("one", "assistant", { text: "evidence ".repeat(3000) }, "tail"),
			message("two", "assistant", { text: "more ".repeat(3000) }, "one"),
		];
		const second = await compact({
			entries: grown,
			model,
			keepRecentTokens: 100,
			preserveUserTurnId: "task",
			summarize: async ({ userText }) => {
				doesNotMatch(userText, /END_SKILL/);
				return { text: "omits all instructions" };
			},
		});
		deepStrictEqual(second.skillContext, result.skillContext);
		deepStrictEqual(second.userContext, result.userContext);
	});

	it("compacts after an explicit-off checkpoint when later state is unknown or legacy-blocked", async () => {
		const { entries } = history();
		const off: SessionEntry = {
			kind: "custom",
			turnId: "off",
			parentTurnId: "tail",
			timestamp,
			customType: SKILL_CONTEXT_STATE,
			data: { version: 1, activationRefs: [] },
		};
		const first = await run([...entries, off]);
		ok(first.messagesSummarized > 0);
		deepStrictEqual(first.skillContext, { version: 1, skills: [] });
		const unknownState: SessionEntry = {
			kind: "custom",
			turnId: "unknown",
			parentTurnId: "two",
			timestamp,
			customType: SKILL_CONTEXT_STATE,
			data: { version: 1, activationRefs: [], unknown: true },
		};
		const grown = [
			...entries,
			off,
			checkpoint(first, "checkpoint"),
			message("one", "assistant", { text: "evidence ".repeat(3000) }, "tail"),
			message("two", "assistant", { text: "more ".repeat(3000) }, "one"),
			unknownState,
		];
		// Nothing was retained, so unknown state neither throws nor re-protects the switched-off activation.
		const second = await run(grown);
		ok(second.messagesSummarized > 0);
		strictEqual(second.skillContext, undefined);
		doesNotMatch(
			JSON.stringify(buildModelReplayAgentMessagesFromTurns([...grown, checkpoint(second, "c2")])),
			/END_SKILL/,
		);
		// A legacy checkpoint with no typed field still fails closed across its boundary.
		const { skillContext: _typed, ...legacyResult } = first;
		const legacy = [...entries, checkpoint(legacyResult, "legacy")];
		legacy.push(message("one", "assistant", { text: "evidence ".repeat(3000) }, "tail"));
		strictEqual((await run(legacy)).messagesSummarized, 0);
	});

	it("names a selected skill it cannot re-verify at replay instead of dropping it silently", async () => {
		const { entries } = history();
		const row = checkpoint(await run(entries, selection), "checkpoint");
		const raw = entries[4];
		ok(raw?.kind === "message");
		const payload = raw.payload as { result: { content: unknown; details: Record<string, unknown> } };
		payload.result = {
			content: [{ type: "text", text: "[Observation masked]" }],
			details: { ...payload.result.details, contextCompaction: { stage: "mask_observations" } },
		};
		const masked = JSON.stringify(buildModelReplayAgentMessagesFromTurns([...entries, row]));
		doesNotMatch(masked, /END_SKILL/);
		match(masked, /could not be re-verified/);
		match(masked, /diagram \(source=clio-coder hash=a{64}/);
		match(masked, /ref=\\"result\\"/);
		// A deliberate off or replacement leaves no trace at all.
		const off: SessionEntry = {
			kind: "custom",
			turnId: "off",
			parentTurnId: "tail",
			timestamp,
			customType: SKILL_CONTEXT_STATE,
			data: { version: 1, activationRefs: [] },
		};
		doesNotMatch(JSON.stringify(buildModelReplayAgentMessagesFromTurns([...entries, row, off])), /diagram|re-verified/);
		// A tampered checkpoint says so once without naming unverified content.
		const tampered = structuredClone(row);
		ok(tampered.kind === "compactionSummary" && tampered.skillContext);
		const tamperedSkill = tampered.skillContext.skills[0];
		ok(tamperedSkill);
		tamperedSkill.contentHash = "0".repeat(64);
		const text = JSON.stringify(buildModelReplayAgentMessagesFromTurns([...history().entries, tampered]));
		match(text, /failed integrity verification/);
		doesNotMatch(text, /END_SKILL/);
	});

	it("leaves the real continuation guard enforced if exact preservation cannot fit", async () => {
		const { entries } = history("oversized exact instructions ".repeat(6000));
		entries.push(message("read-call", "tool_call", { toolCallId: "read", name: "read", args: { path: "x" } }, "tail"));
		entries.push(
			message(
				"read-result",
				"tool_result",
				{ toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "last observation" }] } },
				"read-call",
			),
		);
		const state = createTurnState("off");
		state.activeUserTurnId = "task";
		state.lastTurnId = "read-result";
		const runtime = {
			targetId: "source",
			runtimeId: "source",
			wireModelId: "source",
			runtimeResolution: { contextWindowDetails: { effectiveContextWindow: 32768 } },
			agent: { state: { systemPrompt: "System", tools: [], messages: [], model, thinkingLevel: "off" } },
		} as unknown as AgentRuntime;
		state.runtime = runtime;
		const settings = structuredClone(DEFAULT_SETTINGS);
		const context = createTurnContext({
			state,
			getSettings: () => settings,
			providers: {} as ProvidersContract,
			readSessionEntries: () => entries,
			middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
			emitNotice: () => {},
			autoCompact: async () => {
				const result = await run(entries, selection);
				entries.push(checkpoint(result, "oversized"));
				return result;
			},
		});
		context.refreshAgentMessagesFromSession(runtime);
		await rejects(context.postToolContinuationGuard(runtime), /post-tool context guard stopped continuation/);
		ok(context.liveContextEstimate(runtime).tokens > 32768);
	});
});
