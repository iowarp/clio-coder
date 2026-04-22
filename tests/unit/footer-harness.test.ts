import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatHarnessIndicator } from "../../src/interactive/footer-panel.js";

describe("formatHarnessIndicator", () => {
	it("returns null for idle", () => {
		strictEqual(formatHarnessIndicator({ kind: "idle" }), null);
	});
	it("formats hot-ready", () => {
		const line = formatHarnessIndicator({ kind: "hot-ready", message: "read.ts (14ms)", until: 0 });
		strictEqual(typeof line, "string");
		strictEqual((line as string).includes("read.ts"), true);
	});
	it("formats restart-required with file count", () => {
		const line = formatHarnessIndicator({
			kind: "restart-required",
			files: ["src/domains/session/manifest.ts", "src/engine/agent.ts"],
		});
		strictEqual((line as string).includes("restart"), true);
		strictEqual((line as string).includes("Ctrl+R"), true);
	});
	it("formats worker-pending with count", () => {
		const line = formatHarnessIndicator({ kind: "worker-pending", count: 3 });
		strictEqual((line as string).includes("3"), true);
	});
	it("formats hot-failed with message", () => {
		const line = formatHarnessIndicator({ kind: "hot-failed", message: "edit.ts: syntax error", until: 0 });
		strictEqual((line as string).includes("edit.ts"), true);
	});
});
