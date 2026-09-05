import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { canonicalEndpointKey, foregroundStreamUsage } from "../../src/domains/providers/index.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { COMPACTION_SYSTEM_PROMPT } from "../../src/domains/session/compaction/compact.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { appendEntry, appendTurn, startSession } from "../../src/domains/session/manager.js";
import { ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
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
		faux.unregister();
		scratch.restore();
	});
	function fixture() {
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
		const response = { fail: false };
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
		faux.setResponses(
			Array.from({ length: 20 }, () => (context, options, _state, model) => {
				calls.push({
					model: model.id,
					baseUrl: model.baseUrl,
					systemPrompt: context.systemPrompt,
					user: JSON.stringify(context.messages),
					apiKey: options?.apiKey,
					headers: options?.headers,
					capacity: foregroundStreamUsage(),
				});
				return {
					role: "assistant",
					content: [{ type: "text", text: "fixture checkpoint" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: response.fail ? "error" : "stop",
					...(response.fail ? { errorMessage: "fixture stream error" } : {}),
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
		return {
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
			run: createProductionAutoCompact(session, () => settings, providers),
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
