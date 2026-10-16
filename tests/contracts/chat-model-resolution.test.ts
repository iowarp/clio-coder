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
