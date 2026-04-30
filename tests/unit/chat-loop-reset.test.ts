import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { ClioSessionMeta, ClioTurnRecord } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import type { ToolRegistry } from "../../src/tools/registry.js";

/**
 * Verifies chat-loop.resetForSession wipes the two pieces of in-memory state
 * that pre-Row-52 bled pre-fork context into post-fork submits: the closure
 * `lastTurnId` pointer that user appends parent under, and the agent's
 * `state.messages` that the LLM sees on the next prompt.
 */

function fakeMeta(id: string): ClioSessionMeta {
	return {
		id,
		cwd: "/tmp/clio-reset-test",
		cwdHash: "h",
		createdAt: "2026-04-23T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
	};
}

describe("interactive/chat-loop resetForSession", () => {
	it("clears lastTurnId and agent.state.messages so the next submit parents fresh", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "stub-endpoint";
		settings.orchestrator.model = "stub-model";

		const endpoint = { id: "stub-endpoint", runtime: "stub-runtime", defaultModel: "stub-model" };
		const runtime: RuntimeDescriptor = {
			id: "stub-runtime",
			displayName: "Stub",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			synthesizeModel: () => ({ id: "stub-model", provider: "stub-runtime" }) as never,
		};

		const providers: ProvidersContract = {
			list: () => [],
			getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id) => (id === runtime.id ? runtime : null),
			probeAll: async () => {},
			probeAllLive: async () => {},
			probeEndpoint: async () => null,
			disconnectEndpoint: () => null,
			auth: {
				statusForTarget: () =>
					({
						providerId: "stub",
						available: true,
						source: "none",
						detail: "stub",
					}) as never,
				resolveForTarget: async () =>
					({
						providerId: "stub",
						available: true,
						source: "none",
						apiKey: "local",
					}) as never,
				getStored: () => null,
				listStored: () => [],
				setApiKey: () => {},
				remove: () => {},
				login: async () => {},
				logout: () => {},
				getOAuthProviders: () => [],
				setRuntimeOverrideForTarget: () => {},
				clearRuntimeOverrideForTarget: () => {},
			},
			credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
			getDetectedReasoning: () => null,
			probeReasoningForModel: async () => null,
			knowledgeBase: null,
		};

		let currentMeta: ClioSessionMeta | null = fakeMeta("session-1");
		const appended: ClioTurnRecord[] = [];
		const session: SessionContract = {
			current: () => currentMeta,
			create: () => {
				currentMeta = fakeMeta("session-1");
				return currentMeta;
			},
			append: (input) => {
				const rec: ClioTurnRecord = {
					id: `rec-${appended.length}`,
					parentId: input.parentId ?? null,
					at: "2026-04-23T00:00:00.000Z",
					kind: input.kind,
					payload: input.payload,
				};
				if (input.renderedPromptHash !== undefined) rec.renderedPromptHash = input.renderedPromptHash;
				appended.push(rec);
				return rec;
			},
			appendEntry: () => {
				throw new Error("unused in this test");
			},
			async checkpoint() {},
			resume: () => fakeMeta("session-1"),
			fork: () => fakeMeta("session-2"),
			tree: () => {
				throw new Error("unused in this test");
			},
			switchBranch: () => fakeMeta("session-1"),
			editLabel: () => {},
			deleteSession: () => {},
			history: () => [],
			async close() {},
		};

		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};

		let subscribeCb: ((event: unknown) => void | Promise<void>) | null = null;
		let sessionEntriesForProtectedArtifacts: SessionEntry[] = [];
		const replacedProtectedArtifactPaths: string[][] = [];
		const toolRegistry = {
			register: () => {},
			listVisible: () => [],
			listAll: () => [],
			get: () => undefined,
			listForMode: () => [],
			invoke: async () => {
				throw new Error("unused in this test");
			},
			protectedArtifacts: () => ({ artifacts: [] }),
			replaceProtectedArtifacts: (state: { artifacts: ReadonlyArray<{ path: string }> }) => {
				replacedProtectedArtifactPaths.push(state.artifacts.map((artifact) => artifact.path));
			},
			hasParkedCalls: () => false,
			resumeParkedCalls: async () => {},
			cancelParkedCalls: () => {},
			onSuperRequired: () => () => {},
		} as unknown as ToolRegistry;

		const loop = createChatLoop({
			getSettings: () => settings,
			modes: {
				current: () => "default",
				setMode: () => "default",
				cycleNormal: () => "default",
				visibleTools: () => new Set(),
				isToolVisible: () => false,
				isActionAllowed: () => true,
				requestSuper: () => {},
				confirmSuper: () => "super",
				elevatedModeFor: () => null,
			},
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			session,
			readSessionEntries: () => sessionEntriesForProtectedArtifacts,
			toolRegistry,
			createAgent: () => {
				const agent = {
					state: agentState,
					sessionId: undefined as string | undefined,
					subscribe: (cb: (event: unknown) => void | Promise<void>) => {
						subscribeCb = cb;
						return () => {
							subscribeCb = null;
						};
					},
					prompt: async (text: string) => {
						agentState.messages.push({
							role: "user",
							content: [{ type: "text", text }],
						} as AgentMessage);
						const assistantMessage: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "ack" }],
							stopReason: "stop",
							timestamp: 0,
						} as AgentMessage;
						if (subscribeCb) {
							await subscribeCb({ type: "message_end", message: assistantMessage });
							await subscribeCb({ type: "agent_end", messages: [assistantMessage] });
						}
						agentState.messages.push(assistantMessage);
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		await loop.submit("turn one");
		// The first submit records [user1, assistant1] and advances the
		// closure's lastTurnId onto the assistant record.
		strictEqual(appended.length, 2);
		strictEqual(appended[0]?.kind, "user");
		strictEqual(appended[0]?.parentId, null, "first user turn has no parent");
		strictEqual(appended[1]?.kind, "assistant");
		strictEqual(appended[1]?.parentId, appended[0]?.id, "assistant parents to user");

		// Without reset, the next submit would parent the new user turn to
		// appended[1].id. After resetForSession(null), it must fall back to
		// null so a freshly-forked branch does not carry stale lineage.
		loop.resetForSession(null);
		deepStrictEqual(agentState.messages, [], "agent messages cleared on reset");
		deepStrictEqual(replacedProtectedArtifactPaths.at(-1), [], "protected artifact state cleared on fresh reset");

		await loop.submit("turn two");
		strictEqual(appended.length, 4);
		strictEqual(appended[2]?.kind, "user");
		strictEqual(appended[2]?.parentId, null, `expected reset to clear lastTurnId, got ${String(appended[2]?.parentId)}`);

		// Reset to a specific leaf id (the resume case where the next user
		// turn must parent onto the resumed session's last turn) and seed the
		// provider context rebuilt from the resumed session entries.
		const replayed = {
			role: "user",
			content: [{ type: "text", text: "replayed context" }],
		} as AgentMessage;
		sessionEntriesForProtectedArtifacts = [
			{
				kind: "protectedArtifact",
				turnId: "pa1",
				parentTurnId: "leaf-from-disk",
				timestamp: "2026-04-23T00:00:02.000Z",
				action: "protect",
				artifact: {
					path: "validated.txt",
					protectedAt: "2026-04-23T00:00:02.000Z",
					reason: "validation passed",
					source: "session",
				},
			},
		];
		loop.resetForSession("leaf-from-disk", [replayed]);
		deepStrictEqual(agentState.messages, [replayed], "agent messages replaced with replayed context");
		deepStrictEqual(
			replacedProtectedArtifactPaths.at(-1),
			["validated.txt"],
			"protected artifact state rehydrated from resumed session entries",
		);
		await loop.submit("turn three");
		strictEqual(appended.length, 6);
		strictEqual(appended[4]?.kind, "user");
		strictEqual(appended[4]?.parentId, "leaf-from-disk", "next user turn parents under the supplied leaf");
		strictEqual(agentState.messages[0], replayed, "replayed context stays before the new prompt");
	});
});
