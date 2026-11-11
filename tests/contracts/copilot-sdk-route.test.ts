import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { isCopilotRefusal } from "../../src/core/copilot-refusal.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { createCapacityAdmissionController } from "../../src/domains/dispatch/admission.js";
import { classifyFailure } from "../../src/domains/dispatch/failure-classification.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import { copilotAuthState, detectCopilotLogin, prepareCopilotSdk } from "../../src/domains/providers/copilot-setup.js";
import { endpointCapacityFor, registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { isRetryableErrorMessage } from "../../src/domains/session/retry.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { copilotSdkAccount } from "../../src/engine/ai.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { normalizeContext } from "../../src/engine/context.js";
import {
	copilotSessionFsConfig,
	createCopilotSessionFs,
	removeCopilotSessionRecords,
	removeCopilotSessionRecordsSync,
} from "../../src/engine/copilot/session-fs.js";
import { disposeCopilotConversations } from "../../src/engine/copilot/stream.js";
import { getEngineEnvApiKey } from "../../src/engine/env-api-keys.js";
import { getEngineOAuthProvider } from "../../src/engine/oauth.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * A stand-in for @github/copilot-sdk, installed where Clio installs the real component. It records every
 * constructor option, session config and send, and plays scripted turns: plain text, one tool round
 * trip through a parked handler, a quota refusal, and a step whose tool is never answered.
 */
const FAKE_SDK = String.raw`
import { EventEmitter } from "node:events";
const state = (globalThis.__clioCopilotFake ??= {
	clients: [], instances: [], sessions: [], deleted: [], disconnected: [], toolResults: [], rejected: [],
	omitInternals: false, createGate: null, creating: 0, order: [], failBaselineOnce: false, referenced: false,
	auth: { isAuthenticated: true, login: "octo", host: "https://github.com" },
	models: [
		{ id: "fake-model", name: "Fake Model", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64000 } }, policy: { state: "enabled", terms: "" } },
		{ id: "unconfigured-model", name: "Needs Enabling", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64000 } }, policy: { state: "unconfigured", terms: "" } },
	],
});
class FakeSession {
	constructor(config, index, client) {
		this.client = client;
		this.config = config;
		this.sessionId = config.sessionId ?? "copilot-" + index;
		this.handlers = new Set();
		this.tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
		this.prompts = [];
		// The runtime's own session accounting, which usage.getMetrics() reads back.
		this.metrics = { totalPremiumRequestCost: 0, totalNanoAiu: 0 };
		this.metricsFail = false;
		this.metricsFailOnce = state.failBaselineOnce;
		state.failBaselineOnce = false;
		this.metricsDelayOnce = 0;
		this.rpc = { usage: { getMetrics: async () => {
			// The answer reflects the totals at the moment the request was made, however late it arrives.
			state.order.push("getMetrics " + this.sessionId);
			const snapshot = { ...this.metrics };
			if (this.metricsFail) throw new Error("metrics unavailable");
			if (this.metricsFailOnce) { this.metricsFailOnce = false; throw new Error("metrics unavailable"); }
			if (this.metricsDelayOnce > 0) {
				const delay = this.metricsDelayOnce;
				this.metricsDelayOnce = 0;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
			return { ...snapshot, totalUserRequests: 0, totalApiDurationMs: 0, sessionStartTime: "", lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {}, codeChanges: {} };
		} } };
	}
	usage(data) {
		if (!data.initiator && typeof data.cost === "number") this.metrics.totalPremiumRequestCost += data.cost;
		this.metrics.totalNanoAiu += data.copilotUsage?.totalNanoAiu ?? 0;
		this.emit("assistant.usage", data);
	}
	on(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
	emit(type, data) { for (const handler of [...this.handlers]) handler({ type, data, id: "e", parentId: null, timestamp: "" }); }
	async setModel() {}
	async setTools(tools) { this.tools = new Map(tools.map((tool) => [tool.name, tool])); }
	async abort() { this.aborted = true; }
	async disconnect() { state.disconnected.push(this.sessionId); }
	async send(options) {
		if (this.markedDisconnected) throw new Error("Session disconnected");
		state.order.push("send " + this.sessionId);
		(state.sends ??= []).push({ sessionId: this.sessionId, prompt: options.prompt, mode: options.mode });
		// Immediate mode joins the run in flight before its next model request; it starts no run of its own.
		if (options.mode === "immediate") { (this.injected ??= []).push(options.prompt); return "m"; }
		this.prompts.push(options.prompt);
		setTimeout(() => void this.run(options.prompt), 0);
		return "m";
	}
	/** As SDK 1.0.26 _markDisconnected(): handlers cleared, no terminal event. */
	markDisconnected() { this.markedDisconnected = true; this.handlers.clear(); }
	/**
	 * A tool request whose usage arrives only after Clio's tool result, as a late report. messageId is the id on
	 * the tool request, lateId the id on its late usage, nextId the id on the successor call's usage; any may be
	 * absent, and lateId may differ from messageId as Copilot's and the provider's namespaces do.
	 */
	async lateUsageTool(toolCallId, messageId, lateId, nextId) {
		const name = [...this.tools.keys()][0];
		this.emit("assistant.message", { messageId: "l1", ...(messageId ? { apiCallId: messageId } : {}), content: "", toolRequests: [{ toolCallId, name, arguments: {} }] });
		const result = await this.tools.get(name).handler({}, { toolCallId, sessionId: this.sessionId, toolName: name, arguments: {}, signal: new AbortController().signal });
		this.usage({ model: "fake-model", ...(lateId ? { apiCallId: lateId } : {}), inputTokens: 60, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 });
		this.usage({ model: "fake-model", ...(nextId ? { apiCallId: nextId } : {}), inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, initiator: "agent", cost: 1 });
		this.emit("assistant.message", { messageId: "l2", content: "after " + result.textResultForLlm });
		this.emit("session.idle", {});
	}
	async callTool(toolCallId) {
		const name = [...this.tools.keys()][0];
		this.emit("assistant.message", { messageId: "a1", apiCallId: "call-a", content: "", toolRequests: [{ toolCallId, name, arguments: { path: "notes.txt" } }] });
		// The live runtime may start the tool before reporting the call's usage; it still belongs to call-a.
		this.emit("external_tool.requested", { requestId: "r", sessionId: this.sessionId, toolCallId, toolName: name });
		this.usage({ model: "fake-model", apiCallId: "call-a", inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, cost: 1, copilotUsage: { totalNanoAiu: 5000 } });
		try {
			return await this.tools.get(name).handler({ path: "notes.txt" }, { toolCallId, sessionId: this.sessionId, toolName: name, arguments: {}, signal: new AbortController().signal });
		} catch (error) {
			state.rejected.push(String(error && error.message));
			return null;
		}
	}
	async run(prompt) {
		if (prompt.includes("refuse")) {
			this.emit("session.error", { errorType: "quota", errorCode: "quota_exceeded", statusCode: 429, message: "premium request allowance exhausted, rate limit" });
			this.emit("session.idle", {});
			return;
		}
		if (prompt.includes("park forever")) { await this.callTool("call_parked"); return; }
		if (prompt.includes("op:usage-first")) {
			// As the live runtime did: the call's usage, under the provider's own message id, before the tool request.
			const name = [...this.tools.keys()][0];
			this.usage({ model: "fake-model", apiCallId: "msg_provider_1", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 });
			this.emit("assistant.message", { messageId: "u1", apiCallId: "copilot-call-1", content: "", toolRequests: [{ toolCallId: "call_first", name, arguments: {} }] });
			return;
		}
		if (prompt.includes("op:undeclared") && !prompt.includes("<conversation-history>")) {
			// As the live runtime does when the model names a tool it was never given: it answers that call itself
			// ("does not exist") and goes on to its next model call, which parks on a declared tool.
			this.usage({ model: "fake-model", apiCallId: "call-u", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 });
			this.emit("assistant.message", { messageId: "u1", apiCallId: "call-u", content: "", toolRequests: [{ toolCallId: "call_hidden", name: "monitor", arguments: {} }] });
			void this.callTool("call_own");
			return;
		}
		if (prompt.includes("op:late-usage")) { await this.lateUsageTool("call_late", "late-a", "late-a", "late-a-next"); return; }
		if (prompt.includes("op:late-anon")) { await this.lateUsageTool("call_anon", null, null, null); return; }
		if (prompt.includes("op:reasoning-only")) {
			// A call that only reasoned, then went idle before its usage was reported.
			this.emit("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "thinking" });
			this.emit("session.idle", {});
			return;
		}
		if (prompt.includes("op:after-reasoning")) {
			this.usage({ model: "fake-model", apiCallId: "msg_A", inputTokens: 60, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 });
			this.usage({ model: "fake-model", apiCallId: "msg_B", inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 });
			this.emit("assistant.message", { messageId: "b1", content: "after" });
			this.emit("session.idle", {});
			return;
		}
		if (prompt.includes("op:late-namespace")) { await this.lateUsageTool("call_ns", "copilot-A", "msg_A", "msg_B"); return; }
		if (prompt.includes("op:late-idless-tagged")) { await this.lateUsageTool("call_tag", null, "msg_A", "msg_B"); return; }
		if (prompt.includes("op:hang")) { this.emit("assistant.message_delta", { messageId: "h1", deltaContent: "partial" }); return; }
		if (prompt.includes("op:usage-wait")) {
			this.usage({ model: "fake-model", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
			// The report has been delivered to every subscriber; the test interrupts only after this point.
			globalThis.__clioCopilotUsageReported?.();
			return;
		}
		if (prompt.includes("op:drop")) {
			this.emit("assistant.message_delta", { messageId: "d1", deltaContent: "partial" });
			this.client.dropRuntime();
			return;
		}
		if (prompt.includes("op:metrics-fail-once")) this.metricsFailOnce = true;
		if (prompt.includes("op:slow-metrics")) this.metricsDelayOnce = 1500;
		if (prompt.includes("use tool")) {
			const result = await this.callTool("call_1");
			if (!result) return;
			state.toolResults.push({ ...result, injectedBefore: [...(this.injected ?? [])] });
			this.injected = [];
			this.usage({ model: "fake-model", apiCallId: "call-b", inputTokens: 130, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, initiator: "agent", cost: 1 });
			this.emit("assistant.message_delta", { messageId: "a2", deltaContent: "tool said " + result.textResultForLlm });
			this.emit("assistant.message", { messageId: "a2", content: "tool said " + result.textResultForLlm });
			this.emit("session.idle", {});
			return;
		}
		if (prompt.includes("zero usage")) {
			this.usage({ model: "fake-model", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
		} else if (prompt.includes("partial credits")) {
			this.metricsFail = true;
			this.usage({ model: "fake-model", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, copilotUsage: { totalNanoAiu: 700 } });
			this.usage({ model: "fake-model", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 });
		} else {
			// Omits the cache counts: the uncached input and both cache counts are unknown, not zero.
			this.usage({ model: "fake-model", inputTokens: 20, outputTokens: 2, cost: 1, copilotUsage: { totalNanoAiu: 100 } });
		}
		this.emit("assistant.message_delta", { messageId: "a1", deltaContent: "hello" });
		this.emit("assistant.message", { messageId: "a1", content: "hello" });
		this.emit("session.idle", {});
	}
}
export class CopilotClient {
	constructor(options) {
		// The real 1.0.26 constructor contract.
		if (options.mode === "empty" && options.baseDirectory === undefined && options.sessionFs == null)
			throw new Error("CopilotClient was created with mode: 'empty' but neither 'baseDirectory' nor 'sessionFs' was set. Empty mode requires an explicit per-session persistence location; pick one.");
		this.options = options;
		state.clients.push(options);
		state.instances.push(this);
		this.state = "disconnected";
		this.sessionsOpen = [];
		// The private 1.0.26 layout Clio's client watches: the stdio child, its start timer and the state field.
		if (!state.omitInternals) {
			// ref/unref record whether Clio currently keeps the runtime alive (it holds it while work is pending).
			const handle = () => Object.assign(new EventEmitter(), { ref() { state.referenced = true; }, unref() { state.referenced = false; } });
			this.cliProcess = Object.assign(handle(), { stdin: handle(), stdout: handle(), stderr: handle() });
			this.cliStartTimeout = null;
		}
	}
	async start() { this.state = "connected"; }
	async stop() { this.state = "disconnected"; return []; }
	async forceStop() { this.state = "disconnected"; }
	/** The runtime child exits: every session is marked disconnected, as the SDK does, and the child emits exit. */
	dropRuntime() {
		this.state = "disconnected";
		for (const session of this.sessionsOpen) session.markDisconnected();
		this.cliProcess?.emit("exit", 1);
	}
	async getAuthStatus() { return state.auth; }
	async listModels() { return state.models; }
	async deleteSession(id) { state.deleted.push(id); }
	async createSession(config) {
		if (this.options.mode === "empty" && config.availableTools === undefined)
			throw new Error("CopilotClient is in mode: 'empty' but the session config did not specify 'availableTools'.");
		if (!state.models.some((model) => model.id === config.model) && config.model !== "served-unlisted")
			throw new Error('Request session.create failed with message: Model "' + config.model + '" is not available.');
		state.creating += 1;
		if (state.createGate) await state.createGate;
		const session = new FakeSession(config, state.sessions.length + 1, this);
		this.sessionsOpen.push(session);
		if (this.options.sessionFs) {
			if (!config.createSessionFsProvider) throw new Error("createSessionFsProvider is required in session config when sessionFs is enabled in client options.");
			session.fs = config.createSessionFsProvider(session);
			// As the 1.0.26 runtime does during session.create: the working directory, an absolute path in the
			// provider's namespace (rooted at initialCwd), is stat'ed through sessionFs and must be a directory.
			const cwd = config.workingDirectory ?? this.options.sessionFs.initialCwd;
			let info;
			try {
				info = await session.fs.stat(cwd);
			} catch (error) {
				throw new Error("Request session.create failed with message: session construction failed: " + error.message);
			}
			if (!info.isDirectory) throw new Error("session construction failed: " + cwd + " is not a directory");
			await session.fs.mkdir(this.options.sessionFs.sessionStatePath, true);
			await session.fs.appendFile(this.options.sessionFs.sessionStatePath + "/events.jsonl", "{}\n");
			session.recordsId = config.sessionId;
		}
		state.sessions.push(session);
		return session;
	}
}
`;

interface FakeSession {
	sessionId: string;
	config: Record<string, unknown> & { tools: Array<Record<string, unknown>> };
	prompts: string[];
}
interface FakeState {
	clients: Array<Record<string, unknown> & { env: Record<string, string | undefined> }>;
	sessions: FakeSession[];
	deleted: string[];
	disconnected: string[];
	toolResults: Array<{ textResultForLlm: string; resultType: string; injectedBefore: string[] }>;
	sends?: Array<{ sessionId: string; prompt: string; mode?: string }>;
	rejected: string[];
	auth: { isAuthenticated: boolean; login?: string; host?: string };
	instances: unknown[];
	omitInternals: boolean;
	createGate: Promise<void> | null;
	creating: number;
	order: string[];
	failBaselineOnce: boolean;
	referenced: boolean;
}
const fake = (): FakeState => (globalThis as { __clioCopilotFake?: FakeState }).__clioCopilotFake as FakeState;

const SECRET = "ghp_clioCopilotRouteNeverStored0000";
const HOST_NOTE = "\n\n[middleware:info] prefer the structured observe tools over shell file inspection";
let env: IsolatedClioEnv;

before(async () => {
	env = await isolateClioEnv("clio-copilot-route-");
	process.env.GH_TOKEN = SECRET;
	process.env.COPILOT_GITHUB_TOKEN = SECRET;
	const dir = join(
		resolveClioDirs().data,
		"components",
		"copilot-sdk",
		"1.0.26",
		"node_modules",
		"@github",
		"copilot-sdk",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: "./index.js" }),
	);
	writeFileSync(join(dir, "index.js"), FAKE_SDK);
	registerClioApiProviders();
});

after(() => {
	disposeCopilotConversations("route-session");
	disposeCopilotConversations("side-session");
	env.restore();
});

const model = {
	id: "fake-model",
	name: "fake",
	api: "copilot-sdk",
	provider: "copilot-sdk",
	baseUrl: "copilot-sdk://local",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64000,
	maxTokens: 4096,
} as unknown as Model<Api>;
const readTool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

async function step(context: Context, sessionId = "route-session", signal?: AbortSignal): Promise<AssistantMessage> {
	return engineStreamSimple(model, normalizeContext(context), { sessionId, ...(signal ? { signal } : {}) }).result();
}

/**
 * The promise's value if it settles within a bounded number of event-loop turns, else "pending". Turns, not
 * milliseconds: the work under test is event-driven, so no wall-clock threshold decides the outcome.
 */
// Callers that expect settlement use the large default: real I/O can lag event-loop turns on a loaded host.
async function eventually(condition: () => boolean, deadlineMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return true;
}

async function settledWithinTurns<T>(promise: Promise<T>, turns = 100_000): Promise<T | "pending"> {
	let outcome: { value: T } | null = null;
	void promise.then((value) => {
		outcome = { value };
	});
	for (let turn = 0; turn < turns && outcome === null; turn += 1) await new Promise((resolve) => setImmediate(resolve));
	return outcome === null ? "pending" : (outcome as { value: T }).value;
}

const toolResult = (toolCallId: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName: "read",
	content: [{ type: "text" as const, text }],
	isError: false,
	timestamp: 3,
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

test("the retired Pi github-copilot route is unreachable", async () => {
	strictEqual(getEngineOAuthProvider("github-copilot"), undefined);
	strictEqual(getEngineEnvApiKey("github-copilot"), undefined);
	const auth = openAuthStorage();
	auth.set("github-copilot", {
		type: "api_key",
		key: "ghu_storedByAnOlderHome",
		updatedAt: new Date().toISOString(),
	} as never);
	const resolved = await auth.resolveForTarget({ providerId: "github-copilot", runtimeAuth: "api-key" });
	strictEqual(resolved.available, false);
	strictEqual(resolved.apiKey, undefined);
	match(resolved.detail ?? "", /copilot login/);
	let refusal = "";
	try {
		const result = await engineStreamSimple(
			{ ...model, api: "openai-completions", provider: "github-copilot" },
			normalizeContext({ messages: [user("hi")] }),
		).result();
		refusal = result.errorMessage ?? "";
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
	}
	match(refusal, /copilot-sdk/);
});

test("the copilot-sdk route sends no other client's identity anywhere", () => {
	const banned = [
		/Iv1\.b507a08c87ecfe98/,
		/SXYxLmI1MDdhMDhjODdlY2ZlOTg/,
		/vscode-chat/i,
		/GitHubCopilotChat/,
		/Editor-Version/i,
		/Editor-Plugin-Version/i,
		/Copilot-Integration-Id/i,
		/copilot_internal/,
		/\/policy\b/,
	];
	const files = [
		...filesUnder("src/engine/copilot"),
		...filesUnder("src/domains/providers/runtimes/copilot"),
		"src/domains/providers/copilot-setup.ts",
		"src/domains/lifecycle/copilot-sdk-install.ts",
	];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const pattern of banned) strictEqual(pattern.test(source), false, `${file} matches ${pattern}`);
	}
});

test("the signed-in account is the authorization: no Clio consent is asked, and signed out names copilot login", async () => {
	// A consent record a 0.7.0-rc.1 home wrote, here for another account, neither grants nor blocks anything.
	const consentFile = join(resolveClioDirs().state, "copilot-sdk-consent.json");
	mkdirSync(resolveClioDirs().state, { recursive: true });
	writeFileSync(
		consentFile,
		JSON.stringify({ version: 1, accounts: [{ login: "someone-else", host: "https://github.com", acceptedAt: "x" }] }),
	);
	deepStrictEqual(await copilotSdkAccount(), { login: "octo", host: "https://github.com" });
	const signedIn = fake().auth;
	fake().auth = { isAuthenticated: false };
	try {
		const refused = await step({ messages: [user("hello")] });
		strictEqual(refused.stopReason, "error");
		match(refused.errorMessage ?? "", /not signed in.*`copilot login`/);
		strictEqual(fake().sessions.length, 0, "no Copilot session is opened without a login");
	} finally {
		fake().auth = signedIn;
	}
	const answered = await step({ messages: [user("hello")] });
	strictEqual(answered.stopReason, "stop");
	deepStrictEqual(answered.content, [{ type: "text", text: "hello" }]);
});

test("auth status names the account and host; a sign-in run by auth login is read by a restarted runtime", async () => {
	deepStrictEqual(await copilotAuthState(false), { present: true, detail: "signed in as octo on github.com" });
	const signedIn = fake().auth;
	fake().auth = { isAuthenticated: false };
	try {
		const signedOut = await copilotAuthState(false);
		strictEqual(signedOut.present, false);
		match(signedOut.detail, /not signed in; run `copilot login`/);

		await rejects(copilotSdkAccount(), /not signed in/);
		const clientsBefore = fake().clients.length;
		const printed: string[] = [];
		const result = await prepareCopilotSdk({
			print: (text) => printed.push(text),
			signIn: async () => {
				fake().auth = { isAuthenticated: true, login: "octo", host: "https://github.com" };
				return true;
			},
		});
		deepStrictEqual(result, { ok: true, account: { login: "octo", host: "https://github.com" } });
		ok(fake().clients.length > clientsBefore, "the account is read from a runtime started after the sign-in");

		fake().auth = { isAuthenticated: false };
		const declined = await prepareCopilotSdk({ print: () => {}, signIn: async () => false });
		strictEqual(declined.ok, false);
	} finally {
		fake().auth = signedIn;
	}
});

test("onboarding picks the curated Copilot model when the account lists it, else the listing's first", async () => {
	strictEqual((await detectCopilotLogin(5_000))?.model, "fake-model");
	const models = (fake() as unknown as { models: Array<Record<string, unknown>> }).models;
	const original = [...models];
	models.push({ ...original[0], id: "gpt-6-luna", name: "GPT-6 Luna" });
	try {
		strictEqual((await detectCopilotLogin(5_000))?.model, "gpt-6-luna");
	} finally {
		models.splice(0, models.length, ...original);
	}
});

test("a model the runtime does not serve fails naming the account's enabled models; an unlisted one it serves runs", async () => {
	const refused = await engineStreamSimple(
		{ ...model, id: "no-such-model" },
		normalizeContext({ messages: [user("hello")] }),
		{ sessionId: "unknown-model" },
	).result();
	strictEqual(refused.stopReason, "error");
	match(
		refused.errorMessage ?? "",
		/Model "no-such-model" is not available\. GitHub Copilot lists these models for this account: fake-model\.$/,
	);
	const served = await engineStreamSimple(
		{ ...model, id: "served-unlisted" },
		normalizeContext({ messages: [user("hello")] }),
		{ sessionId: "unlisted-model" },
	).result();
	strictEqual(served.stopReason, "stop");
});

test("the runtime authenticates as the copilot login user only, and no token reaches Clio's files", () => {
	const options = fake().clients[0];
	ok(options);
	strictEqual(options.useLoggedInUser, true);
	strictEqual("gitHubToken" in options, false);
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) strictEqual(options.env[name], undefined);
	const session = fake().sessions[0];
	ok(session);
	strictEqual(session.config.clientName, "clio-coder");
	deepStrictEqual(session.config.availableTools, ["custom:*"]);
	deepStrictEqual(session.config.systemMessage, { mode: "replace", content: "" });
	for (const file of filesUnder(env.dir)) {
		if (file.includes(join("components", "copilot-sdk"))) continue;
		strictEqual(readFileSync(file, "utf8").includes(SECRET), false, `${file} holds a token`);
	}
});

test("Clio's loop runs the tool; Copilot continues the same session and reports billing as facts", async () => {
	disposeCopilotConversations("route-session");
	const before = fake().sessions.length;
	const context: Context = { systemPrompt: "You are Clio.", tools: [readTool], messages: [user("please use tool")] };
	const first = await step(context);
	strictEqual(first.stopReason, "toolUse");
	const call = first.content.find((block) => block.type === "toolCall");
	ok(call && call.type === "toolCall");
	strictEqual(call.id, "call_1");
	const second = await step({
		...context,
		messages: [
			...context.messages,
			first,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: `file body${HOST_NOTE}` }],
				isError: false,
				timestamp: 2,
			},
			user("<system-reminder>host note</system-reminder>"),
			user("operator steer"),
		],
	});
	strictEqual(second.stopReason, "stop");
	match((second.content[0] as { text: string }).text, /tool said file body/);
	strictEqual(fake().sessions.length, before + 1, "the tool round trip reuses one Copilot session");
	// The tool's output and the registry's note reach Copilot exactly as Clio wrote them, the host reminder rides
	// with them in its own frame, and the operator's steer is never part of the tool result.
	strictEqual(
		fake().toolResults.at(-1)?.textResultForLlm,
		`file body${HOST_NOTE}\n\n<system-reminder>host note</system-reminder>`,
	);
	// The steer is a real user message in immediate mode, in the run before its next model request.
	deepStrictEqual(fake().toolResults.at(-1)?.injectedBefore, ["operator steer"]);
	deepStrictEqual(
		fake()
			.sends?.filter((entry) => entry.mode === "immediate")
			.map((entry) => entry.prompt),
		["operator steer"],
	);
	const firstSettled = callSettlementFromMessage(first, "none");
	// Usage reported after the tool started still settles on the call that requested the tool.
	deepStrictEqual(firstSettled.usage?.input, { kind: "measured", value: 60, source: "provider" });
	deepStrictEqual(callSettlementFromMessage(second, "none").usage?.input, {
		kind: "measured",
		value: 30,
		source: "provider",
	});
	deepStrictEqual(reportedModelFromMessage(first), { kind: "measured", value: "fake-model", source: "provider" });
	deepStrictEqual(firstSettled.billing?.premiumRequests, { kind: "measured", value: 1, source: "provider" });
	deepStrictEqual(firstSettled.billing?.nanoAiu, { kind: "measured", value: 5000, source: "provider" });
	deepStrictEqual(firstSettled.usage?.cacheRead, { kind: "measured", value: 40, source: "provider" });
	// Premium requests are the runtime's own session total's growth: the agent continuation added none.
	deepStrictEqual(callSettlementFromMessage(second, "none").billing?.premiumRequests, {
		kind: "measured",
		value: 0,
		source: "provider",
	});
	strictEqual(firstSettled.pricing.usd.kind, "unknown", "a seat call never renders a dollar price");
});

test("a call to a tool Copilot was never given reseeds the next call instead of waiting on Copilot's own run", async () => {
	disposeCopilotConversations("undeclared-session");
	const before = fake().sessions.length;
	const context: Context = { systemPrompt: "You are Clio.", tools: [readTool], messages: [user("op:undeclared")] };
	const first = await step(context, "undeclared-session");
	strictEqual(first.stopReason, "toolUse");
	const diverged = fake().sessions.at(-1) as FakeSession & { aborted?: boolean };
	const result = { ...toolResult("call_hidden", "the worker found a stencil bug"), toolName: "monitor" };
	const second = await settledWithinTurns(
		step({ ...context, messages: [...context.messages, first, result] }, "undeclared-session"),
	);
	ok(second !== "pending", "the next call must not wait on a Copilot run that already answered the call itself");
	strictEqual(second.stopReason, "stop");
	strictEqual(diverged.aborted, true, "the diverged Copilot run is closed");
	strictEqual(fake().sessions.length, before + 2, "the next call opens a fresh session");
	match(fake().sessions.at(-1)?.prompts[0] ?? "", /the worker found a stencil bug/);
	disposeCopilotConversations("undeclared-session");
});

test("a reminder-only follow-up rides on the tool result; a steer is sent once and never replayed", async () => {
	disposeCopilotConversations("steer-session");
	const sendsBefore = fake().sends?.length ?? 0;
	const context: Context = { systemPrompt: "You are Clio.", tools: [readTool], messages: [user("please use tool")] };
	const first = await step(context, "steer-session");
	strictEqual(first.stopReason, "toolUse");
	const withResult = [...context.messages, first, toolResult("call_1", "file body")];
	const second = await step(
		{ ...context, messages: [...withResult, user("<system-reminder>only a reminder</system-reminder>")] },
		"steer-session",
	);
	strictEqual(second.stopReason, "stop");
	strictEqual(
		fake().toolResults.at(-1)?.textResultForLlm,
		"file body\n\n<system-reminder>only a reminder</system-reminder>",
	);
	deepStrictEqual(fake().toolResults.at(-1)?.injectedBefore, []);
	strictEqual(
		fake()
			.sends?.slice(sendsBefore)
			.some((entry) => entry.mode === "immediate"),
		false,
		"a reminder alone is no operator message",
	);
	// A steer, then the next turn: the steer is in Clio's transcript, so Copilot already has it and gets only what is new.
	const third = await step(
		{ ...context, messages: [...withResult, second, user("please use tool again")] },
		"steer-session",
	);
	strictEqual(third.stopReason, "toolUse");
	const fourth = await step(
		{
			...context,
			messages: [
				...withResult,
				second,
				user("please use tool again"),
				third,
				toolResult("call_1", "second body"),
				user("<system-reminder>r</system-reminder>\nWhile you are at it, also list the dir"),
			],
		},
		"steer-session",
	);
	strictEqual(fourth.stopReason, "stop");
	strictEqual(fake().toolResults.at(-1)?.textResultForLlm, "second body\n\n<system-reminder>r</system-reminder>");
	deepStrictEqual(fake().toolResults.at(-1)?.injectedBefore, ["While you are at it, also list the dir"]);
	await step(
		{
			...context,
			messages: [
				...withResult,
				second,
				user("please use tool again"),
				third,
				toolResult("call_1", "second body"),
				user("<system-reminder>r</system-reminder>\nWhile you are at it, also list the dir"),
				fourth,
				user("thanks"),
			],
		},
		"steer-session",
	);
	const later = fake().sends?.slice(sendsBefore) ?? [];
	deepStrictEqual(
		later.map((entry) => [entry.mode ?? "enqueue", entry.prompt]),
		[
			["enqueue", "please use tool"],
			["enqueue", "please use tool again"],
			["immediate", "While you are at it, also list the dir"],
			["enqueue", "thanks"],
		],
	);
	disposeCopilotConversations("steer-session");
});

test("usage facts keep per-field presence and billing coverage", async () => {
	const omitted = callSettlementFromMessage(await step({ messages: [user("hello")] }, "facts-session"), "none");
	deepStrictEqual(omitted.usage?.output, { kind: "measured", value: 2, source: "provider" });
	for (const field of ["input", "cacheRead", "cacheWrite"] as const)
		strictEqual(omitted.usage?.[field].kind, "unknown", `${field} was omitted, so it is not a measured zero`);
	const zeros = callSettlementFromMessage(await step({ messages: [user("zero usage")] }, "facts-session"), "none");
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
		deepStrictEqual(zeros.usage?.[field], { kind: "measured", value: 0, source: "provider" });
	const partial = callSettlementFromMessage(
		await step({ messages: [user("partial credits")] }, "facts-session"),
		"none",
	);
	strictEqual(partial.billing?.nanoAiu.kind, "unknown", "one of two calls reported credits");
	strictEqual(partial.billing?.premiumRequests.kind, "unknown", "no accounting answer is not zero");
	strictEqual(partial.usage?.cacheWrite.kind, "unknown", "one of two calls omitted cache writes");
	deepStrictEqual(partial.usage?.output, { kind: "measured", value: 2, source: "provider" });
	disposeCopilotConversations("facts-session");
});

test("a rewritten history seeds a fresh session; a side call never disturbs the main one", async () => {
	disposeCopilotConversations("route-session");
	const start = fake().sessions.length;
	const turn1 = await step({ messages: [user("first")] });
	const turn2 = await step({ messages: [user("first"), turn1, user("second")] });
	strictEqual(fake().sessions.length, start + 1, "a strict extension reuses the session");
	await step({ messages: [user("side question")] }, "route-session");
	strictEqual(fake().sessions.length, start + 2, "a side call gets its own session");
	await step({ messages: [user("first"), turn1, user("second"), turn2, user("third")] });
	strictEqual(fake().sessions.length, start + 2, "the main conversation survived the side call");
	await step({ messages: [user("compacted summary"), turn1, user("third")] });
	strictEqual(fake().sessions.length, start + 3, "compaction is a divergence");
	match(fake().sessions.at(-1)?.prompts[0] ?? "", /conversation-history[\s\S]*compacted summary/);
});

test("a Copilot refusal is surfaced and never retried or moved to another target", async () => {
	const refused = await step({ messages: [user("please refuse")] }, "side-session");
	strictEqual(refused.stopReason, "error");
	ok(isCopilotRefusal(refused.errorMessage));
	match(refused.errorMessage ?? "", /quota_exceeded/);
	strictEqual(isRetryableErrorMessage(refused.errorMessage), false);
	strictEqual(
		classifyFailure(
			{
				exitCode: 1,
				abortedByOperator: false,
				stallKilled: false,
				timedOut: false,
				policyDenied: null,
				permissionFailure: false,
			} as never,
			null,
			"failed",
			null,
			refused.errorMessage,
		),
		"policy",
	);
});

test("parked tool handlers settle when the Clio session ends, and the session is removed", async () => {
	const parked = await step({ tools: [readTool], messages: [user("park forever")] }, "side-session");
	strictEqual(parked.stopReason, "toolUse");
	const session = fake().sessions.at(-1);
	ok(session);
	// Session records live under Clio's cache root, never under COPILOT_HOME, and leave with the session.
	const records = join(resolveClioDirs().cache, "copilot-sdk", "sessions", session.sessionId);
	ok(existsSync(join(records, "events.jsonl")));
	disposeCopilotConversations("side-session");
	// Dispose rejects the parked handlers at once, then disconnects and removes the records asynchronously. Wait for
	// those events, not for a fixed time a loaded host may not keep to; the bound only stops a real regression hanging.
	const ended = () => fake().rejected.some((reason) => /Clio session ended/.test(reason));
	ok(await eventually(ended, 60_000), "the parked handler was rejected");
	ok(await eventually(() => fake().disconnected.includes(session.sessionId), 60_000), "the session was disconnected");
	ok(await eventually(() => !existsSync(records), 60_000), "the session's records were removed");
});

test("a runtime that never answers abort still releases the session's hold", async () => {
	const parked = await step({ tools: [readTool], messages: [user("park forever")] }, "hung-session");
	strictEqual(parked.stopReason, "toolUse");
	const session = fake().sessions.at(-1) as FakeSession & { abort: () => Promise<void> };
	ok(session);
	session.abort = () => new Promise<void>(() => undefined);
	// The dispose RPC deadline runs on a mocked clock, so the wait ends on the disconnect and release themselves,
	// never on host speed. Each round fires every timer due within one deadline; setImmediate is not mocked, so real
	// I/O in dispose still runs between rounds, and real time only bounds a stuck dispose.
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		disposeCopilotConversations("hung-session");
		const until = Date.now() + 30_000;
		while (!(fake().disconnected.includes(session.sessionId) && !fake().referenced) && Date.now() < until) {
			mock.timers.tick(3_000);
			await new Promise((resolve) => setImmediate(resolve));
		}
	} finally {
		mock.timers.reset();
	}
	ok(fake().disconnected.includes(session.sessionId), "dispose moves on to disconnect");
	strictEqual(fake().referenced, false, "no hold outlives the unanswered abort");
});

test("sessionFs keeps session state in Clio's cache and serves the workspace read-only at its real paths", async () => {
	const config = fake().clients[0]?.sessionFs as { initialCwd: string; sessionStatePath: string };
	strictEqual(config.initialCwd, process.cwd());
	// A provider of its own: the fake's last session was closed by the previous test, and a closed session's
	// state is never written again.
	const session = { sessionId: "readonly-check-session", fs: createCopilotSessionFs("readonly-check-session") };
	const workspaceFile = join(process.cwd(), "package.json");
	ok((await session.fs.stat(workspaceFile)).isFile);
	match(await session.fs.readFile(workspaceFile), /clio-coder/);
	for (const write of [
		() => session.fs.writeFile(join(process.cwd(), "copilot-wrote.txt"), "x"),
		() => session.fs.mkdir(join(process.cwd(), "copilot-dir"), true),
		() => session.fs.rm(workspaceFile, false, false),
		// ".." out of the state path is a workspace path, so it is refused too.
		() => session.fs.writeFile(join(config.sessionStatePath, "a", "..", "..", "escape.txt"), "x"),
	]) {
		await rejects(write(), /Clio does not let the Copilot runtime change/);
	}
	strictEqual(existsSync(join(process.cwd(), "copilot-wrote.txt")), false);
	await session.fs.writeFile(join(config.sessionStatePath, "note.txt"), "state");
	strictEqual(
		readFileSync(join(resolveClioDirs().cache, "copilot-sdk", "sessions", session.sessionId, "note.txt"), "utf8"),
		"state",
	);
	strictEqual(existsSync(config.sessionStatePath), false, "the state path itself is never written as is");
});

test("late usage stays with the call that made it and never lands on its successor", async () => {
	for (const [prompt, key] of [
		["op:late-usage", "late-session"],
		["op:late-anon", "anon-session"],
		["op:late-namespace", "namespace-session"],
		["op:late-idless-tagged", "tagged-session"],
	] as const) {
		const context: Context = { tools: [readTool], messages: [user(prompt)] };
		const first = await step(context, key);
		strictEqual(first.stopReason, "toolUse");
		const firstFacts = callSettlementFromMessage(first, "none");
		strictEqual(firstFacts.usage?.input.kind, "unknown", "the call's usage had not arrived when it settled");
		strictEqual(firstFacts.billing, undefined);
		const call = first.content.find((block) => block.type === "toolCall");
		ok(call && call.type === "toolCall");
		const second = await step({ ...context, messages: [...context.messages, first, toolResult(call.id, "r")] }, key);
		strictEqual(second.stopReason, "stop");
		const facts = callSettlementFromMessage(second, "none");
		if (prompt === "op:late-usage") {
			// The late report names its call; only the successor's own report counts.
			deepStrictEqual(facts.usage?.input, { kind: "measured", value: 30, source: "provider" });
			deepStrictEqual(facts.usage?.output, { kind: "measured", value: 5, source: "provider" });
			deepStrictEqual(facts.billing?.modelCalls, { kind: "measured", value: 1, source: "local-count" });
		} else {
			// No verified common id: no call id at all, message and usage ids from different namespaces, or an
			// id-less tool request followed by a tagged report. The late report is placed nowhere and the
			// successor's counts are unknown, never 90 and 15 over two calls.
			strictEqual(facts.usage?.input.kind, "unknown");
			strictEqual(facts.usage?.output.kind, "unknown");
			strictEqual(facts.billing?.premiumRequests.kind, "unknown");
		}
		disposeCopilotConversations(key);
	}
});

test("a call that only reasoned still owes its usage, so its late report lands on no step", async () => {
	const key = "reasoning-session";
	const first = await step({ messages: [user("op:reasoning-only")] }, key);
	strictEqual(first.stopReason, "stop");
	deepStrictEqual(first.content, [{ type: "thinking", thinking: "thinking" }]);
	const second = await step({ messages: [user("op:reasoning-only"), first, user("op:after-reasoning")] }, key);
	strictEqual(second.stopReason, "stop");
	const facts = callSettlementFromMessage(second, "none");
	strictEqual(facts.usage?.input.kind, "unknown", "not 90 over two calls");
	strictEqual(facts.usage?.output.kind, "unknown");
	strictEqual(facts.billing?.premiumRequests.kind, "unknown");
	disposeCopilotConversations(key);
});

test("a lost runtime or a closed conversation settles the open step, and the client restarts", async () => {
	const hangSends = fake().order.filter((entry) => entry.startsWith("send ")).length;
	const pending = step({ messages: [user("op:hang")] }, "hang-session");
	while (fake().order.filter((entry) => entry.startsWith("send ")).length === hangSends)
		await new Promise((resolve) => setImmediate(resolve));
	disposeCopilotConversations("hang-session");
	const closed = await settledWithinTurns(pending);
	ok(closed !== "pending", "disposal settles the open step");
	strictEqual(closed.stopReason, "error");
	match(closed.errorMessage ?? "", /Clio session ended/);

	const clientsBefore = fake().instances.length;
	const sendsBefore = fake().order.filter((entry) => entry.startsWith("send ")).length;
	const dropping = step({ messages: [user("op:drop")] }, "drop-session");
	// Wait for the event that matters, the prompt reaching the runtime, then for the drop that follows it.
	while (fake().order.filter((entry) => entry.startsWith("send ")).length === sendsBefore)
		await new Promise((resolve) => setImmediate(resolve));
	const dropped = await settledWithinTurns(dropping);
	ok(dropped !== "pending", "a runtime exit settles the open step");
	strictEqual(dropped.stopReason, "error");
	match(dropped.errorMessage ?? "", /runtime exited/);
	// The next use starts a fresh runtime instead of reusing the disconnected client. This client is built
	// without the pinned private fields, which must be reported once rather than skipped silently.
	fake().omitInternals = true;
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on("warning", onWarning);
	try {
		const answered = await step({ messages: [user("hello")] }, "drop-session");
		strictEqual(answered.stopReason, "stop");
		strictEqual(fake().instances.length, clientsBefore + 1);
		await step({ messages: [user("hello")] }, "drop-session-2");
		await new Promise((resolve) => setImmediate(resolve));
		const layout = warnings.filter((warning) => (warning as { code?: string }).code === "CLIO_CODER_COPILOT_SDK_LAYOUT");
		strictEqual(layout.length, 1);
		match(layout[0]?.message ?? "", /cliProcess/);
	} finally {
		process.off("warning", onWarning);
		fake().omitInternals = false;
		disposeCopilotConversations("drop-session");
		disposeCopilotConversations("drop-session-2");
		// Retire the client built without the private layout, so later tests run on a normal one again.
		const layoutless = fake().instances.at(-1) as { state: string };
		layoutless.state = "disconnected";
	}
});

test("cancelling while Copilot creates the session sends nothing and disposes the new session", async () => {
	let open: () => void = () => {};
	fake().createGate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const creatingBefore = fake().creating;
	const sessionsBefore = fake().sessions.length;
	const controller = new AbortController();
	const pending = step({ messages: [user("hello")] }, "cancel-session", controller.signal);
	while (fake().creating === creatingBefore) await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const settled = await settledWithinTurns(pending);
	ok(settled !== "pending", "the abort settles the step while creation is still pending");
	strictEqual(settled.stopReason, "aborted");
	fake().createGate = null;
	open();
	// The earlier test's session also received "hello"; wait for this step's own session and its disposal.
	ok(
		await eventually(
			() =>
				fake().sessions.length > sessionsBefore &&
				fake().disconnected.includes(fake().sessions[sessionsBefore]?.sessionId ?? ""),
		),
		"the session created after the cancel is disposed",
	);
	const created = fake().sessions[sessionsBefore];
	ok(created);
	deepStrictEqual(created.prompts, [], "nothing is sent after the cancel");
	ok(fake().disconnected.includes(created.sessionId), "the session created after the cancel is disposed");
});

test("a createSession that never answers releases the runtime hold as soon as the step is cancelled", async () => {
	// Holds are counted process-wide; an earlier test's session disposal may still hold the runtime.
	ok(await eventually(() => fake().referenced === false), "no earlier hold remains before this step");
	fake().createGate = new Promise<void>(() => {
		// Never resolves: the runtime never answers session.create.
	});
	try {
		const creatingBefore = fake().creating;
		const controller = new AbortController();
		const pending = step({ messages: [user("hello")] }, "never-session", controller.signal);
		while (fake().creating === creatingBefore) await new Promise((resolve) => setImmediate(resolve));
		strictEqual(fake().referenced, true, "the runtime is held while the session is being created");
		controller.abort();
		const settled = await settledWithinTurns(pending);
		ok(settled !== "pending");
		strictEqual(settled.stopReason, "aborted");
		// createSession never answers, so only the cancel can release the hold.
		ok(await eventually(() => fake().referenced === false), "no hold outlives the cancelled step");
	} finally {
		fake().createGate = null;
	}
});

test("billing boundaries are per quantity, and a gap is attributed to no call", async () => {
	const key = "billing-session";
	const messages: Context["messages"] = [];
	const turn = async (text: string) => {
		messages.push(user(text));
		const answer = await step({ messages: [...messages] }, key);
		messages.push(answer);
		return callSettlementFromMessage(answer, "none").billing;
	};
	const measured = (value: number) => ({ kind: "measured", value, source: "provider" });
	deepStrictEqual((await turn("a"))?.premiumRequests, measured(1));
	const failed = await turn("op:metrics-fail-once b");
	strictEqual(failed?.premiumRequests.kind, "unknown");
	deepStrictEqual(failed?.nanoAiu, measured(100), "the step's own complete credit reports stand");
	strictEqual((await turn("c"))?.premiumRequests.kind, "unknown", "the boundary is reacquired, not spanned");
	deepStrictEqual((await turn("d"))?.premiumRequests, measured(1));
	strictEqual((await turn("op:slow-metrics e"))?.premiumRequests.kind, "unknown");
	strictEqual((await turn("f"))?.premiumRequests.kind, "unknown");
	await new Promise((resolve) => setTimeout(resolve, 600));
	// The late answer for e arrived after f's reading; it must not have moved f's boundary.
	deepStrictEqual((await turn("g"))?.premiumRequests, measured(1));
	disposeCopilotConversations(key);
});

test("an interrupted call keeps the positive counts its provider reported", async () => {
	const hook = globalThis as { __clioCopilotUsageReported?: () => void };
	const reported = new Promise<void>((resolve) => {
		hook.__clioCopilotUsageReported = resolve;
	});
	const controller = new AbortController();
	const pending = step({ messages: [user("op:usage-wait")] }, "interrupt-session", controller.signal);
	// Interrupt once the provider's report has been delivered, not after a guessed delay: under load a fixed
	// sleep can fire before the session exists, and an interrupt with no report is rightly unmeasured.
	const first = await Promise.race([reported.then(() => "reported"), pending.then(() => "settled")]);
	delete hook.__clioCopilotUsageReported;
	strictEqual(first, "reported", "the provider reported usage while the call was still open");
	controller.abort();
	const interrupted = await pending;
	strictEqual(interrupted.stopReason, "aborted");
	const facts = callSettlementFromMessage(interrupted, "none");
	deepStrictEqual(facts.usage?.input, { kind: "measured", value: 100, source: "provider" });
	deepStrictEqual(facts.usage?.output, { kind: "measured", value: 10, source: "provider" });
	strictEqual(facts.usage?.cacheRead.kind, "unknown", "a reported zero on an interrupted call is not a measurement");
	strictEqual(facts.usage?.cacheWrite.kind, "unknown", "an omitted count stays unknown");
	strictEqual(facts.interruptedEstimate, undefined, "measured counts are not replaced by an estimate");
	disposeCopilotConversations("interrupt-session");
});

test("session state containment is physical: no symlink leads a write or a cleanup out", async () => {
	const victim = join(env.dir, "victim");
	mkdirSync(join(victim, "kept-session"), { recursive: true });
	writeFileSync(join(victim, "kept-session", "precious.txt"), "precious");
	writeFileSync(join(victim, "secret.txt"), "secret");
	const stateBase = copilotSessionFsConfig().sessionStatePath;
	const sessions = join(resolveClioDirs().cache, "copilot-sdk", "sessions");
	mkdirSync(sessions, { recursive: true });
	const parked = `${sessions}.parked`;
	renameSync(sessions, parked);
	try {
		// A planted link where the sessions directory should be.
		symlinkSync(victim, sessions);
		const fs = createCopilotSessionFs("linked-session");
		await rejects(fs.appendFile(join(stateBase, "events.jsonl"), "{}"), /symlinked/);
		await rejects(fs.mkdir(stateBase, true), /symlinked/);
		strictEqual(existsSync(join(victim, "linked-session")), false);
		await removeCopilotSessionRecords("kept-session");
		removeCopilotSessionRecordsSync("kept-session");
		strictEqual(readFileSync(join(victim, "kept-session", "precious.txt"), "utf8"), "precious");
		unlinkSync(sessions);

		// A planted link as a state entry inside a real session directory.
		mkdirSync(join(sessions, "entry-session"), { recursive: true });
		symlinkSync(join(victim, "secret.txt"), join(sessions, "entry-session", "events.jsonl"));
		const entryFs = createCopilotSessionFs("entry-session");
		await rejects(entryFs.appendFile(join(stateBase, "events.jsonl"), "{}"), /symlinked/);
		await rejects(entryFs.writeFile(join(stateBase, "events.jsonl"), "{}"), /symlinked/);
		await rejects(entryFs.readFile(join(stateBase, "events.jsonl")), /symlinked/);
		await entryFs.rm(join(stateBase, "events.jsonl"), false, false);
		strictEqual(readFileSync(join(victim, "secret.txt"), "utf8"), "secret");
		// A link as the session directory itself: cleanup removes the link, never what it points at.
		symlinkSync(join(victim, "kept-session"), join(sessions, "alias-session"));
		await removeCopilotSessionRecords("alias-session");
		strictEqual(existsSync(join(sessions, "alias-session")), false);
		strictEqual(readFileSync(join(victim, "kept-session", "precious.txt"), "utf8"), "precious");

		// Identity anchoring: a session directory swapped for another real directory after first use, or reached
		// through a replaced ancestor, is no longer the one first resolved; mutation and cleanup both refuse it.
		const swapFs = createCopilotSessionFs("swap-session");
		await swapFs.appendFile(join(stateBase, "events.jsonl"), "{}");
		renameSync(join(sessions, "swap-session"), join(env.dir, "swap-original"));
		mkdirSync(join(sessions, "swap-session"));
		writeFileSync(join(sessions, "swap-session", "planted.txt"), "planted");
		await rejects(swapFs.appendFile(join(stateBase, "events.jsonl"), "{}"), /no longer the one first resolved/);
		await rejects(swapFs.rm(join(stateBase, "planted.txt"), false, false), /no longer the one first resolved/);
		await rejects(removeCopilotSessionRecords("swap-session"), /no longer the one first resolved/);
		removeCopilotSessionRecordsSync("swap-session");
		strictEqual(readFileSync(join(sessions, "swap-session", "planted.txt"), "utf8"), "planted");

		const ancestorFs = createCopilotSessionFs("ancestor-session");
		await ancestorFs.appendFile(join(stateBase, "events.jsonl"), "{}");
		renameSync(sessions, join(env.dir, "sessions-original"));
		mkdirSync(join(sessions, "ancestor-session"), { recursive: true });
		await rejects(ancestorFs.writeFile(join(stateBase, "events.jsonl"), "{}"), /no longer the one first resolved/);
		await rejects(ancestorFs.mkdir(join(stateBase, "checkpoints"), true), /no longer the one first resolved/);
		strictEqual(readdirSync(join(sessions, "ancestor-session")).length, 0);

		// A session directory replaced before the operation: write, append and rename create no parent inside
		// the replacement; one that went missing is never recreated.
		const replacedFs = createCopilotSessionFs("replaced-session");
		await replacedFs.writeFile(join(stateBase, "first.txt"), "first");
		renameSync(join(sessions, "replaced-session"), join(env.dir, "replaced-original"));
		mkdirSync(join(sessions, "replaced-session"));
		await rejects(replacedFs.writeFile(join(stateBase, "w", "deep", "f.txt"), "x"), /no longer the one first resolved/);
		await rejects(replacedFs.appendFile(join(stateBase, "a", "deep", "f.txt"), "x"), /no longer the one first resolved/);
		await rejects(
			replacedFs.rename(join(stateBase, "first.txt"), join(stateBase, "r", "deep", "f.txt")),
			/no longer the one first resolved/,
		);
		deepStrictEqual(readdirSync(join(sessions, "replaced-session")), [], "no parent was created in the replacement");
		rmSync(join(sessions, "replaced-session"), { recursive: true });
		await rejects(replacedFs.writeFile(join(stateBase, "again.txt"), "x"), /no longer the one first resolved/);
		strictEqual(existsSync(join(sessions, "replaced-session")), false, "a missing anchored session is not recreated");
	} finally {
		rmSync(sessions, { recursive: true, force: true });
		renameSync(parked, sessions);
	}
});

test("the first step of a fresh conversation is measured from a boundary read before the first send", async () => {
	// The 2 s tool-use deadline runs on a mocked clock that is never advanced to it, so the step can only
	// complete because its usage and its tool request both arrived (usage first, as on the live runtime).
	mock.timers.enable({ apis: ["setTimeout"] });
	let first: AssistantMessage | "pending";
	try {
		const pending = step({ tools: [readTool], messages: [user("op:usage-first")] }, "fresh-session");
		first = "pending";
		for (let virtualMs = 0; virtualMs < 100 && first === "pending"; virtualMs += 1) {
			mock.timers.tick(1);
			first = await settledWithinTurns(pending, 5);
		}
		// Real I/O in the step can lag the turns above on a loaded host, so the fake runtime's zero-delay start
		// timer may only be scheduled now. Keep firing timers already due (tick(0) never moves the clock toward
		// the deadline) and bound the wait by real time, so only the deadline can time the step out.
		const until = Date.now() + 30_000;
		while (first === "pending" && Date.now() < until) {
			mock.timers.tick(0);
			first = await settledWithinTurns(pending, 50);
		}
	} finally {
		mock.timers.reset();
	}
	ok(first !== "pending", "the step completed without the deadline timer reaching its 2 s");
	strictEqual(first.stopReason, "toolUse");
	const facts = callSettlementFromMessage(first, "none");
	deepStrictEqual(facts.billing?.premiumRequests, { kind: "measured", value: 1, source: "provider" });
	deepStrictEqual(facts.usage?.input, { kind: "measured", value: 50, source: "provider" });
	const session = fake().sessions.at(-1);
	ok(session);
	const own = fake().order.filter((entry) => entry.endsWith(session.sessionId));
	deepStrictEqual(own.slice(0, 2), [`getMetrics ${session.sessionId}`, `send ${session.sessionId}`]);
	disposeCopilotConversations("fresh-session");

	// Without a readable starting boundary nothing is assumed: the first step's share is unknown.
	fake().failBaselineOnce = true;
	const unbounded = await step({ messages: [user("hello")] }, "unbounded-session");
	strictEqual(callSettlementFromMessage(unbounded, "none").billing?.premiumRequests.kind, "unknown");
	disposeCopilotConversations("unbounded-session");
});

// TC-1 QL1: at one seat the Copilot chat's own stream held the only slot, so every dispatch to a Copilot worker was refused.
test("a default copilot-sdk target admits workers beside the foreground turn, and a full one names the target's maxConcurrentRequests", async () => {
	const runtime = { id: "copilot-sdk", tier: "subscription" as const };
	strictEqual(
		endpointCapacityFor({ target: { id: "copilot", runtime: "copilot-sdk", maxConcurrentRequests: 1 }, runtime }, {})
			?.limit,
		1,
	);
	const capacity = endpointCapacityFor({ target: { id: "copilot", runtime: "copilot-sdk" }, runtime }, {});
	ok(capacity !== null && capacity.limit >= 3, "the foreground turn plus two workers fit by default");
	const controller = createCapacityAdmissionController({
		limits: () => ({ global: 8, nodes: { local: 8 }, endpoints: { [capacity.key]: capacity.limit } }),
	});
	const releaseForeground = registerForegroundStream(capacity.key);
	try {
		const admit = (assignmentId: string) =>
			controller.admit({ assignmentId, nodeId: "local", endpointKey: capacity.key });
		const workers = [];
		for (let index = 1; index < capacity.limit; index += 1) workers.push(await admit(`worker-${index}`));
		ok(workers.length >= 2);
		await rejects(admit("one-too-many"), (error: unknown) => {
			ok(error instanceof Error);
			match(error.message, /set maxConcurrentRequests on target 'copilot' above its default of \d+/u);
			return true;
		});
	} finally {
		releaseForeground();
		await controller.stop();
	}
});
