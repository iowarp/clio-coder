import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { createVisionSidecar } from "../../src/domains/providers/vision-sidecar.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { admitCompactionSummaryCall } from "../../src/domains/session/compaction/flow.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { AdmissionHold } from "../../src/domains/telemetry/call-scope.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { foldSideSurfaces } from "../../src/domains/telemetry/read-model.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createSideRequestAdmission } from "../../src/entry/side-request-admission.js";
import type { CreateChatLoopDeps } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type FauxSteps = Parameters<ReturnType<typeof registerEngineFauxProvider>["setResponses"]>[0];

const fauxAnswer = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "side-ceiling-fixture",
	provider: "fixture",
	model: "chat",
	stopReason: "stop" as const,
	timestamp: Date.now(),
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

/** A chat loop on a route with no rates anywhere, so its calls project nothing. */
function unpricedLoop(
	target: { id: string; runtime: string },
	scheduling: SchedulingContract,
	prewarm: boolean,
	extra: { responses?: FauxSteps; settings?: (settings: ClioSettings) => void; deps?: Partial<CreateChatLoopDeps> } = {},
) {
	const faux = registerEngineFauxProvider({ api: "side-ceiling-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	faux.setResponses(extra.responses ?? [fauxAnswer("answered past the ceiling")]);
	const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const runtime = {
		id: target.runtime,
		displayName: "Fixture",
		kind: "http",
		// Pre-warm runs only on local-native routes, which are the usual unpriced ones.
		tier: prewarm ? "local-native" : "cloud",
		apiFamily: "openai-completions",
		auth: "oauth",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
	} as unknown as RuntimeDescriptor;
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
			}),
		},
	} as unknown as ProvidersContract;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = target.id;
	settings.chat.model = "chat";
	settings.chat.thinkingLevel = "off";
	settings.chat.prewarm = prewarm;
	extra.settings?.(settings);
	return createChatLoop({
		getSettings: () => settings,
		providers,
		scheduling,
		session: { current: () => null } as unknown as SessionContract,
		readSessionEntries: () => [],
		middleware: {
			registerHook: () => {},
			runHook: () => ({ effects: [], ruleIds: [] }),
		} as unknown as MiddlewareContract,
		knownTargets: () => new Set([target.id]),
		isLatencySurface: () => prewarm,
		createAgent: (options) => createEngineAgent(options),
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
		...extra.deps,
	});
}

it("a compaction summary call is checked against the session cost ceiling whatever its route's pricing", async () => {
	let checked = 0;
	const scheduling = {
		admitPaidRequest: async (options: { onBlocked?: (block: never) => void; getCeilingUsd?: () => number }) => {
			checked += 1;
			strictEqual(options.getCeilingUsd?.(), 2);
			options.onBlocked?.({} as never);
		},
	} as unknown as SchedulingContract;
	const hold: AdmissionHold = {};
	await admitCompactionSummaryCall({ scheduling, headless: true, getCeilingUsd: () => 2 }, hold);
	strictEqual(checked, 1);
	strictEqual(hold.waitedOn, "budget");
});

it("side questions, System One and the safety judge are checked against the cost ceiling on an unpriced route", async (t) => {
	const env = await isolateClioEnv("clio-coder-side-call-ceiling-");
	t.after(() => env.restore());
	let checked = 0;
	const scheduling = {
		preflight: () => ({ currentUsd: 5, ceilingUsd: 5, verdict: "at" }),
		async admitPaidRequest() {
			checked += 1;
			throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	// No rates anywhere: the route projects nothing, but the session already spent its ceiling elsewhere.
	const target = { id: "unpriced", runtime: "fixture", url: "https://unpriced.invalid/v1", defaultModel: "chat" };
	const judge = createSideRequestAdmission({
		providers: { getTarget: () => target },
		scheduling,
		getCeilingUsd: () => 5,
		currentSession: () => null,
		repoIdentity: () => null,
		role: "safety-judge",
	});
	await rejects(judge({ targetId: "unpriced", model: "chat", signal: new AbortController().signal }), /ceiling/u);
	strictEqual(checked, 1);

	const loop = unpricedLoop(target, scheduling, false);
	const outcome = await loop.askSideQuestion("why?");
	strictEqual(checked, 2, JSON.stringify(outcome));
	strictEqual(outcome.status === "answered", false);
	match("reason" in outcome ? outcome.reason : "", /ceiling/u);
});

it("the pre-warm on an unpriced route is gated like the turn it warms, not held at the ceiling", async (t) => {
	const env = await isolateClioEnv("clio-coder-prewarm-ceiling-");
	t.after(() => env.restore());
	let checked = 0;
	const scheduling = {
		preflight: () => ({ currentUsd: 5, ceilingUsd: 5, verdict: "at" }),
		async admitPaidRequest() {
			checked += 1;
			throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	// A loaded, idle llama.cpp deployment on loopback, so the pre-warm reaches its prepare.
	const build = "b1-c841aee";
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		res.setHeader("content-type", "application/json");
		if (path === "/props") return res.end(JSON.stringify({ build_info: build, is_sleeping: false }));
		if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "chat" }] }));
		if (path === "/slots") return res.end(JSON.stringify([{ is_processing: false }]));
		res.writeHead(404);
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const target = {
		id: "unpriced",
		runtime: "llamacpp",
		url: `${root}/v1`,
		defaultModel: "chat",
		cache: { deployment: { backend: "llamacpp", controlUrl: root, model: "chat", build } },
	};
	const loop = unpricedLoop(target, scheduling, true);
	// The session-start round waits a quiet second on an unref'd timer; hold the loop open for it.
	const keepAlive = setTimeout(() => {}, 10_000);
	try {
		const outcome = await loop.whenPrewarmSettled();
		strictEqual(checked, 0, "the turn on this route is not gated, so neither is its pre-warm");
		strictEqual(outcome?.ran, true, JSON.stringify(outcome));
	} finally {
		clearTimeout(keepAlive);
		loop.dispose();
	}
});

it("the triage side round passes the cost ceiling under purpose triage, and the vision sidecar is journaled under purpose vision (memory MD2)", {
	timeout: 30_000,
}, async (t) => {
	const env = await isolateClioEnv("clio-coder-side-parity-");
	t.after(() => env.restore());
	const sessionId = "side-parity";
	const session = {
		current: () => ({ id: sessionId, cwd: env.dir, cwdHash: "side-parity-repo" }),
		tree: () => ({ leafId: null }),
		leafId: () => null,
		append: () => ({ id: "turn-1" }),
		appendEntry: (entry: object) => ({ ...entry, turnId: "entry-1", timestamp: new Date().toISOString() }),
	} as unknown as SessionContract;
	const journals = createSessionJournals(clioStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	const telemetry = { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract;
	let atCeiling = true;
	const admissions: boolean[] = [];
	const scheduling = {
		preflight: () => ({ currentUsd: atCeiling ? 5 : 0, ceilingUsd: 5, verdict: atCeiling ? "at" : "under" }),
		async admitPaidRequest(options: { waitForRaise: boolean }) {
			admissions.push(options.waitForRaise);
			if (atCeiling) throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	const idsIn = (context: unknown) => [...JSON.stringify(context).matchAll(/id=([\w-]+)/gu)].map((hit) => hit[1] ?? "");
	const verdicts = (ids: string[]) =>
		fauxAnswer(
			JSON.stringify({
				verdicts: ids.map((id, index) => ({
					id,
					relation: index === 0 ? "newTask" : "addition",
					urgency: index === 0 ? "endOfTurn" : "nextSlot",
					confidence: 0.9,
				})),
			}),
		);
	let release!: () => void;
	const turnHeld = new Promise<void>((resolve) => {
		release = resolve;
	});
	const target = { id: "unpriced", runtime: "fixture", url: "https://unpriced.invalid/v1", defaultModel: "chat" };
	const loop: ReturnType<typeof unpricedLoop> = unpricedLoop(target, scheduling, false, {
		responses: [
			// The queue moves while this round runs, so its verdict no longer describes it and is dropped.
			(context) => {
				const ids = idsIn(context);
				loop.steer("and update the changelog");
				return verdicts(ids);
			},
			(context) => verdicts(idsIn(context)),
		],
		settings: (settings) => {
			settings.chat.steering.triage.enabled = true;
			settings.chat.steering.triage.autoInterrupt = false;
		},
		deps: {
			session,
			readSessionEntries: () => [],
			telemetry,
			createAgent: ((options: { initialState?: unknown }) => ({
				agent: {
					state: options.initialState,
					subscribe: () => () => {},
					abort() {},
					steer() {},
					followUp() {},
					clearAllQueues() {},
					async prompt() {
						await turnHeld;
					},
				},
			})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		},
	});
	const settle = async (until: () => boolean) => {
		for (let i = 0; i < 400 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
		ok(until(), "the fixture reached its next step");
	};
	const unlabelled = () => loop.queueEntries().every((entry) => entry.labels === undefined && entry.kind === "steer");
	const turn = loop.submit("fix the cache");
	try {
		await settle(() => loop.isStreaming());
		// Over the ceiling: refused at admission, never parked on the operator, before anything is sent.
		strictEqual(loop.steer("also add docs"), true);
		strictEqual(loop.steer("and a test"), true);
		await settle(() => admissions.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		deepStrictEqual(admissions, [false], "an automatic round is refused at the ceiling, not held for a raise");
		ok(unlabelled(), "a refused round leaves the queue as the operator left it");

		// Under the ceiling: the stale round's verdict is dropped and the next round redirects exactly once.
		atCeiling = false;
		strictEqual(loop.steer("then rerun the suite"), true);
		await settle(() => loop.queueEntries().some((entry) => entry.labels?.producer === "triage"));
		const entries = loop.queueEntries();
		strictEqual(entries.length, 4);
		strictEqual(entries.filter((entry) => entry.kind === "follow-up").length, 1, "one entry moved to the turn's end");
		ok(entries.every((entry) => entry.labels?.producer === "triage"));
		strictEqual(admissions.length, 3, "each attempt passed admission");
	} finally {
		release();
		await turn;
		loop.dispose();
		await loop.whenSettled();
	}

	// The vision sidecar: one journaled call with the server's usage; no image, no call.
	const visionTarget = {
		id: "mini-vision",
		runtime: "llamacpp",
		url: "http://127.0.0.1:8081",
		defaultModel: "minicpm",
		capabilities: { chat: true, vision: true, contextWindow: 8192, maxTokens: 1024 },
	};
	const visionSettings = structuredClone(DEFAULT_SETTINGS);
	visionSettings.targets.push(visionTarget);
	visionSettings.fleet.profiles.vision = { target: visionTarget.id, model: "minicpm", thinkingLevel: "off" };
	const visionProviders = {
		getTarget: (id: string) => (id === visionTarget.id ? visionTarget : null),
		getRuntime: (id: string) => (id === "llamacpp" ? llamacpp : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
		list: () => [
			{
				target: visionTarget,
				runtime: llamacpp,
				available: true,
				reason: "fixture",
				health: { status: "healthy", lastCheckAt: "2026-11-20T00:00:00.000Z", lastError: null, latencyMs: 1 },
				capabilities: { ...llamacpp.defaultCapabilities, ...visionTarget.capabilities },
				discoveredModels: ["minicpm"],
			},
		],
	} as unknown as ProvidersContract;
	let visionRequests = 0;
	// The first answer reports its parts; the second, only a total.
	const visionUsage = [
		{ prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } },
		{ total_tokens: 50 },
	];
	const sidecar = createVisionSidecar({
		getSettings: () => visionSettings,
		providers: visionProviders,
		telemetry,
		session,
		fetchImpl: async () => {
			const usage = visionUsage[visionRequests];
			visionRequests += 1;
			return Response.json({
				model: "minicpm",
				usage,
				choices: [{ message: { content: '{"images":[{"index":1,"description":"a pixel"}],"answer":"one"}' } }],
			});
		},
	});
	const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
	strictEqual((await sidecar.analyze([image], "Count")).answer, "one");
	strictEqual((await sidecar.analyze([image], "Count")).answer, "one");
	await rejects(sidecar.analyze([], "Count"), /images per question/u);
	const cancelled = new AbortController();
	cancelled.abort();
	await rejects(sidecar.analyze([image], "Count", cancelled.signal));
	strictEqual(visionRequests, 2, "no image, or a request cancelled before it left, means no vision request");

	await journals.flush();
	const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), sessionId));
	const records = journal.records.map(({ record }) => record);
	const purposeOf = new Map<string, string | undefined>();
	const settledOf = new Map<string, CallSettled>();
	for (const record of records) {
		if (record.k === "call.started") purposeOf.set(record.data.callId, record.data.purpose);
		if (record.k === "call.settled") settledOf.set(record.data.callId, record.data);
	}
	const byPurpose = (purpose: string) =>
		[...purposeOf].filter(([, value]) => value === purpose).map(([callId]) => settledOf.get(callId));
	const triage = byPurpose("triage");
	strictEqual(triage.length, 3, "the refused, the stale and the applied round each journal a triage call");
	strictEqual(triage[0]?.disposition, "never_sent", "the refused round sent nothing");
	const vision = byPurpose("vision");
	strictEqual(vision.length, 2, "two image requests, two vision calls; the cancelled one journals nothing");
	strictEqual(vision[0]?.disposition, "settled");
	deepStrictEqual(
		[vision[0]?.usage?.input, vision[0]?.usage?.output, vision[0]?.usage?.cacheRead].map((fact) =>
			fact?.kind === "measured" ? fact.value : fact?.kind,
		),
		[32, 12, 8],
	);
	// A total-only report is a measured call, its parts unknown, never zero.
	strictEqual(vision[1]?.disposition, "settled");
	deepStrictEqual(
		[vision[1]?.usage?.total, vision[1]?.usage?.input, vision[1]?.usage?.output].map((fact) =>
			fact?.kind === "measured" ? fact.value : fact?.kind,
		),
		[50, "unknown", "unknown"],
	);
	const fold = foldSideSurfaces(records);
	strictEqual(fold.residual.length, 0, "every side call named its purpose");
	strictEqual(fold.surfaces.find((row) => row.surface === "vision")?.status, "exercised");
});
