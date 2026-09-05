import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { summarizeFailedCompactionUsage } from "../../src/domains/observability/compaction-usage.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import {
	appendOutOfTurnUsageRow,
	outOfTurnUsagePath,
	readOutOfTurnUsageRows,
} from "../../src/domains/observability/out-of-turn-usage.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { canonicalEndpointKey, foregroundStreamUsage } from "../../src/domains/providers/index.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { COMPACTION_SYSTEM_PROMPT } from "../../src/domains/session/compaction/compact.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { appendEntry, appendTurn, startSession } from "../../src/domains/session/manager.js";
import { ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { registerEngineApiProvider, registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { Usage } from "../../src/engine/types.js";
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("production compaction controls", () => {
	let scratch: IsolatedClioEnv;
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-compaction-controls-");
		faux = registerEngineFauxProvider({
			api: "compaction-fixture",
			models: [{ id: "chat" }, { id: "summary" }],
			tokensPerSecond: 0,
		});
	});
	afterEach(() => {
		// Replace any literal-usage transport with an owned registration, then
		// remove it. No fixture provider remains installed after this test.
		registerEngineFauxProvider({ api: "compaction-fixture" }).unregister();
		faux.unregister();
		scratch.restore();
	});
	function fixture(literalUsage = false) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "chat-target";
		settings.chat.model = "chat";
		const capabilities = {
			chat: true,
			tools: true,
			reasoning: false,
			vision: false,
			audio: false,
			embeddings: false,
			rerank: false,
			fim: false,
			contextWindow: 131072,
			maxTokens: 16384,
		};
		const runtime: RuntimeDescriptor = {
			id: "fixture",
			displayName: "Fixture",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: capabilities,
			synthesizeModel: (target, id) => {
				const model = faux.getModel(id);
				ok(model);
				ok(target.url);
				return { ...model, baseUrl: target.url };
			},
		};
		const statuses: TargetStatus[] = ["chat", "summary"].map((id) => ({
			target: {
				id: `${id}-target`,
				runtime: runtime.id,
				url: `https://${id}.invalid/v1`,
				defaultModel: id,
				auth: { headers: { "x-route": id } },
			},
			runtime,
			available: true,
			reason: "fixture",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities,
			discoveredModels: [id],
			discoveredModelsSource: "probe",
			probeCapabilities: null,
		}));
		const authTargets: string[] = [];
		const auth = { available: true };
		const response: {
			fail: boolean;
			failAt: number;
			text: string;
			usage?: Usage;
			partialUsage?: Usage;
			abort?: boolean;
			beforeReturn?: () => void;
		} = {
			fail: false,
			failAt: 0,
			text: "fixture checkpoint",
		};
		const providers = {
			list: () => statuses,
			getTarget: (id: string) => statuses.find((s) => s.target.id === id)?.target ?? null,
			getRuntime: () => runtime,
			getDetectedReasoning: () => null,
			auth: {
				resolveForTarget: async (target: { id: string }) => {
					authTargets.push(target.id);
					return { available: auth.available, apiKey: `${target.id}-key` };
				},
			},
		} as unknown as ProvidersContract;
		const state = startSession({ cwd: scratch.dir, target: settings.chat.target, model: settings.chat.model });
		let leaf: string | null = null;
		function addHistory(label = "history") {
			for (let i = 0; i < 6; i++)
				leaf = appendTurn(state, {
					parentId: leaf,
					kind: "user",
					payload: { text: `${label}-${i} ${"x".repeat(24000)}` },
				}).id;
		}
		addHistory();
		const session = {
			current: () => state.meta,
			tree: () => ({ leafId: leaf }),
			appendEntry: (entry: Parameters<typeof appendEntry>[1]) => appendEntry(state, entry),
		} as unknown as SessionContract;
		const calls: Array<{
			model: string;
			baseUrl: string;
			systemPrompt: string | undefined;
			user: string;
			apiKey: string | undefined;
			headers: unknown;
			capacity: Readonly<Record<string, number>>;
		}> = [];
		const respond: FauxResponseFactory = (context, options, _state, model) => {
			calls.push({
				model: model.id,
				baseUrl: model.baseUrl,
				systemPrompt: context.systemPrompt,
				user: JSON.stringify(context.messages),
				apiKey: options?.apiKey,
				headers: options?.headers,
				capacity: foregroundStreamUsage(),
			});
			response.beforeReturn?.();
			return {
				role: "assistant",
				content: [{ type: "text", text: response.text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: response.abort ? "aborted" : response.fail || response.failAt === calls.length ? "error" : "stop",
				...(response.fail || response.failAt === calls.length ? { errorMessage: "fixture stream error" } : {}),
				timestamp: Date.now(),
				usage: response.usage ?? {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		};
		faux.setResponses(Array.from({ length: 20 }, () => respond));
		if (literalUsage) {
			// Faux normally estimates and overwrites usage. This scripted stream
			// preserves the supplied wire facts, including missing/zero fields.
			const stream: Parameters<typeof registerEngineApiProvider>[0]["stream"] = (model, context, options) => {
				const events = createAssistantMessageEventStream();
				void Promise.resolve(respond(context, options, faux.state, model)).then((message) => {
					if (response.partialUsage) events.push({ type: "start", partial: { ...message, usage: response.partialUsage } });
					if (message.stopReason === "error" || message.stopReason === "aborted")
						events.push({ type: "error", reason: message.stopReason, error: message });
					else events.push({ type: "done", reason: "stop", message });
					events.end(message);
				});
				return events;
			};
			registerEngineApiProvider({ api: faux.api, stream, streamSimple: stream });
		}
		const liveUsage: unknown[][] = [];
		return {
			session,
			liveUsage,
			settings,
			auth,
			response,
			providers,
			statuses,
			runtime,
			authTargets,
			calls,
			state,
			addHistory,
			pinLeaf: (id: string | null) => {
				leaf = id;
			},
			entries: () => {
				const reader = openSession(state.meta.id);
				return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
			},
			run: createProductionAutoCompact(session, () => settings, providers, {
				recordTokens: (...args) => liveUsage.push(args),
			}),
		};
	}
	it("routes a configured dedicated summary model through the production callback", async () => {
		const f = fixture();
		f.settings.context.compaction.model = "summary-target/summary";
		await f.run();
		ok(f.calls.length > 0);
		strictEqual(f.calls[0]?.model, "summary");
		strictEqual(f.calls[0]?.baseUrl, "https://summary.invalid/v1");
		strictEqual(f.calls[0]?.apiKey, "summary-target-key");
		deepStrictEqual(f.calls[0]?.headers, { "x-route": "summary" });
		deepStrictEqual(f.authTargets, ["summary-target"]);
		const target = f.statuses[1]?.target;
		ok(target);
		const key = canonicalEndpointKey(target);
		ok(key);
		strictEqual(f.calls[0]?.capacity[key], 1);
		strictEqual(foregroundStreamUsage()[key] ?? 0, 0);
		const usage = ledgerUsageCalls(f.entries(), { target: "chat-target", model: "chat" });
		strictEqual(usage.length, 1);
		strictEqual(usage[0]?.providerId, "summary-target");
		strictEqual(usage[0]?.requestedModelId, "summary");
		strictEqual(usage[0]?.attributedModelId, "summary");
		deepStrictEqual(usage[0]?.responseModelIdObservation, { state: "not-observed" });
		strictEqual(usage[0]?.apiCalls, f.calls.length);
		const persisted = f.entries().find((entry) => entry.kind === "compactionSummary");
		ok(persisted?.kind === "compactionSummary");
		strictEqual(persisted.usage?.targetId, "summary-target");
		strictEqual(persisted.usage?.modelId, "summary");
	});
	it("reads the configured system prompt at call time, separate from focus", async () => {
		const f = fixture();
		f.settings.context.compaction.systemPrompt = "summary.md";
		writeFileSync(join(scratch.dir, "summary.md"), "custom summary rules");
		await f.run("retain exact paths");
		strictEqual(f.calls[0]?.systemPrompt, "custom summary rules");
		match(f.calls[0]?.user ?? "", /Additional focus: retain exact paths/);
		const count = f.calls.length;
		writeFileSync(join(scratch.dir, "summary.md"), "changed summary rules");
		f.addHistory("new-history");
		await f.run("retain task state");
		strictEqual(f.calls[count]?.systemPrompt, "changed summary rules");
		match(f.calls[count]?.user ?? "", /fixture checkpoint/);
		match(f.calls[count]?.user ?? "", /history-5/);
		match(f.calls[count]?.user ?? "", /new-history-0/);
		match(f.calls[count]?.user ?? "", /Additional focus: retain task state/);
		doesNotMatch(f.calls[count]?.user ?? "", /\[User\]: history-0 /);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 2);
	});
	it("retains the builtin prompt and active chat route when controls are unset", async () => {
		const f = fixture();
		await f.run();
		strictEqual(f.calls[0]?.model, "chat");
		strictEqual(f.calls[0]?.systemPrompt, COMPACTION_SYSTEM_PROMPT);
		f.settings.chat.target = "summary-target";
		f.settings.chat.model = "summary";
		f.addHistory();
		const count = f.calls.length;
		await f.run();
		strictEqual(f.calls[count]?.model, "summary");
	});
	it("fails explicitly on a configured unknown model", async () => {
		const f = fixture();
		f.settings.context.compaction.model = "missing";
		await rejects(f.run(), /context.compaction.model/);
		strictEqual(f.calls.length, 0);
	});
	for (const pattern of [" ", "*", "[z-a]", "summary-target/missing", "missing\u001b[31m"]) {
		it(`rejects invalid or ambiguous model pattern ${JSON.stringify(pattern)} before auth or inference`, async () => {
			const f = fixture();
			f.settings.context.compaction.model = pattern;
			await rejects(f.run(), (error: Error) => {
				match(error.message, /context.compaction.model/);
				strictEqual(error.message.includes("\u001b"), false);
				return true;
			});
			strictEqual(f.calls.length, 0);
			strictEqual(f.authTargets.length, 0);
		});
	}
	for (const invalid of ["unavailable", "external", "worker-only", "no-chat", "no-output", "auth"] as const) {
		it(`rejects a ${invalid} dedicated route`, async () => {
			const f = fixture();
			f.settings.context.compaction.model = "summary-target/summary";
			const status = f.statuses[1];
			ok(status);
			if (invalid === "unavailable") status.available = false;
			if (invalid === "external") f.runtime.kind = "subprocess";
			if (invalid === "worker-only") {
				f.runtime.id = "claude-sdk";
				f.runtime.kind = "sdk";
			}
			if (invalid === "no-chat") status.target.capabilities = { chat: false };
			if (invalid === "no-output") {
				status.target.capabilities = { maxTokens: 0 };
				const synthesize = f.runtime.synthesizeModel;
				f.runtime.synthesizeModel = (...args) => ({ ...synthesize(...args), maxTokens: 0 });
			}
			if (invalid === "auth") f.auth.available = false;
			await rejects(f.run(), /context.compaction.model/);
			strictEqual(f.calls.length, 0);
			strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		});
	}
	for (const invalid of ["missing", "empty", "oversized", "directory", "invalid-utf8", "empty-path"] as const) {
		it(`rejects a ${invalid} prompt override without exposing its contents`, async () => {
			const f = fixture();
			const path = join(scratch.dir, "private-prompt.md");
			f.settings.context.compaction.systemPrompt = invalid === "empty-path" ? " " : path;
			if (invalid === "empty") writeFileSync(path, " \n\t");
			if (invalid === "oversized") writeFileSync(path, `secret\u001b[31m${"x".repeat(65536)}`);
			if (invalid === "directory") mkdirSync(path);
			if (invalid === "invalid-utf8") writeFileSync(path, Buffer.from([0xff]));
			await rejects(f.run(), (error: Error) => {
				match(error.message, /context.compaction.systemPrompt/);
				ok(error.message.includes(JSON.stringify(f.settings.context.compaction.systemPrompt)));
				doesNotMatch(error.message, /secret/);
				strictEqual(error.message.includes("\u001b"), false);
				return true;
			});
			strictEqual(f.calls.length, 0);
			strictEqual(f.authTargets.length, 0);
		});
	}
	it("names the configured prompt path without terminal controls or directional formatting", async () => {
		const f = fixture();
		f.settings.context.compaction.systemPrompt = "missing\nprompt\u001b]0;renamed\u0007\u202e.md";
		await rejects(f.run(), (error: Error) => {
			doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
			ok(error.message.includes("missing\\nprompt\\u001b]0;renamed\\u0007\\u{202e}.md"));
			return true;
		});
		strictEqual(f.calls.length, 0);
		strictEqual(f.authTargets.length, 0);
	});
	it("bounds the displayed path when a configured filename is oversized", async () => {
		const f = fixture();
		f.settings.context.compaction.systemPrompt = `missing-${"x".repeat(4096)}`;
		await rejects(f.run(), (error: Error) => {
			match(error.message, /missing-/);
			ok(error.message.length < 1500);
			match(error.message, /\.\.\./);
			return true;
		});
		strictEqual(f.calls.length, 0);
	});
	it("accepts an absolute prompt at the byte limit and a non-tool local summarizer", async () => {
		const f = fixture();
		f.runtime.tier = "protocol";
		f.runtime.defaultCapabilities.tools = false;
		const path = join(scratch.dir, "absolute.md");
		const text = "a".repeat(65536);
		writeFileSync(path, text);
		f.settings.context.compaction.systemPrompt = path;
		await f.run();
		strictEqual(f.calls[0]?.systemPrompt, text);
		strictEqual(f.calls[0]?.apiKey, "clio-coder-local-target");
		strictEqual(f.authTargets.length, 0);
	});
	it("releases endpoint capacity on a stream error and persists no checkpoint", async () => {
		const f = fixture();
		f.response.fail = true;
		await rejects(f.run(), /fixture stream error/);
		deepStrictEqual(foregroundStreamUsage(), {});
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
	});
	it("retains reported failed single-stream usage under its originating session and selected route", async () => {
		const f = fixture(true);
		f.settings.context.compaction.model = "summary-target/summary";
		f.response.fail = true;
		await rejects(f.run(), /fixture stream error/);
		strictEqual(f.calls.length, 1);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		const read = readOutOfTurnUsageRows(clioStateDir());
		deepStrictEqual(read.errors, []);
		strictEqual(read.rows.length, 1);
		const row = read.rows[0];
		ok(row);
		strictEqual(row.label, "failed-compaction");
		strictEqual(row.callOutcome, "error");
		strictEqual(f.liveUsage.length, 1);
		deepStrictEqual(f.liveUsage[0]?.slice(0, 2), ["summary-target", "summary"]);
		strictEqual(row.sessionId, f.state.meta.id);
		strictEqual(row.repoIdentity, f.state.meta.cwdHash);
		strictEqual(row.target, "summary-target");
		strictEqual(row.attributedModelId, "summary");
		strictEqual(row.usage.input, 10);
		strictEqual(row.usage.output, 5);
		strictEqual(row.usage.totalTokens, 15);
		strictEqual(row.usage.costUsd, null);
		strictEqual(row.usage.cacheRead, null);
		strictEqual(row.usage.costProvenance, "unknown");
	});
	it("retains both calls when a split compaction's second stream fails", async () => {
		const f = fixture(true);
		f.settings.context.compaction.model = "summary-target/summary";
		const tail = appendTurn(f.state, {
			parentId: f.entries().at(-1)?.turnId ?? null,
			kind: "assistant",
			payload: { content: [{ type: "text", text: "tail".repeat(30000) }] },
		});
		f.pinLeaf(tail.id);
		f.response.failAt = 2;
		await rejects(f.run(), /fixture stream error/);
		strictEqual(f.calls.length, 2);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		const read = readOutOfTurnUsageRows(clioStateDir());
		deepStrictEqual(read.errors, []);
		strictEqual(read.rows.length, 2);
		deepStrictEqual(
			read.rows.map((row) => row.usage.totalTokens),
			[15, 15],
		);
		deepStrictEqual(
			read.rows.map((row) => row.callOutcome),
			["success", "error"],
		);
		const summary = summarizeFailedCompactionUsage(read.rows);
		strictEqual(summary.knownUsage.totalTokens, 30);
		strictEqual(summary.erroredKnownUsage.totalTokens, 15);
		strictEqual(summary.unobservedUsageCalls.costUsd, 2);
		strictEqual(f.liveUsage.length, 2);
		for (const row of read.rows) {
			strictEqual(row.target, "summary-target");
			strictEqual(row.sessionId, f.state.meta.id);
		}
	});
	it("keeps ambiguous zero failed usage null and reports it as unknown in the built CLI", async () => {
		const f = fixture(true);
		f.response.fail = true;
		f.response.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await rejects(f.run(), /fixture stream error/);
		const rows = readOutOfTurnUsageRows(clioStateDir()).rows;
		strictEqual(rows.length, 1);
		deepStrictEqual(rows[0]?.usage, {
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			reasoning: null,
			totalTokens: null,
			costUsd: null,
			costProvenance: "unknown",
		});
		strictEqual(f.liveUsage.length, 0);
		const result = spawnSync(
			process.execPath,
			[new URL("../../dist/cli/index.js", import.meta.url).pathname, "usage", "report", "--json", "--repo", scratch.dir],
			{ encoding: "utf8", env: process.env, timeout: 15000 },
		);
		strictEqual(result.status, 0, result.stderr);
		const facts = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const tokens = facts.find((fact) => fact.fact === "tokens");
		ok(tokens);
		strictEqual(tokens.totalTokens, null);
		strictEqual(tokens.costUsd, null);
		strictEqual(tokens.failedCompaction.erroredCalls, 1);
		strictEqual(tokens.failedCompaction.unobservedUsageCalls.totalTokens, 1);
		strictEqual(tokens.failedCompactionCalls, 1);
		strictEqual(tokens.handoffs, 0);
		const model = facts.find((fact) => fact.fact === "model-usage");
		strictEqual(model.totalTokens, null);
		strictEqual(model.costUsd, null);
	});
	it("retains positive partial-response usage when a terminal error supplies normalized zeros", async () => {
		const f = fixture(true);
		f.response.fail = true;
		f.response.partialUsage = { input: 12, totalTokens: 12, cost: { total: 0.1 } } as Usage;
		f.response.usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await rejects(f.run(), /fixture stream error/);
		const row = readOutOfTurnUsageRows(clioStateDir()).rows[0];
		ok(row);
		strictEqual(row.usage.input, 12);
		strictEqual(row.usage.totalTokens, 12);
		strictEqual(row.usage.costUsd, 0.1);
		strictEqual(row.usage.output, null);
	});
	it("keeps aborted-call usage distinct from the errored share", async () => {
		const f = fixture(true);
		f.response.abort = true;
		await rejects(f.run(), /compaction stream failed/);
		const rows = readOutOfTurnUsageRows(clioStateDir()).rows;
		strictEqual(rows[0]?.callOutcome, "aborted");
		const summary = summarizeFailedCompactionUsage(rows);
		strictEqual(summary.abortedCalls, 1);
		strictEqual(summary.erroredCalls, 0);
		strictEqual(summary.knownUsage.totalTokens, 15);
		strictEqual(summary.erroredKnownUsage.totalTokens, null);
	});
	it("preserves cost-only failed observations without inventing token totals", async () => {
		const f = fixture(true);
		f.response.fail = true;
		f.response.usage = { cost: { total: 0.25 } } as Usage;
		await rejects(f.run(), /fixture stream error/);
		const row = readOutOfTurnUsageRows(clioStateDir()).rows[0];
		ok(row);
		strictEqual(row.usage.costUsd, 0.25);
		strictEqual(row.usage.costProvenance, "estimated");
		strictEqual(row.usage.totalTokens, null);
		strictEqual(row.usage.input, null);
	});
	it("retains spending but refuses a checkpoint for an empty second split response", async () => {
		const f = fixture(true);
		const tail = appendTurn(f.state, {
			parentId: f.entries().at(-1)?.turnId ?? null,
			kind: "assistant",
			payload: { content: [{ type: "text", text: "tail".repeat(30000) }] },
		});
		f.pinLeaf(tail.id);
		f.response.beforeReturn = () => {
			if (f.calls.length === 2) f.response.text = "";
		};
		await rejects(f.run(), /empty.*summary|no summary/);
		strictEqual(f.calls.length, 2);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		deepStrictEqual(
			readOutOfTurnUsageRows(clioStateDir()).rows.map((row) => row.callOutcome),
			["success", "success"],
		);
	});
	it("keeps late spending on the originating session when the current session changes", async () => {
		const f = fixture(true);
		f.settings.context.compaction.model = "summary-target/summary";
		f.response.beforeReturn = () => {
			f.session.current = () => ({ ...f.state.meta, id: "successor" });
		};
		await rejects(f.run(), /session or branch changed/);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows[0]?.sessionId, f.state.meta.id);
		strictEqual(f.liveUsage.length, 0);
	});
	it("retains spending without a checkpoint when the selected branch changes", async () => {
		const f = fixture(true);
		f.response.beforeReturn = () => f.pinLeaf("different-leaf");
		await rejects(f.run(), /session or branch changed/);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows[0]?.sessionId, f.state.meta.id);
		strictEqual(f.liveUsage.length, 0);
	});
	it("surfaces a required usage-write failure without repeating the model call", async () => {
		const f = fixture(true);
		f.response.fail = true;
		mkdirSync(outOfTurnUsagePath(clioStateDir()), { recursive: true });
		await rejects(f.run(), (error: unknown) => {
			ok(error instanceof AggregateError);
			match(error.message, /usage could not be fully recorded/);
			match(String(error.errors[0]), /fixture stream error/);
			match(String(error.errors[1]), /usage row not written/);
			return true;
		});
		strictEqual(f.calls.length, 1);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
	});
	it("keeps historical numeric out-of-turn rows readable and unchanged beside new nullable rows", async () => {
		const f = fixture(true);
		const historical = {
			label: "side-question" as const,
			sessionId: f.state.meta.id,
			repoIdentity: f.state.meta.cwdHash,
			timestamp: new Date().toISOString(),
			target: "historical",
			attributedModelId: "historical-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 0,
				costUsd: 0,
				costProvenance: "known_free" as const,
			},
		};
		appendOutOfTurnUsageRow(clioStateDir(), historical);
		const before = readFileSync(outOfTurnUsagePath(clioStateDir()), "utf8");
		f.response.fail = true;
		await rejects(f.run(), /fixture stream error/);
		ok(readFileSync(outOfTurnUsagePath(clioStateDir()), "utf8").startsWith(before));
		deepStrictEqual(readOutOfTurnUsageRows(clioStateDir()).rows[0], historical);
	});
	it("preserves spending when checkpoint append provably wrote nothing", async () => {
		const f = fixture(true);
		f.session.appendEntry = () => {
			throw new Error("append refused");
		};
		await rejects(f.run(), /append refused/);
		strictEqual(f.entries().filter((entry) => entry.kind === "compactionSummary").length, 0);
		strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows.length, 1);
	});
	it("does not duplicate usage if checkpoint append wrote before throwing", async () => {
		const f = fixture(true);
		const append = f.session.appendEntry;
		f.session.appendEntry = (entry) => {
			append(entry);
			throw new Error("post-append failure");
		};
		await rejects(f.run(), /post-append failure/);
		strictEqual(ledgerUsageCalls(f.entries()).length, 1);
		strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows.length, 0);
	});
	it("reports ambiguous checkpoint persistence without a speculative second accounting write", async () => {
		const f = fixture(true);
		f.session.appendEntry = () => {
			appendFileSync(sessionPaths(f.state.meta).current, '{"kind":"compactionSummary"');
			throw new Error("partial append failure");
		};
		await rejects(f.run(), /checkpoint persistence is unresolved/);
		strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows.length, 0);
		match(readFileSync(sessionPaths(f.state.meta).current, "utf8"), /compactionSummary/);
	});
	for (const legacy of [false, true]) {
		it(`attributes successful live compaction accounting to ${legacy ? "legacy chat fallback" : "the selected summary route"}`, async () => {
			const f = fixture(true);
			if (!legacy) f.settings.context.compaction.model = "summary-target/summary";
			const recorded: unknown[][] = [];
			const context = createTurnContext({
				state: createTurnState("off"),
				getSettings: () => f.settings,
				providers: f.providers,
				readSessionEntries: f.entries,
				autoCompact: async () => {
					const result = await f.run();
					if (legacy && result?.usage) {
						delete result.usage.targetId;
						delete result.usage.modelId;
					}
					return result;
				},
				observability: { recordTokens: (...args: unknown[]) => recorded.push(args) } as unknown as ObservabilityContract,
				middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
				emitNotice: () => {},
			});
			const runtime = {
				targetId: "chat-target",
				runtimeId: "fixture",
				wireModelId: "chat",
				runtimeResolution: {
					costProvenance: "known_free",
					contextWindowDetails: {
						desiredContextWindow: 131072,
						effectiveContextWindow: 131072,
						contextWindowSource: "configured",
					},
				},
				agent: { state: { systemPrompt: "fixture", thinkingLevel: "off", messages: [], tools: [] } },
			} as unknown as AgentRuntime;
			strictEqual(await context.runAutoCompact(runtime, true), true);
			strictEqual(recorded.length, 1);
			deepStrictEqual(recorded[0]?.slice(0, 2), legacy ? ["chat-target", "chat"] : ["summary-target", "summary"]);
			strictEqual(recorded[0]?.[5], legacy ? "known_free" : "unknown");
			strictEqual(readOutOfTurnUsageRows(clioStateDir()).rows.length, 0);
		});
	}
	it("keeps successful compaction usage solely on its checkpoint", async () => {
		const f = fixture(true);
		await f.run();
		strictEqual(f.calls.length, 1);
		strictEqual(ledgerUsageCalls(f.entries()).length, 1);
		deepStrictEqual(readOutOfTurnUsageRows(clioStateDir()), { rows: [], errors: [] });
	});
	it("summarizes only the selected branch, including an earlier pinned leaf", async () => {
		const f = fixture();
		const originalLeaf = f.entries().at(-1)?.turnId;
		ok(originalLeaf);
		f.addHistory("abandoned");
		f.pinLeaf(originalLeaf);
		await f.run();
		doesNotMatch(f.calls.map((call) => call.user).join(""), /abandoned/);
		f.addHistory("active-sibling");
		const count = f.calls.length;
		await f.run();
		const secondPrompt = f.calls
			.slice(count)
			.map((call) => call.user)
			.join("");
		match(secondPrompt, /active-sibling/);
		match(secondPrompt, /fixture checkpoint/);
		doesNotMatch(secondPrompt, /abandoned/);
	});
	it("keeps legacy checkpoint usage attributed to its active chat route", async () => {
		const f = fixture();
		await f.run();
		const entries = f.entries();
		for (const entry of entries) {
			if (entry.kind !== "compactionSummary" || !entry.usage) continue;
			delete entry.usage.targetId;
			delete entry.usage.modelId;
		}
		f.state.writer.replaceEntries(entries);
		const usage = ledgerUsageCalls(f.entries(), { target: "legacy-target", model: "legacy-model" });
		strictEqual(usage[0]?.providerId, "legacy-target");
		strictEqual(usage[0]?.attributedModelId, "legacy-model");
		deepStrictEqual(usage[0]?.responseModelIdObservation, { state: "not-observed" });
	});
	it("sends the custom prompt and route through both split-turn streams", async () => {
		const f = fixture();
		f.settings.context.compaction.model = "summary-target/summary";
		const path = join(scratch.dir, "split.md");
		writeFileSync(path, "split summary instructions");
		f.settings.context.compaction.systemPrompt = path;
		const tail = appendTurn(f.state, {
			parentId: f.entries().at(-1)?.turnId ?? null,
			kind: "assistant",
			payload: { content: [{ type: "text", text: "tail".repeat(30000) }] },
		});
		f.pinLeaf(tail.id);
		const result = await f.run("focus stays in user message", "force");
		strictEqual(result?.isSplitTurn, true);
		strictEqual(f.calls.length, 2);
		for (const call of f.calls) {
			strictEqual(call.model, "summary");
			strictEqual(call.systemPrompt, "split summary instructions");
			match(call.user, /Additional focus: focus stays in user message/);
		}
		const usage = ledgerUsageCalls(f.entries());
		strictEqual(usage[0]?.apiCalls, 2);
		strictEqual(usage[0]?.providerId, "summary-target");
		const entry = f.entries().find((entry) => entry.kind === "compactionSummary");
		ok(entry?.kind === "compactionSummary");
		strictEqual(entry.trigger, "force");
	});
});
