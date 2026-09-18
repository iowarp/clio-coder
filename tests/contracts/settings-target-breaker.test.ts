import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { RouteBreakerView } from "../../src/domains/dispatch/contract.js";
import { targetRows } from "../../src/interactive/overlays/settings.js";

function settingsWithTargets() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "mini", runtime: "openai-compat", url: "http://mini:8080", defaultModel: "qwen" },
		{ id: "dragon", runtime: "openai-compat", url: "http://dragon:8080", defaultModel: "llama" },
	];
	return settings;
}

function route(overrides: Partial<RouteBreakerView>): RouteBreakerView {
	return {
		targetId: "mini",
		runtimeId: "openai-compat",
		wireModelId: "qwen",
		state: "open",
		remainingMs: 41_200,
		reason: "target-transient",
		consecutiveFailures: 1,
		...overrides,
	};
}

describe("settings targets rows show the in-session breaker", () => {
	it("renders an open route with its remaining time and a probing route by phrase", () => {
		const routes = [
			route({}),
			route({ wireModelId: "coder", state: "closed", remainingMs: 0, reason: "target-overloaded" }),
			route({ targetId: "dragon", wireModelId: "llama", state: "probing", remainingMs: 0 }),
		];
		const [mini, dragon] = targetRows(settingsWithTargets(), { getRouteBreakers: () => routes });
		strictEqual(mini?.targetConsole?.health.text, "○ open 42s");
		strictEqual(mini?.targetConsole?.health.tone, "unhealthy");
		strictEqual(
			mini?.help,
			"Last probe: never · Failure reason: none · Breaker: qwen open 42s after target-transient; coder 1 failure (target-overloaded)",
		);
		strictEqual(dragon?.targetConsole?.health.text, "◐ probing");
		strictEqual(dragon?.help?.endsWith("Breaker: llama probing after target-transient"), true);
	});

	it("keeps probe health when no route on the target carries breaker state", () => {
		const [mini] = targetRows(settingsWithTargets(), { getRouteBreakers: () => [] });
		strictEqual(mini?.targetConsole?.health.text, "? unknown");
		strictEqual(mini?.help, "Last probe: never · Failure reason: none");
	});
});
