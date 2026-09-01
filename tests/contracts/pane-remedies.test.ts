import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandContext } from "../../src/interactive/slash-commands.js";

describe("contracts/pane refusal remedies", () => {
	it("names the canonical activation key when embedded mode is unavailable", async () => {
		const result = await detectMux({ enabled: "embedded", env: {} });
		strictEqual(result.detection.refused, true);
		strictEqual(
			result.detection.reason,
			"embedded mode is not implemented yet; it ships in phase 5, so this session has no panes at all. Set interface.panes.enabled=auto for guest mode inside a herdr session.",
		);
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
