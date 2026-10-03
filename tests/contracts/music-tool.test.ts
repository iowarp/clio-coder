import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MusicOperations, MusicResult } from "../../src/domains/mux/music-operations.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";

/**
 * The music tool exists only when the session hands registerAllTools a music
 * session, and each action reaches the operations `/music` drives.
 */

function fakeMusic(calls: string[]): MusicOperations {
	const record = (name: string, result: MusicResult) => async (): Promise<MusicResult> => {
		calls.push(name);
		return result;
	};
	return {
		unavailableReason: () => null,
		isOpen: () => false,
		toggle: record("toggle", { status: "stopped" }),
		on: record("on", { status: "playing", title: "REYFM Lofi", opened: true }),
		off: record("off", { status: "stopped" }),
		next: record("next", { status: "playing", title: "Lofi 24/7", opened: false }),
		station: record("station", { status: "stopped" }),
		status: record("status", { status: "unavailable", reason: "music is unavailable: cliamp not found" }),
	};
}

describe("music tool", () => {
	it("is absent without a music session and routes each action when present", async () => {
		const bare = createRegistry({ safety: createWorkerSafety() });
		registerAllTools(bare, { mcpCapabilities: false });
		strictEqual(
			bare.listAll().some((spec) => spec.name === ToolNames.Music),
			false,
		);

		const calls: string[] = [];
		const registry = createRegistry({ safety: createWorkerSafety() });
		registerAllTools(registry, { mcpCapabilities: false, music: fakeMusic(calls) });
		const call = async (action: string) => {
			const verdict = await registry.invoke({ tool: ToolNames.Music, args: { action } });
			if (verdict.kind !== "ok") throw new Error(`music was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		};
		deepStrictEqual(await call("on"), {
			kind: "ok",
			output: "♫ REYFM Lofi (music pane opened)",
			details: { action: "on", status: "playing", title: "REYFM Lofi", opened: true },
		});
		strictEqual((await call("next")).kind, "ok");
		strictEqual((await call("off")).kind, "ok");
		deepStrictEqual(await call("status"), {
			kind: "error",
			message: "music: music is unavailable: cliamp not found",
		});
		deepStrictEqual(calls, ["on", "next", "off", "status"]);
	});
});
