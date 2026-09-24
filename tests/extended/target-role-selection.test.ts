import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { it } from "node:test";
import { type ClioSettings, TargetUseRefusal, useTargetInSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS);
	value.targets = [
		{ id: "blade-gateway", runtime: "litellm", defaultModel: "dynamo/qwen3.8-27b" },
		{ id: "worker-node", runtime: "litellm", defaultModel: "worker/default" },
	];
	value.chat.target = "blade-gateway";
	value.chat.model = "dynamo/qwen3.8-27b";
	value.fleet.default = { target: "blade-gateway", model: "mini/ornith1.5-35b-moe-q4km", thinkingLevel: "low" };
	value.context.memory.target = "blade-gateway";
	value.context.memory.model = "zbook/ornith-1.5-35b-a3b";
	return value;
}

it("background selection preserves the entire chat and fleet configuration", () => {
	const value = settings();
	const before = structuredClone(value);
	useTargetInSettings(value, "blade-gateway", { backgroundModel: "zbook-lemonade/LFM2.5-8B-A1B" });
	deepStrictEqual(value.chat, before.chat);
	deepStrictEqual(value.fleet, before.fleet);
	deepStrictEqual(value.context.memory, {
		...before.context.memory,
		target: "blade-gateway",
		model: "zbook-lemonade/LFM2.5-8B-A1B",
	});
});

it("fleet and orchestrator flags change only their named roles", () => {
	for (const role of ["fleet", "chat"] as const) {
		const value = settings();
		const before = structuredClone(value);
		useTargetInSettings(
			value,
			"worker-node",
			role === "fleet" ? { workerModel: "selected" } : { orchestratorModel: "selected" },
		);
		deepStrictEqual(value.context, before.context);
		if (role === "fleet") {
			deepStrictEqual(value.chat, before.chat);
			deepStrictEqual(value.fleet.default, { ...before.fleet.default, target: "worker-node", model: "selected" });
		} else {
			deepStrictEqual(value.fleet, before.fleet);
			deepStrictEqual(value.chat, { ...before.chat, target: "worker-node", model: "selected" });
		}
	}
});

it("a fleet target flag selects only fleet, using that target's default model", () => {
	const value = settings();
	const before = structuredClone(value);
	useTargetInSettings(value, "blade-gateway", { workerTargetId: "worker-node" });
	deepStrictEqual(value.chat, before.chat);
	deepStrictEqual(value.context, before.context);
	deepStrictEqual(value.fleet.default, { ...before.fleet.default, target: "worker-node", model: "worker/default" });
});

it("multiple scoped flags leave unnamed roles untouched and refuse a shared model no named role uses", () => {
	const value = settings();
	const before = structuredClone(value);
	throws(
		() =>
			useTargetInSettings(value, "worker-node", { model: "shared", orchestratorModel: "main", backgroundModel: "memory" }),
		(error: unknown) =>
			error instanceof TargetUseRefusal &&
			/--model 'shared' would not be used/u.test(error.message) &&
			/--orchestrator-model 'shared'/u.test(error.message),
	);
	deepStrictEqual(value, before, "a refused call changes nothing");
	useTargetInSettings(value, "worker-node", { orchestratorModel: "main", backgroundModel: "memory" });
	strictEqual(value.chat.model, "main");
	strictEqual(value.context.memory.model, "memory");
	deepStrictEqual(value.fleet, before.fleet);
});

it("a fleet-scoped call refuses --model that neither fleet nor chat would use", () => {
	const value = settings();
	const before = structuredClone(value);
	throws(
		() =>
			useTargetInSettings(value, "blade-gateway", {
				model: "chat-wanted",
				workerTargetId: "worker-node",
				workerModel: "fleet-model",
			}),
		TargetUseRefusal,
	);
	deepStrictEqual(value, before);
	// --fleet-target naming this same target with no --fleet-model does use --model.
	useTargetInSettings(value, "worker-node", { model: "shared", workerTargetId: "worker-node" });
	deepStrictEqual(value.fleet.default, { ...before.fleet.default, target: "worker-node", model: "shared" });
	deepStrictEqual(value.chat, before.chat);
});

it("no role flags preserve legacy chat and fleet selection without rewriting memory or thinking levels", () => {
	for (const options of [{}, { model: "shared" }]) {
		const value = settings();
		const before = structuredClone(value);
		useTargetInSettings(value, "worker-node", options);
		deepStrictEqual(value.chat, { ...before.chat, target: "worker-node", model: options.model ?? "worker/default" });
		deepStrictEqual(value.fleet.default, {
			...before.fleet.default,
			target: "worker-node",
			model: options.model ?? "worker/default",
		});
		deepStrictEqual(value.context, before.context);
	}
});

it("missing targets leave all role settings unchanged", () => {
	const value = settings();
	const before = structuredClone(value);
	strictEqual(useTargetInSettings(value, "missing"), null);
	strictEqual(useTargetInSettings(value, "blade-gateway", { workerTargetId: "missing" }), null);
	deepStrictEqual(value, before);
});
