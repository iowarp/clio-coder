import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { prepareWorkerTargets } from "../../src/interactive/startup-background.js";

function fixture(startup = false) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "main";
	settings.fleet.default = { target: "worker", model: "model", thinkingLevel: "off" };
	settings.fleet.profiles = {};
	settings.fleet.rosters = {};
	const target = { id: "worker", runtime: "llamacpp", url: "http://127.0.0.1:9876/v1", cache: { warm: { startup } } };
	const status = {
		target,
		available: true,
		health: { lastCheckAt: null },
		runtime: { tier: "local-native", kind: "http", synthesizeModel: () => ({ id: "model" }) },
	} as unknown as TargetStatus;
	let busy = false;
	const probes: string[] = [];
	let warms = 0;
	let recorded = 0;
	const controller = new AbortController();
	const providers = {
		list: () => [status],
		getTarget: (id: string) => (id === "worker" ? target : { id: "main", url: "http://127.0.0.1:9875/v1" }),
		probeTarget: async (id: string, options: { reasoning: boolean; tools: boolean }) => {
			deepStrictEqual([options.reasoning, options.tools], [false, false]);
			probes.push(id);
			return status;
		},
		auth: { resolveForTarget: async () => ({ apiKey: "local" }) },
	} as unknown as ProvidersContract;
	const input: Parameters<typeof prepareWorkerTargets>[0] = {
		settings,
		providers,
		signal: controller.signal,
		isBusy: () => busy,
		observe: async () => ({ warm: "bounded", endpoint: "http://127.0.0.1:9876" }) as never,
		warm: async (request) => {
			warms++;
			strictEqual(request.state.systemPrompt, "");
			deepStrictEqual(request.state.tools, []);
			strictEqual(request.maxInputTokens, 256);
			strictEqual(request.state.thinkingLevel, "off");
			return { aborted: false, errorMessage: null, usage: null, backend: null, timing: { apiMs: 1, ttftMs: 1 } };
		},
		recordWarm: () => {
			recorded++;
		},
	};
	return {
		input,
		target,
		status,
		probes,
		controller,
		counts: () => [warms, recorded],
		busy: () => {
			busy = true;
		},
	};
}

test("local worker connections warm silently without inference by default, once per endpoint", async () => {
	const f = fixture();
	f.input.settings.fleet.profiles.duplicate = { ...f.input.settings.fleet.default };
	await prepareWorkerTargets(f.input);
	deepStrictEqual(f.probes, ["worker"]);
	deepStrictEqual(f.counts(), [0, 0]);
});

test("opted-in resident local worker target gets one bounded round and records its result", async () => {
	const f = fixture(true);
	await prepareWorkerTargets(f.input);
	deepStrictEqual(f.counts(), [1, 1]);
});

test("cloud, remote-node, cancelled, and foreground work do not start background requests", async () => {
	for (const kind of ["cloud", "node", "cancel", "busy"]) {
		const f = fixture(true);
		if (kind === "cloud" && f.status.runtime) Object.assign(f.status.runtime, { tier: "cloud" });
		if (kind === "node") f.input.settings.fleet.default.node = "remote";
		if (kind === "cancel") f.controller.abort();
		if (kind === "busy") f.busy();
		await prepareWorkerTargets(f.input);
		deepStrictEqual(f.probes, [], kind);
		deepStrictEqual(f.counts(), [0, 0], kind);
	}
});

test("unsupported deployment and occupied endpoint never admit an inference warm", async () => {
	const f = fixture(true);
	f.input.observe = async () => ({ warm: "unsupported" }) as never;
	await prepareWorkerTargets(f.input);
	deepStrictEqual(f.counts(), [0, 0]);
	const g = fixture(true);
	const release = registerForegroundStream("http://127.0.0.1:9876");
	try {
		await prepareWorkerTargets(g.input);
		deepStrictEqual(g.counts(), [0, 0]);
	} finally {
		release();
	}
});

test("a turn or target change during preparation prevents the optional model call", async () => {
	for (const kind of ["busy", "changed"]) {
		const f = fixture(true);
		f.input.observe = async () => {
			if (kind === "busy") f.busy();
			else f.target.url = "http://127.0.0.1:9999/v1";
			return { warm: "bounded", endpoint: "http://127.0.0.1:9876" } as never;
		};
		await prepareWorkerTargets(f.input);
		deepStrictEqual(f.counts(), [0, 0], kind);
	}
});
