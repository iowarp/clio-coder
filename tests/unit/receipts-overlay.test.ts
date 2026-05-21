import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt, RunStatus } from "../../src/domains/dispatch/types.js";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { openReceiptsOverlay } from "../../src/interactive/receipts-overlay.js";

function envelope(overrides: Partial<RunEnvelope> = {}): RunEnvelope {
	return {
		id: "run-abcdef012345",
		agentId: "worker-alpha",
		task: "test",
		endpointId: "local-mini",
		wireModelId: "AgenticQwen-30B-A3B-i1-Q4_K_M",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		startedAt: "2026-05-21T00:00:00.000Z",
		endedAt: null,
		status: "completed",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp",
		tokenCount: 12345,
		reasoningTokenCount: 67,
		costUsd: 1.23,
		...overrides,
	};
}

function dispatchWithRuns(runs: ReadonlyArray<RunEnvelope>): DispatchContract {
	return {
		dispatch: async () => ({
			runId: "unused",
			events: (async function* events(): AsyncIterableIterator<unknown> {})(),
			finalPromise: Promise.resolve({} as RunReceipt),
		}),
		listRuns: (_status?: RunStatus) => runs,
		getRun: (runId: string) => runs.find((run) => run.id === runId) ?? null,
		abort: () => {},
		drain: async () => {},
	};
}

function captureOverlay(): { tui: TUI; component: () => Component } {
	let mounted: Component | null = null;
	const handle: OverlayHandle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => true,
	};
	const tui = {
		showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
			mounted = component;
			return handle;
		},
	} as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay was not mounted");
			return mounted;
		},
	};
}

describe("receipts overlay layout", () => {
	it("shrinks receipt columns before the frame clips key fields", () => {
		const captured = captureOverlay();
		openReceiptsOverlay(captured.tui, dispatchWithRuns([envelope()]));
		const rendered = captured.component().render(44);
		for (const line of rendered) {
			ok(visibleWidth(line) <= 44, `line exceeded width: ${line}`);
		}
		const text = rendered.join("\n");
		ok(text.includes("e=0"), `exit code disappeared:\n${text}`);
		ok(text.includes("$1.23"), `cost disappeared:\n${text}`);
	});
});
