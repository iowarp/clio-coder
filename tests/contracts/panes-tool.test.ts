import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";

/**
 * The panes tool through the session registry over the real pane runtime the
 * `/panes` slash command drives. The pane host is the only stand-in: a mux
 * that records every request, so a refusal can be proven to reach no host.
 */

function fakeMux(available = true) {
	const calls: string[] = [];
	const records: MuxPaneRecord[] = [];
	let next = 0;
	const mux = {
		mode: available ? "guest" : "none",
		available: () => available,
		detection: () => ({
			mode: available ? "guest" : "none",
			socketPath: null,
			server: null,
			self: { workspaceId: null, tabId: null, paneId: "self" },
			candidates: [],
			reason: "HERDR_ENV is not 1, so Clio is not running inside a pane host",
			refused: false,
		}),
		list: () => records,
		async openUtilityPane(request: { argv: ReadonlyArray<string>; cwd: string; label: string }) {
			next += 1;
			const ref = { paneId: `p${next}`, tabId: "t1", workspaceId: "w1" };
			records.push({ ref, purpose: "utility", label: request.label, openedAt: next });
			calls.push(`open:${request.label}:${request.argv.join(" ")}:${request.cwd}`);
			return ref;
		},
		async closePane(paneId: string) {
			const at = records.findIndex((record) => record.ref.paneId === paneId);
			if (at < 0) return false;
			records.splice(at, 1);
			calls.push(`close:${paneId}`);
			return true;
		},
		async focusPane(paneId: string) {
			calls.push(`focus:${paneId}`);
			return true;
		},
		async focusSelf() {
			return true;
		},
		async unzoomSelf() {
			return false;
		},
		docks: () => [],
	};
	return { mux: mux as unknown as MuxContract, calls };
}

function snapshot(running: Array<{ runId: string; agentId: string }> = []): DispatchSnapshot {
	return {
		generatedAt: "2026-09-22T00:00:00.000Z",
		running,
		retrying: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
	} as unknown as DispatchSnapshot;
}

function fixture(
	options: { available?: boolean; bash?: string | null; running?: Array<{ runId: string; agentId: string }> } = {},
) {
	const { mux, calls } = fakeMux(options.available ?? true);
	const panes = createPanesRuntime({
		mux,
		getSettings: () => DEFAULT_SETTINGS,
		getDispatchSnapshot: () => snapshot(options.running),
		getCwd: () => "/workspace",
		resolveBinaryPath: () => (options.bash === undefined ? "/bin/bash" : options.bash),
		newestJournalRunId: () => null,
	});
	const registry = createRegistry({ safety: createWorkerSafety() });
	registerAllTools(registry, { mcpCapabilities: false, panes });
	return {
		panes,
		calls,
		async call(args: Record<string, unknown>): Promise<ToolResult> {
			const verdict = await registry.invoke({ tool: ToolNames.Panes, args });
			if (verdict.kind !== "ok") throw new Error(`panes was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		},
	};
}

function output(result: ToolResult): string {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result.output;
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

describe("panes tool", () => {
	it("opens one pane per preset, focuses it on a second open, lists it, and closes it by label", async () => {
		const f = fixture();
		match(
			output(await f.call({ action: "list" })),
			/^panes mode=guest available; notifications=\S+\n- no Clio-owned panes$/,
		);
		strictEqual(output(await f.call({ action: "open", preset: "shell" })), "opened the shell pane (p1).");
		strictEqual(
			output(await f.call({ action: "open", preset: "shell" })),
			"the shell pane was already open and is now focused (p1).",
		);
		match(output(await f.call({ action: "list" })), /\n- p1 utility shell$/);
		const closed = await f.call({ action: "close", target: "shell" });
		strictEqual(output(closed), "closed 1 pane(s): shell.");
		match(errorMessage(await f.call({ action: "close", target: "shell" })), /no Clio-owned pane matches 'shell'/);
		deepStrictEqual(f.calls, ["open:shell:/bin/bash -l:/workspace", "focus:p1", "close:p1"]);
	});

	it("refuses argv, unknown presets, missing fields, and unknown actions before the pane host sees them", async () => {
		const f = fixture();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ action: "open", preset: "shell", argv: ["rm", "-rf", "/"] }, /argv panes are operator-only/],
			[{ action: "list", argv: [] }, /argv panes are operator-only/],
			[{ action: "open", preset: "vim" }, /action=open requires preset, one of files, logs, shell/],
			[{ action: "open" }, /action=open requires preset/],
			[{ action: "show" }, /action=show requires target/],
			[{ action: "close", target: "  " }, /action=close requires target/],
			[{ action: "zoom", target: "p1" }, /action must be show, open, close, or list; got 'zoom'/],
		];
		for (const [args, expected] of cases) match(errorMessage(await f.call(args)), expected, JSON.stringify(args));
		deepStrictEqual(f.calls, []);
	});

	it("names the missing binary and the empty journal instead of opening a broken pane", async () => {
		const f = fixture({ bash: null });
		match(
			errorMessage(await f.call({ action: "open", preset: "shell" })),
			/bash was not found \(install with `install bash/,
		);
		match(
			errorMessage(await fixture().call({ action: "open", preset: "logs" })),
			/no dispatched run has written a journal under .* yet/,
		);
		deepStrictEqual(f.calls, []);
	});

	it("says why the pane layer is missing and what starts it", async () => {
		const f = fixture({ available: false });
		match(output(await f.call({ action: "list" })), /^panes mode=none unavailable;/);
		for (const args of [
			{ action: "open", preset: "shell" },
			{ action: "show", target: "tester" },
			{ action: "close", target: "all" },
		]) {
			const message = errorMessage(await f.call(args));
			match(message, /HERDR_ENV is not 1/, JSON.stringify(args));
			match(message, /clio-coder --with-panes/, JSON.stringify(args));
		}
		deepStrictEqual(f.calls, []);
	});

	it("points the watch pane at a live run by agent id and lists live runs on a miss", async () => {
		const f = fixture({ running: [{ runId: "run-abc123", agentId: "tester" }] });
		match(
			errorMessage(await f.call({ action: "show", target: "tester" })),
			/the watch pane is not wired in this session/,
		);
		const watched: string[] = [];
		f.panes.attachWatch({
			ensureOpen: async () => true,
			watch: async (runId) => {
				watched.push(runId);
				return { status: "watching", runId, paneId: "watch", opened: true };
			},
			follow: () => true,
			isOpen: () => true,
			dispose: () => {},
		});
		const shown = await f.call({ action: "show", target: "tester" });
		strictEqual(output(shown), "the watch pane is now rendering tester (run run-abc123).");
		strictEqual(output(await f.call({ action: "show", target: "run-abc" })), output(shown));
		strictEqual(
			errorMessage(await f.call({ action: "show", target: "reviewer" })),
			"panes: no live run matches 'reviewer'. Live runs: tester.",
		);
		deepStrictEqual(watched, ["run-abc123", "run-abc123"]);
	});
});
