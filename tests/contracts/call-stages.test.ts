import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { CallObservation } from "../../src/core/call-failure.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { telemetryContext } from "../../src/core/telemetry/context.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { lockedSynthesisRepromptMessages } from "../../src/engine/loop-guard.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { runOutOfTurnRound } from "../../src/session-control/side-question.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("a main call journals its stages in Pi's order and its cache physics, a budget refusal never reaches send, and each turn settles once (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-call-stages-");
	const faux = registerEngineFauxProvider({ api: "call-stages-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	const reply = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "staged" }],
		api: faux.api,
		provider: "fixture",
		model: "chat",
		stopReason: "stop" as const,
		timestamp: Date.now(),
		usage: {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	faux.setResponses([reply, reply, reply]);
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
		pricing: { input: 1, output: 1, cacheRead: 0.1 },
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
	let agent: ReturnType<typeof createEngineAgent>["agent"] | undefined;
	let memory = "one";
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
		createAgent: (options) => {
			const created = createEngineAgent(options);
			agent = created.agent;
			return created;
		},
		telemetry: {
			acquireTelemetrySession: journals.acquire,
			recordTokenThroughput() {},
		} as unknown as TelemetryContract,
		prompts: {
			inputEpoch: () => (memory === "one" ? 0 : 1),
			compileSessionPrompt: async () => ({
				systemPrompt: `fixture prompt\n\nmemory ${memory}`,
				systemPromptHash: `fixture-${memory}`,
				tokenEstimate: 1,
				sections: [
					{ id: "identity", tokenEstimate: 1, contentHash: "identity" },
					{ id: "memory", tokenEstimate: 1, contentHash: memory },
				],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
	});
	try {
		await loop.submit("stage this");
		memory = "two";
		await loop.submit("recompile this");
		// The loop guard's recovery pair opens with a reply Clio wrote; the model's answer after it is its own call.
		await agent?.prompt([...lockedSynthesisRepromptMessages(1, { provider: "fixture", api: faux.api, model: "chat" })]);
		refuse = true;
		await loop.submit("refuse this");
		await journals.flush();
		const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), "stages-session"));
		const calls = journal.records.flatMap(({ record }) => (record.k === "call.settled" ? [record.data] : []));
		strictEqual(calls.length, 5, JSON.stringify(journal));
		const [sent, recompiled, written, answered, refused] = calls as [
			CallSettled,
			CallSettled,
			CallSettled,
			CallSettled,
			CallSettled,
		];
		strictEqual(written.disposition, "never_sent");
		strictEqual(answered.disposition, "settled");
		ok(answered.callId !== written.callId);
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
		// A fresh session's first request re-prefills nothing. A recompiled memory section is named, and its re-prefill,
		// min(uncached, previous prompt − cache read), is billed at the input rate less the cache-read rate.
		const counted = (value: unknown) => ({ kind: "measured", value, source: "local-count" });
		const notApplicable = { kind: "absent", reason: "not-applicable" };
		deepStrictEqual(sent.cache.firstDivergentSection, notApplicable);
		deepStrictEqual(sent.cache.rePrefilledTokens, counted(0));
		deepStrictEqual(sent.cache.bill, { usd: counted(0), pricedBy: "target-rates" });
		const value = (fact: { kind: string; value?: unknown } | undefined) =>
			fact?.kind === "measured" ? Number(fact.value) : NaN;
		const previousPrompt = value(sent.usage?.input) + value(sent.usage?.cacheRead) + value(sent.usage?.cacheWrite);
		const rePrefilled = Math.min(value(recompiled.usage?.input), previousPrompt - value(recompiled.usage?.cacheRead));
		ok(rePrefilled > 0, JSON.stringify([sent.usage, recompiled.usage]));
		deepStrictEqual(recompiled.cache.firstDivergentSection, counted("memory"));
		deepStrictEqual(recompiled.cache.rePrefilledTokens, counted(rePrefilled));
		const bill = recompiled.cache.bill;
		ok(
			bill?.usd.kind === "measured" && Math.abs(bill.usd.value - (rePrefilled * 0.9) / 1e6) < 1e-15,
			JSON.stringify(bill),
		);
		strictEqual(bill.pricedBy, "target-rates");
		ok(recompiled.cache.expectedColdReasons.includes("prompt_recompiled"), JSON.stringify(recompiled.cache));
		strictEqual(recompiled.cache.verdict, "hot");
		deepStrictEqual(refused.cache.rePrefilledTokens, notApplicable);
		deepStrictEqual(refused.cache.firstDivergentSection, notApplicable);
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
				stopReason: "stop",
				terminal: { cause: null, stage: "firstToken", retries: 0, callIds: [recompiled.callId] },
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

it("a side call times its admission gate as its admission stage and names the ceiling that held it (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-call-stages-");
	const faux = registerEngineFauxProvider({
		api: "side-admission-fixture",
		models: [{ id: "side" }],
		tokensPerSecond: 0,
	});
	faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: faux.api,
			provider: "fixture",
			model: "side",
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
	const model = faux.getModel("side");
	ok(model);
	const journals = createSessionJournals(clioStateDir(), () => {});
	const origin = { id: "side-admission", cwdHash: "sidehash" };
	// The gate runs inside the attempt's call, so a budget hold it makes is journaled for that call (#424).
	let heldFor: string | undefined;
	try {
		const result = await runOutOfTurnRound({
			telemetry: {
				origin,
				acquire: journals.acquire,
				role: "btw",
				targetId: "side-target",
				runtimeId: "fixture",
				costProvenance: "known",
			},
			model,
			messages: [],
			systemPrompt: "fixture",
			userText: "question",
			thinkingLevel: "off",
			beforeRequest: async (hold) => {
				heldFor = telemetryContext()?.callId;
				hold.waitedOn = "budget";
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});
		strictEqual(result.text, "answer");
		await journals.closeAll();
		const settled = (await readCallJournal(telemetrySessionDirectory(clioStateDir(), origin.id))).records.flatMap(
			({ record }) => (record.k === "call.settled" ? [record.data] : []),
		);
		strictEqual(settled.length, 1);
		const admission = settled[0]?.stages.admission;
		strictEqual(admission?.waitedOn, "budget");
		ok(admission.end > admission.start, "the wait is inside the admission span");
		ok((settled[0]?.stages.send?.start ?? -1) >= admission.end, "the send follows admission");
		strictEqual(heldFor, settled[0]?.callId);
	} finally {
		await journals.closeAll();
		faux.unregister();
		env.restore();
	}
});

it("a side call whose session writer cannot open settles no call id, so its spend stays in the out-of-turn store (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-call-stages-");
	const faux = registerEngineFauxProvider({
		api: "side-unjournaled-fixture",
		models: [{ id: "side" }],
		tokensPerSecond: 0,
	});
	faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: faux.api,
			provider: "fixture",
			model: "side",
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
	const model = faux.getModel("side");
	ok(model);
	// A state directory that is a file: the session writer cannot open beneath it.
	const blocked = join(env.dir, "state-is-a-file");
	writeFileSync(blocked, "");
	let unavailable = 0;
	const journals = createSessionJournals(blocked, () => {
		unavailable += 1;
	});
	const observations: Array<CallObservation | undefined> = [];
	try {
		const result = await runOutOfTurnRound({
			telemetry: {
				origin: { id: "side-unjournaled", cwdHash: "sidehash" },
				acquire: journals.acquire,
				role: "btw",
				targetId: "side-target",
				runtimeId: "fixture",
				costProvenance: "known",
			},
			model,
			messages: [],
			systemPrompt: "fixture",
			userText: "question",
			thinkingLevel: "off",
			onUsage: (_usage, observation) => observations.push(observation),
		});
		ok(result.usage, "the round's usage still reaches its writer");
		ok(unavailable > 0);
		strictEqual(observations.length, 1);
		strictEqual(observations[0]?.callId, undefined, "a call id would make every usage writer skip the round");
	} finally {
		await journals.closeAll();
		faux.unregister();
		env.restore();
	}
});

it("a main call journals the model change and the Codex transport resets the host measured before it (#434)", async () => {
	const env = await isolateClioEnv("clio-coder-call-stages-");
	const faux = registerEngineFauxProvider({
		api: "cold-reasons-fixture",
		models: [{ id: "chat" }, { id: "other" }],
		tokensPerSecond: 0,
	});
	const reply = (recovery?: "cooldown_reset" | "auth_reset") => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "answered" }],
		api: faux.api,
		provider: "fixture",
		model: "chat",
		stopReason: "stop" as const,
		timestamp: Date.now(),
		usage: {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...(recovery
			? { codexTransport: { mode: "websocket", request: "full", recovery: { action: recovery, outcome: "recovered" } } }
			: {}),
	});
	// The cooldown reset closes the socket before its own call; the auth reset closes it after, so the next call pays.
	faux.setResponses([reply(), reply("cooldown_reset"), reply("auth_reset"), reply()]);
	const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
	} as unknown as RuntimeDescriptor;
	const target = {
		id: "chat-target",
		runtime: "fixture",
		url: "https://chat.invalid/v1",
		defaultModel: "chat",
		capabilities: { contextWindow: 131072 },
	};
	const providers = {
		list: () => [
			{
				target,
				runtime,
				available: true,
				capabilities,
				discoveredModels: ["chat", "other"],
				discoveredModelsSource: "probe",
			},
		],
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		auth: {
			resolveForTarget: async () => ({
				providerId: "fixture",
				available: true,
				credentialType: "api-key",
				source: "env",
				detail: "fixture",
				apiKey: "fixture-key",
			}),
		},
	} as unknown as ProvidersContract;
	const entries: SessionEntry[] = [];
	const session = {
		current: () => ({ id: "cold-session", cwd: env.dir, cwdHash: "cold-repo" }),
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
		session,
		readSessionEntries: () => entries,
		middleware: {
			registerHook: () => {},
			runHook: () => ({ effects: [], ruleIds: [] }),
		} as unknown as MiddlewareContract,
		knownTargets: () => new Set([target.id]),
		telemetry: {
			acquireTelemetrySession: journals.acquire,
			recordTokenThroughput() {},
		} as unknown as TelemetryContract,
		prompts: {
			inputEpoch: () => 0,
			compileSessionPrompt: async () => ({
				systemPrompt: "fixture prompt",
				systemPromptHash: "fixture",
				tokenEstimate: 1,
				sections: [{ id: "identity", tokenEstimate: 1, contentHash: "identity" }],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
	});
	try {
		await loop.submit("first");
		await loop.submit("cooldown");
		await loop.submit("auth");
		settings.chat.model = "other";
		await loop.submit("switched");
		await journals.flush();
		const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), "cold-session"));
		const calls = journal.records.flatMap(({ record }) => (record.k === "call.settled" ? [record.data] : []));
		deepStrictEqual(
			calls.map((call) => [call.disposition, [...call.cache.expectedColdReasons].sort()]),
			[
				["settled", []],
				["settled", ["transport_reset"]],
				["settled", []],
				["settled", ["model_changed", "transport_reset"]],
			],
			JSON.stringify(calls.map((call) => call.transport)),
		);
	} finally {
		loop.dispose();
		faux.unregister();
		await journals.flush();
		env.restore();
	}
});
