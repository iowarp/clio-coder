import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { readCallJournal } from "../../src/domains/observability/call-journal.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import { createSessionJournals } from "../../src/domains/observability/session-journals.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("a main call journals its stages in Pi's order, a budget refusal never reaches send, and each turn settles once (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-call-stages-");
	const faux = registerEngineFauxProvider({ api: "call-stages-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "text", text: "staged" }],
			api: faux.api,
			provider: "fixture",
			model: "chat",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 3,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	]);
	const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "oauth",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
	} as unknown as RuntimeDescriptor;
	const target = {
		id: "chat-target",
		runtime: "fixture",
		url: "https://chat.invalid/v1",
		defaultModel: "chat",
		capabilities: { contextWindow: 131072 },
		pricing: { input: 1, output: 1 },
	};
	const providers = {
		list: () => [
			{ target, runtime, available: true, capabilities, discoveredModels: ["chat"], discoveredModelsSource: "probe" },
		],
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		auth: {
			resolveForTarget: async () => ({
				providerId: "fixture",
				available: true,
				credentialType: "oauth",
				source: "stored-oauth",
				detail: "fixture",
				apiKey: "fixture-key",
				refreshed: true,
			}),
		},
	} as unknown as ProvidersContract;
	let refuse = false;
	const scheduling = {
		preflight: () => ({ currentUsd: 5, ceilingUsd: 5, verdict: "at" }),
		async admitPaidRequest(options: Parameters<NonNullable<SchedulingContract["admitPaidRequest"]>>[0]) {
			options.onBlocked?.({ level: "at", currentUsd: 5, ceilingUsd: 5 });
			if (refuse) throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	const entries: SessionEntry[] = [];
	const session = {
		current: () => ({ id: "stages-session", cwd: env.dir, cwdHash: "stages-repo" }),
		tree: () => ({ leafId: entries.at(-1)?.turnId ?? null }),
		append(turn: TurnInput) {
			const id = `turn-${entries.length + 1}`;
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: new Date().toISOString(),
				role: turn.kind,
				payload: turn.payload,
			} as SessionEntry);
			return { id };
		},
		appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
			const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() };
			entries.push(row as SessionEntry);
			return row;
		},
	} as unknown as SessionContract;
	const journals = createSessionJournals(clioStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = target.id;
	settings.chat.model = "chat";
	settings.chat.thinkingLevel = "off";
	settings.chat.prewarm = false;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		scheduling,
		session,
		readSessionEntries: () => entries,
		middleware: {
			registerHook: () => {},
			runHook: () => ({ effects: [], ruleIds: [] }),
		} as unknown as MiddlewareContract,
		knownTargets: () => new Set([target.id]),
		createAgent: (options) => createEngineAgent(options),
		observability: {
			acquireTelemetrySession: journals.acquire,
			recordSessionTurn() {},
			recordTokens() {},
			recordTokenThroughput() {},
			recordNeverSentCalls() {},
		} as unknown as ObservabilityContract,
		prompts: {
			inputEpoch: () => 0,
			compileSessionPrompt: async () => ({
				systemPrompt: "fixture prompt",
				systemPromptHash: "fixture",
				tokenEstimate: 1,
				sections: [],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
	});
	try {
		await loop.submit("stage this");
		refuse = true;
		await loop.submit("refuse this");
		await journals.flush();
		const journal = await readCallJournal(join(clioStateDir(), "sessions", "stages-repo", "stages-session"));
		const calls = journal.records.flatMap(({ record }) => (record.k === "call.settled" ? [record.data] : []));
		strictEqual(calls.length, 2, JSON.stringify(journal));
		const [sent, refused] = calls as [CallSettled, CallSettled];
		strictEqual(sent.disposition, "settled");
		const { transform, auth, admission, send, firstToken, settle } = sent.stages;
		ok(transform && auth && admission && send && firstToken !== undefined && settle !== null, JSON.stringify(sent));
		strictEqual(auth.refreshed, true);
		strictEqual(admission.waitedOn, "budget");
		const order = [
			transform.start,
			transform.end,
			auth.start,
			auth.end,
			admission.start,
			admission.end,
			send.start,
			send.end,
			firstToken,
			settle,
		];
		deepStrictEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
		strictEqual(refused.disposition, "never_sent");
		strictEqual(refused.stages.admission?.waitedOn, "budget");
		strictEqual(refused.stages.send, undefined);
		strictEqual(refused.stages.firstToken, undefined);
		// Each user turn settles once, from its own calls: a budget refusal ends at admission, never as a stall.
		const turns = journal.records.flatMap(({ record }) => (record.k === "turn.settled" ? [record.data] : []));
		deepStrictEqual(turns, [
			{
				stopReason: "stop",
				terminal: { cause: null, stage: "firstToken", retries: 0, callIds: [sent.callId] },
			},
			{
				stopReason: "error",
				terminal: { cause: "budget_wait_aborted", stage: "admission", retries: 0, callIds: [refused.callId] },
			},
		]);
	} finally {
		loop.dispose();
		faux.unregister();
		await journals.flush();
		env.restore();
	}
});
