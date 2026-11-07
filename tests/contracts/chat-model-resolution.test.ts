import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES, resolveModelReference } from "../../src/domains/providers/index.js";

test("chat model resolution excludes worker runtimes and prefers the active eligible target (#416)", () => {
	const model = "claude-opus-5-5";
	function status(id: string, runtimeId: string, kind: RuntimeDescriptor["kind"]): TargetStatus {
		return {
			target: { id, runtime: runtimeId, wireModels: [model], defaultModel: model },
			runtime: {
				id: runtimeId,
				displayName: runtimeId,
				kind,
				apiFamily: kind === "http" ? "anthropic-messages" : "claude-agent-sdk",
				auth: "none",
				defaultCapabilities: EMPTY_CAPABILITIES,
				synthesizeModel() {
					throw new Error("resolver must not invoke a model");
				},
			},
			available: true,
			reason: "",
			health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: EMPTY_CAPABILITIES,
			discoveredModels: [],
		};
	}
	const worker = status("claude-sdk-worker", "claude-sdk", "sdk");
	const subscription = status("claude-sub", "anthropic-max", "http");
	const targets = [worker, subscription];
	const providers = { list: () => targets } as unknown as ProvidersContract;
	const expected = { target: subscription.target.id, model };
	strictEqual(resolveModelReference(model, providers).ref?.target, worker.target.id);
	deepStrictEqual(resolveModelReference(model, providers, { use: "chat" }), { ref: expected });
	deepStrictEqual(resolveModelReference(model, providers, { use: "chat", preferTarget: worker.target.id }), {
		ref: expected,
	});
	for (const pattern of ["claude-opus*", "opus-5-5", "claude-sub/claude-opus-5-5"]) {
		deepStrictEqual(resolveModelReference(pattern, providers, { use: "chat" }), { ref: expected });
	}

	const active = status("active-sub", "anthropic-max", "http");
	targets.push(active);
	strictEqual(resolveModelReference(model, providers, { use: "chat" }).ref?.target, subscription.target.id);
	const preferred = resolveModelReference(`${model}:high`, providers, { use: "chat", preferTarget: active.target.id });
	deepStrictEqual(preferred.ref, { target: active.target.id, model, thinkingLevel: "high" });
	match(preferred.warning ?? "", /active-sub\/claude-opus-5-5 and claude-sub\/claude-opus-5-5; using active-sub/u);

	subscription.target.wireModels = [`${model}-extended`];
	subscription.target.defaultModel = `${model}-extended`;
	targets.splice(2);
	const exactWorker = resolveModelReference(model, providers, { use: "chat" });
	strictEqual(exactWorker.ref, null);
	match(exactWorker.error ?? "", /target claude-sdk-worker.*chat needs a loaded HTTP runtime/u);
	deepStrictEqual(resolveModelReference(`${model}*`, providers, { use: "chat" }).ref, {
		target: subscription.target.id,
		model: `${model}-extended`,
	});

	subscription.target.wireModels = [model];
	subscription.target.defaultModel = model;
	subscription.target.capabilities = { chat: false };
	strictEqual(resolveModelReference(model, providers, { use: "chat" }).ref, null);
	subscription.target.capabilities = { chat: true };
	targets.push(active, status("third-sub", "anthropic-max", "http"), status("fourth-sub", "anthropic-max", "http"));
	const crowded = resolveModelReference(model, providers, { use: "chat" });
	match(crowded.warning ?? "", /claude-sub\/.*active-sub\/.*third-sub\/.*and 1 more; using claude-sub/u);
	strictEqual(crowded.warning?.includes("fourth-sub/"), false);

	const missing = { ...status("missing-runtime", "missing", "http"), runtime: null };
	targets.splice(1, targets.length - 1, missing);
	const refused = resolveModelReference(model, providers, { use: "chat" });
	strictEqual(refused.ref, null);
	match(refused.error ?? "", /targets claude-sdk-worker, missing-runtime.*chat needs a loaded HTTP runtime/u);
	const explicitWorker = resolveModelReference(`claude-sdk-worker/${model}`, providers, { use: "chat" });
	strictEqual(explicitWorker.ref, null);
	match(explicitWorker.error ?? "", /target claude-sdk-worker.*chat needs a loaded HTTP runtime/u);
});

test("an id a Copilot target does not list resolves only when named on that target", () => {
	function status(id: string, runtimeId: string, servesUnlistedModels: boolean): TargetStatus {
		return {
			target: { id, runtime: runtimeId, defaultModel: "gpt-6-luna" },
			runtime: {
				id: runtimeId,
				displayName: runtimeId,
				kind: "http",
				apiFamily: runtimeId === "copilot-sdk" ? "copilot-sdk" : "openai-completions",
				auth: "none",
				...(servesUnlistedModels ? { servesUnlistedModels } : {}),
				defaultCapabilities: EMPTY_CAPABILITIES,
				synthesizeModel() {
					throw new Error("resolver must not invoke a model");
				},
			},
			available: true,
			reason: "",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: EMPTY_CAPABILITIES,
			discoveredModels: ["gpt-6-luna", "claude-haiku-5.5"],
			discoveredModelsSource: "probe",
		};
	}
	const copilot = status("cp", "copilot-sdk", true);
	const local = status("local", "openai-compat", false);
	const both = { list: () => [copilot, local] } as unknown as ProvidersContract;
	const onlyCopilot = { list: () => [copilot] } as unknown as ProvidersContract;
	const onlyLocal = { list: () => [local] } as unknown as ProvidersContract;

	const qualified = resolveModelReference("cp/gemini-3.8-flash:low", both, { use: "chat" });
	deepStrictEqual(qualified.ref, { target: "cp", model: "gemini-3.8-flash", thinkingLevel: "low" });
	match(qualified.warning ?? "", /cp does not list "gemini-3\.8-flash"; sending it as typed/u);
	deepStrictEqual(resolveModelReference("gemini-3.8-flash", onlyCopilot, { use: "chat" }).ref, {
		target: "cp",
		model: "gemini-3.8-flash",
	});

	const unscoped = resolveModelReference("gemini-3.8-flash", both, { use: "chat" });
	strictEqual(unscoped.ref, null);
	match(unscoped.error ?? "", /cp serves models it does not list, so name it on a target, as cp\/gemini-3\.8-flash/u);
	for (const providers of [onlyLocal, both]) {
		const refused = resolveModelReference("local/gemini-3.8-flash", providers, { use: "chat" });
		strictEqual(refused.ref, null);
		strictEqual(refused.error, 'no models match pattern "local/gemini-3.8-flash"');
	}
	strictEqual(resolveModelReference("gemini-*", onlyCopilot, { use: "chat" }).ref, null);
	deepStrictEqual(resolveModelReference("luna", onlyCopilot, { use: "chat" }), {
		ref: { target: "cp", model: "gpt-6-luna" },
	});
});
