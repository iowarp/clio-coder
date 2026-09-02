import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandContext } from "../../src/interactive/slash-commands.js";

describe("contracts/pane refusal remedies", () => {
	it("degrades embedded to guest detection instead of refusing every pane", async () => {
		const outside = await detectMux({ enabled: "embedded", env: {} });
		strictEqual(outside.detection.mode, "none");
		strictEqual(outside.detection.refused ?? false, false);
		strictEqual(outside.detection.reason, "HERDR_ENV is not 1, so Clio is not running inside a pane host");
	});

	it("names the canonical files-pane key when Yazi is disabled", async () => {
		const panes = createPanesRuntime({
			mux: { mode: "none" } as MuxContract,
			getSettings: () => DEFAULT_SETTINGS,
			getDispatchSnapshot: () => ({
				generatedAt: "2026-09-01T00:00:00.000Z",
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			getCwd: () => "/workspace",
		});

		deepStrictEqual(await panes.open({ preset: "yazi" }), {
			status: "refused",
			reason: "the files pane is disabled by interface.panes.files.enabled",
		});
	});

	it("names the canonical activation key when slash-command panes were not composed", () => {
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "panes");
		if (!entry) throw new Error("missing panes slash command");
		let notice = "";
		entry.handle({ kind: "panes" }, {
			notice: (_level, text) => {
				notice = text;
			},
		} as SlashCommandContext);
		strictEqual(
			notice,
			"panes are inactive: this session started without them. Restart with `clio-coder --with-panes`, or set interface.panes.enabled=auto",
		);
	});
});
