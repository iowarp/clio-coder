import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sumFacts, sumPricing } from "../../src/core/telemetry/pricing.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { currentToolPlatform, findPinnedTool } from "../../src/domains/toolchain/index.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandContext } from "../../src/session-control/slash-commands.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/pane refusal remedies", () => {
	it("detects no pane host outside one, and no refusal", async () => {
		const outside = await detectMux({ enabled: "auto", env: {} });
		strictEqual(outside.detection.mode, "none");
		strictEqual(outside.detection.refused, false);
		strictEqual(outside.detection.reason, "HERDR_ENV is not 1, so CLIO Coder is not running inside a pane host");
		strictEqual(outside.client, null);
	});

	it("names the canonical files-pane key when Yazi is disabled", async () => {
		const panes = createPanesRuntime({
			mux: { mode: "none" } as MuxContract,
			getSettings: () => DEFAULT_SETTINGS,
			getDispatchSnapshot: () => ({
				generatedAt: "2026-09-01T00:00:00.000Z",
				running: [],
				retrying: [],
				totals: { tokens: sumFacts([]), cost: sumPricing([]), runtimeSeconds: 0 },
			}),
			getCwd: () => "/workspace",
		});

		deepStrictEqual(await panes.open({ preset: "files" }), {
			status: "refused",
			reason: "the files pane is disabled by interface.panes.files.enabled",
		});
	});

	it("names the install when panes were not composed and the pane host is not installed (bt-11 #4)", async () => {
		const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === "panes");
		if (!entry) throw new Error("missing panes slash command");
		const env = await isolateClioEnv();
		try {
			let notice = "";
			entry.handle({ kind: "panes" }, {
				notice: (_level, text) => {
					notice = text;
				},
			} as SlashCommandContext);
			const platform = currentToolPlatform();
			// A platform with no pinned herdr build has nothing to install, so it keeps the restart words.
			const pinned = platform !== null && findPinnedTool("herdr")?.downloads[platform] !== undefined;
			strictEqual(
				notice,
				pinned
					? "panes are inactive: terminal panes are not installed. Run `clio-coder panes install`, then restart `clio-coder`"
					: "panes are inactive: this session started without panes. Restart `clio-coder` in a plain terminal to open its own pane host, or run `clio-coder --with-panes` inside herdr",
			);
		} finally {
			env.restore();
		}
	});
});
