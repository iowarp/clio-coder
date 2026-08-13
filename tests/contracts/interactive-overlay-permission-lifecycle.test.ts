import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
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
		renotifyHead: () => events.push("renotify-head"),
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
		chat: {
			cancel: (options?: { reason?: string; source?: string; auditReason?: string }) =>
				events.push(`chat-cancel:${options?.source}:${options?.reason}`),
		},
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

	/**
	 * Denying one call left the run going and the model asked again, six times,
	 * with the command mutated each time; quitting the app was the only exit.
	 * Stopping denies every call the turn has parked, ends the run, and does not
	 * re-notify, or the operator lands straight back in the loop they left.
	 */
	it("denies every parked call, ends the run, and does not re-notify the next one", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "bash", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-stop",
			toolCallId: "tool-stop",
		} as PermissionRequiredMeta);
		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		harness.events.length = 0;

		harness.lifecycle.stopTurnFromPermission();

		strictEqual(harness.lifecycle.getState(), "closed");
		const joined = harness.events.join("\n");
		ok(
			joined.includes(`emit:${BusChannels.PermissionResolved}:denied:req-stop`),
			`the parked call is denied, not allowed: ${joined}`,
		);
		ok(
			harness.events.some((event) => event.startsWith("cancel-all:") && event.includes("stopped the turn")),
			`every parked call is cancelled under the stop reason: ${joined}`,
		);
		ok(
			harness.events.some((event) => event.startsWith("chat-cancel:stream_cancel:") && event.includes("turn stopped")),
			`the run is cancelled with operator-facing text: ${joined}`,
		);
		ok(!harness.events.includes("renotify-head"), `a stop must not re-open the next parked call: ${joined}`);
	});

	it("names the tool the operator denied in the stop text", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "write", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-named",
		} as PermissionRequiredMeta);
		harness.events.length = 0;

		harness.lifecycle.stopTurnFromPermission();

		ok(
			harness.events.some((event) => event.includes("you denied write")),
			`the stop text names the tool: ${harness.events.join("\n")}`,
		);
	});

	it("leaves Enter allowing and Escape denying exactly one call", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "bash", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-esc",
		} as PermissionRequiredMeta);
		harness.events.length = 0;

		harness.lifecycle.closeOverlay();

		const joined = harness.events.join("\n");
		ok(joined.includes("cancel:req-esc:"), "Escape still cancels just this request");
		ok(!joined.includes("cancel-all:"), "Escape must not cancel the whole queue");
		ok(!joined.includes("chat-cancel:"), "Escape must not end the run");
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
