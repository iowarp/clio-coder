/**
 * hook-receipts.ts's own doc comment claimed `clio-coder config inspect` reads
 * the persisted hook receipt log; nothing did. This pins the wiring: config
 * inspect's customization graph now reports a `hook-receipts` entry sourced
 * from the same persisted file createHookReceiptLog writes.
 */
import { strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCustomizationGraph } from "../../src/cli/config-inspect.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { createHookReceiptLog } from "../../src/domains/middleware/hook-receipts.js";
import type { HookReceipt } from "../../src/domains/middleware/hooks.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function receipt(overrides: Partial<HookReceipt> = {}): HookReceipt {
	return {
		at: Date.now(),
		hookId: "test-hook",
		origin: "project",
		sourcePath: ".clio-coder/hooks.yaml",
		hash: "deadbeef",
		hook: "before_tool",
		kind: "command",
		outcome: "command-ok",
		...overrides,
	};
}

describe("config inspect reads the persisted hook receipt log", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await newScratchClioHome();
	});
	afterEach(() => {
		clearScratchClioHome(dir);
	});

	it("reports present:false with a zero count when no log has ever persisted", () => {
		const graph = buildCustomizationGraph(dir);
		const entry = graph.entries.find((candidate) => candidate.category === "hook" && candidate.id === "hook-receipts");
		strictEqual(entry?.detail?.present, false);
		strictEqual(entry?.detail?.count, 0);
	});

	it("reflects the persisted receipts, including the outcome tally and the most recent entry", () => {
		const persistPath = join(clioStateDir(), "hook-receipts.json");
		const log = createHookReceiptLog({ persistPath, throttleMs: 0 });
		log.record(receipt({ hookId: "a", outcome: "command-ok", at: 1 }));
		log.record(receipt({ hookId: "b", outcome: "command-failed", at: 2 }));
		log.flush();

		const graph = buildCustomizationGraph(dir);
		const entry = graph.entries.find((candidate) => candidate.category === "hook" && candidate.id === "hook-receipts");
		strictEqual(entry?.detail?.present, true);
		strictEqual(entry?.detail?.count, 2);
		strictEqual((entry?.detail?.outcomes as Record<string, number>)["command-ok"], 1);
		strictEqual((entry?.detail?.outcomes as Record<string, number>)["command-failed"], 1);
		strictEqual((entry?.detail?.mostRecent as { hookId: string })?.hookId, "b");
	});
});
