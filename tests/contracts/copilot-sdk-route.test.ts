import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { isCopilotRefusal } from "../../src/core/copilot-refusal.js";
import { resolveClioDirs } from "../../src/core/xdg.js";
import { classifyFailure } from "../../src/domains/dispatch/failure-classification.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import { hasCopilotConsent, recordCopilotConsent } from "../../src/domains/providers/copilot-consent.js";
import { endpointCapacityFor } from "../../src/domains/providers/endpoint-capacity.js";
import { isRetryableErrorMessage } from "../../src/domains/session/retry.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { normalizeContext } from "../../src/engine/context.js";
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
const state = (globalThis.__clioCopilotFake ??= {
	clients: [], sessions: [], deleted: [], disconnected: [], toolResults: [], rejected: [],
	auth: { isAuthenticated: true, login: "octo", host: "https://github.com" },
	models: [
		{ id: "fake-model", name: "Fake Model", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64000 } }, policy: { state: "enabled", terms: "" } },
		{ id: "unconfigured-model", name: "Needs Enabling", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64000 } }, policy: { state: "unconfigured", terms: "" } },
	],
});
class FakeSession {
	constructor(config, index) {
		this.config = config;
		this.sessionId = config.sessionId ?? "copilot-" + index;
		this.handlers = new Set();
		this.tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
		this.prompts = [];
		// The runtime's own session accounting, which usage.getMetrics() reads back.
		this.metrics = { totalPremiumRequestCost: 0, totalNanoAiu: 0 };
		this.metricsFail = false;
		this.rpc = { usage: { getMetrics: async () => {
			if (this.metricsFail) throw new Error("metrics unavailable");
			return { ...this.metrics, totalUserRequests: 0, totalApiDurationMs: 0, sessionStartTime: "", lastCallInputTokens: 0, lastCallOutputTokens: 0, modelMetrics: {}, codeChanges: {} };
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
	async send(options) { this.prompts.push(options.prompt); setTimeout(() => void this.run(options.prompt), 0); return "m"; }
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
		if (prompt.includes("use tool")) {
			const result = await this.callTool("call_1");
			if (!result) return;
			state.toolResults.push(result);
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
			this.usage({ model: "fake-model", inputTokens: 20, outputTokens: 2, cost: 1 });
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
	}
	async start() {}
	async stop() { return []; }
	async getAuthStatus() { return state.auth; }
	async listModels() { return state.models; }
	async deleteSession(id) { state.deleted.push(id); }
	async createSession(config) {
		if (this.options.mode === "empty" && config.availableTools === undefined)
			throw new Error("CopilotClient is in mode: 'empty' but the session config did not specify 'availableTools'.");
		const session = new FakeSession(config, state.sessions.length + 1);
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
	toolResults: Array<{ textResultForLlm: string; resultType: string }>;
	rejected: string[];
	auth: { isAuthenticated: boolean; login?: string; host?: string };
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

async function step(context: Context, sessionId = "route-session"): Promise<AssistantMessage> {
	return engineStreamSimple(model, normalizeContext(context), { sessionId }).result();
}

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
		"src/domains/providers/copilot-consent.ts",
		"src/domains/providers/copilot-setup.ts",
		"src/domains/lifecycle/copilot-sdk-install.ts",
	];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const pattern of banned) strictEqual(pattern.test(source), false, `${file} matches ${pattern}`);
	}
});

test("consent gates the first Copilot call and names how to give it", async () => {
	strictEqual(hasCopilotConsent({ login: "octo", host: "https://github.com" }), false);
	const refused = await step({ messages: [user("hello")] });
	strictEqual(refused.stopReason, "error");
	match(refused.errorMessage ?? "", /clio-coder auth login copilot-sdk/);
	strictEqual(fake().sessions.length, 0, "no Copilot session is opened before consent");
	recordCopilotConsent({ login: "octo", host: "https://github.com" });
	const answered = await step({ messages: [user("hello")] });
	strictEqual(answered.stopReason, "stop");
	deepStrictEqual(answered.content, [{ type: "text", text: "hello" }]);
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
	const consent = JSON.parse(readFileSync(join(resolveClioDirs().state, "copilot-sdk-consent.json"), "utf8"));
	deepStrictEqual(Object.keys(consent.accounts[0]).sort(), ["acceptedAt", "host", "login"]);
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
	// The registry's framed note reaches Copilot exactly as Clio wrote it; later user text keeps a frame of its own.
	strictEqual(
		fake().toolResults.at(-1)?.textResultForLlm,
		`file body${HOST_NOTE}\n\n<system-reminder>host note</system-reminder>\n\n<user-message>\noperator steer\n</user-message>`,
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
	await new Promise((resolve) => setTimeout(resolve, 20));
	strictEqual(existsSync(records), false);
	ok(fake().rejected.some((reason) => /Clio session ended/.test(reason)));
	ok(fake().disconnected.includes(session.sessionId));
});

test("sessionFs keeps session state in Clio's cache and serves the workspace read-only at its real paths", async () => {
	const config = fake().clients[0]?.sessionFs as { initialCwd: string; sessionStatePath: string };
	strictEqual(config.initialCwd, process.cwd());
	const session = fake().sessions.at(-1) as FakeSession & {
		fs: {
			stat(path: string): Promise<{ isFile: boolean }>;
			readFile(path: string): Promise<string>;
			writeFile(path: string, content: string): Promise<void>;
			mkdir(path: string, recursive: boolean): Promise<void>;
			rm(path: string, recursive: boolean, force: boolean): Promise<void>;
		};
	};
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

test("a copilot-sdk target admits one request at a time unless its capacity says more", () => {
	const runtime = { id: "copilot-sdk", tier: "subscription" as const };
	strictEqual(endpointCapacityFor({ target: { id: "copilot", runtime: "copilot-sdk" }, runtime }, {})?.limit, 1);
	strictEqual(
		endpointCapacityFor({ target: { id: "copilot", runtime: "copilot-sdk", maxConcurrentRequests: 3 }, runtime }, {})
			?.limit,
		3,
	);
});
