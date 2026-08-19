import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import type { ToolApprovalStateEvent } from "../../src/interactive/chat-loop.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { PermissionRequiredMeta, ToolRegistry } from "../../src/tools/registry.js";

describe("contracts/interactive overlay lifecycle", () => {
	it("hides the permission overlay before publishing and resuming an approved call", () => {
		const events: string[] = [];
		const approvalStates: ToolApprovalStateEvent[] = [];
		let permissionRequired: Parameters<ToolRegistry["onPermissionRequired"]>[0] = () => {};
		const toolRegistry = {
			onPermissionRequired: (listener: Parameters<ToolRegistry["onPermissionRequired"]>[0]) => {
				permissionRequired = listener;
				return () => events.push("unsubscribe:permission");
			},
			onAutonomyDenied: () => () => events.push("unsubscribe:autonomy"),
			parkedCount: () => 1,
			hasParkedCalls: () => false,
			resumeParkedCalls: () => {
				events.push("resume");
				return Promise.resolve([]);
			},
		} as unknown as ToolRegistry;
		const app = {
			toolRegistry,
			bus: {
				on: () => () => events.push("unsubscribe:worker"),
				emit: () => events.push("emit:resolved"),
			},
			getSettings: () => ({ autonomy: "ask" }),
		} as unknown as OverlayLifecycleApplicationDeps;
		const handle = { hide: () => events.push("hide") } as unknown as OverlayHandle;
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
			chatRenderer: {
				applyEvent: (event: ToolApprovalStateEvent) => {
					approvalStates.push(event);
					events.push(`chat:${event.state}`);
				},
			},
			notify: () => {},
			terminal: { columns: 100 },
			dispatchBoard: {},
			chatPanel: {},
			io: { stdout: () => {}, stderr: () => {} },
			readStructuredEntries: () => [],
			announceTaskMemorySeedOffer: () => {},
			keybindings: {},
			editor: { getText: () => "", setText: () => {} },
			getSlashContext: () => ({}),
			showOverlayFrame: () => handle,
		} as unknown as OverlayLifecycleRuntimeDeps;
		const lifecycle = createOverlayLifecycle(runtime);
		const call = {
			tool: "bash",
			args: { command: `printf ready${String.fromCharCode(27)}[31m` },
		} as ClassifierCall;
		const decision = {
			kind: "ask",
			classification: { actionClass: "execute" },
			rejection: { short: "approval required", detail: "approval required" },
		} as SafetyDecision;
		const meta = { requestId: "req-1", toolCallId: "tool-1", axis: "net:bash-confirm" } as PermissionRequiredMeta;

		permissionRequired(call, decision, meta);
		strictEqual(lifecycle.getState(), "permission-confirm");
		deepStrictEqual(approvalStates, [
			{
				type: "tool_approval_state",
				toolCallId: "tool-1",
				state: "awaiting-approval",
				view: {
					requestId: "req-1",
					tool: "bash",
					actionClass: "execute",
					axis: { kind: "net", ruleId: "bash-confirm" },
					origin: { kind: "main" },
					reason: "approval required",
					target: "printf ready",
				},
			},
		]);
		events.length = 0;
		lifecycle.confirmPermission();

		strictEqual(lifecycle.getState(), "closed");
		deepStrictEqual(events, [
			"stop-board",
			"hide",
			"emit:resolved",
			"chat:resumed",
			"resume",
			"context-island",
			"task-island",
			"render",
			"footer",
			"render",
		]);
	});
});
