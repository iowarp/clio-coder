import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type PermissionRequestedPayload } from "../../src/core/bus-events.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { PermissionRequiredMeta, ToolRegistry } from "../../src/tools/registry.js";

interface PermissionHarness {
	events: string[];
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	permissionRequired: (call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void;
	permissionRequested: (payload: PermissionRequestedPayload) => void;
}

function createPermissionHarness(): PermissionHarness {
	const events: string[] = [];
	let permissionRequired: PermissionHarness["permissionRequired"] = () => {};
	let permissionRequested: PermissionHarness["permissionRequested"] = () => {};
	let overlayNumber = 0;
	const toolRegistry = {
		onPermissionRequired: (listener: PermissionHarness["permissionRequired"]) => {
			permissionRequired = listener;
			return () => events.push("unsubscribe:permission");
		},
		onAutonomyDenied: () => () => events.push("unsubscribe:autonomy"),
		parkedCount: () => 1,
		hasParkedCalls: () => false,
		cancelParkedCall: (requestId: string, reason: string) => {
			events.push(`cancel:${requestId}:${reason}`);
			return true;
		},
		cancelParkedCalls: (reason: string) => events.push(`cancel-all:${reason}`),
		resumeParkedCalls: () => Promise.resolve(),
	} as unknown as ToolRegistry;
	const app = {
		toolRegistry,
		bus: {
			on: (channel: string, listener: PermissionHarness["permissionRequested"]) => {
				strictEqual(channel, BusChannels.PermissionRequested);
				permissionRequested = listener;
				return () => events.push("unsubscribe:worker");
			},
			emit: (channel: string, payload: { status?: string; requestId?: string }) =>
				events.push(`emit:${channel}:${payload.status}:${payload.requestId}`),
		},
		dispatch: {
			resolveWorkerPermission: (runId: string, requestId: string, decision: string) =>
				events.push(`resolve-worker:${runId}:${requestId}:${decision}`),
		},
		getSettings: () => ({ autonomy: "ask" }),
	} as unknown as OverlayLifecycleApplicationDeps;
	const runtime = {
		app,
		tui: { requestRender: () => events.push("render") } as unknown as TUI,
		footer: { refresh: () => events.push("footer") },
		interactiveTickers: {
			stopDispatchBoardTicker: () => events.push("stop-board"),
			renderContextIsland: () => events.push("context-island"),
			renderTaskIsland: () => events.push("task-island"),
		},
		busNoticeSink: {
			appendReplayBlock: () => events.push("notice"),
			requestRender: () => events.push("notice-render"),
		},
		chatRenderer: { applyEvent: () => events.push("chat") },
		notify: () => {},
		terminal: { columns: 100 },
		dispatchBoard: {},
		getObservabilitySnapshot: () => ({}),
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		showOverlayFrame: () => {
			overlayNumber += 1;
			const current = overlayNumber;
			events.push(`show:${current}`);
			return { hide: () => events.push(`hide:${current}`) } as unknown as OverlayHandle;
		},
	} as unknown as OverlayLifecycleRuntimeDeps;

	return {
		events,
		lifecycle: createOverlayLifecycle(runtime),
		permissionRequired: (...args) => permissionRequired(...args),
		permissionRequested: (payload) => permissionRequested(payload),
	};
}

const askDecision = {
	kind: "ask",
	classification: { actionClass: "execute" },
	rejection: { short: "approval required", detail: "approval required" },
} as SafetyDecision;

describe("contracts/interactive permission overlay lifecycle", () => {
	it("hides before denying and cancels the exact parked request", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "bash", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-denied",
			toolCallId: "tool-denied",
		} as PermissionRequiredMeta);
		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		harness.events.length = 0;

		harness.lifecycle.closeOverlay();

		strictEqual(harness.lifecycle.getState(), "closed");
		deepStrictEqual(harness.events, [
			"stop-board",
			"hide:1",
			`emit:${BusChannels.PermissionResolved}:denied:req-denied`,
			"cancel:req-denied:User cancelled this tool call from the permission confirmation prompt. Do not retry the same target via another tool. Wait for new instruction.",
			"context-island",
			"task-island",
			"render",
		]);
	});

	it("resolves worker escalations in FIFO order without publishing main permission resolutions", () => {
		const harness = createPermissionHarness();
		const workerRequest = (runId: string, requestId: string): PermissionRequestedPayload => ({
			tool: "bash",
			actionClass: "execute",
			requestId,
			origin: `worker:${runId}`,
			requestedBy: runId,
			agentId: `agent-${runId}`,
			escalation: true,
			timeoutMs: 120_000,
			summary: `${runId} requires approval`,
		});

		harness.permissionRequested(workerRequest("run-1", "worker-1"));
		harness.permissionRequested(workerRequest("run-2", "worker-2"));
		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		harness.events.length = 0;

		harness.lifecycle.confirmPermission();

		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		deepStrictEqual(harness.events, [
			"stop-board",
			"hide:1",
			"resolve-worker:run-1:worker-1:approve",
			"show:2",
			"render",
			"context-island",
			"task-island",
			"render",
			"footer",
			"render",
		]);
		strictEqual(
			harness.events.some((event) => event.startsWith("emit:")),
			false,
		);
		harness.events.length = 0;

		harness.lifecycle.closeOverlay();

		strictEqual(harness.lifecycle.getState(), "closed");
		deepStrictEqual(harness.events, [
			"stop-board",
			"hide:2",
			"resolve-worker:run-2:worker-2:deny",
			"context-island",
			"task-island",
			"render",
		]);
		strictEqual(
			harness.events.some((event) => event.startsWith("emit:")),
			false,
		);
	});

	it("unsubscribes permission, worker, and autonomy listeners on disposal", () => {
		const harness = createPermissionHarness();
		harness.events.length = 0;

		harness.lifecycle.dispose();

		deepStrictEqual(harness.events, ["unsubscribe:permission", "unsubscribe:worker", "unsubscribe:autonomy"]);
	});
});
