import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type PermissionRequestedPayload } from "../../src/core/bus-events.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import { routePermissionOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import { permissionOverlayHint } from "../../src/interactive/permission-overlay.js";
import type { PermissionRequiredMeta, ToolRegistry } from "../../src/tools/registry.js";

interface PermissionHarness {
	events: string[];
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	permissionRequired: (call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void;
	permissionRequested: (payload: PermissionRequestedPayload) => void;
	/** The registry's parked queue, in arrival order, as the stub registry sees it. */
	parked: Array<{ call: ClassifierCall; decision: SafetyDecision; meta: PermissionRequiredMeta }>;
	draft: { text: string };
	frames: Array<{ title: string; tone?: string; body: string[] }>;
}

function createPermissionHarness(options: { columns?: number } = {}): PermissionHarness {
	const events: string[] = [];
	let permissionRequired: PermissionHarness["permissionRequired"] = () => {};
	let permissionRequested: PermissionHarness["permissionRequested"] = () => {};
	let overlayNumber = 0;
	const parked: PermissionHarness["parked"] = [];
	const draft = { text: "" };
	const frames: PermissionHarness["frames"] = [];
	const overlayHandle = (id: string): OverlayHandle =>
		({
			hide: () => events.push(`hide:${id}`),
			focus: () => events.push(`focus:${id}`),
		}) as unknown as OverlayHandle;
	// The stub keeps the registry's queue so `renotifyHead` can do what the
	// real one does: fire the listener again for the head parked call.
	const toolRegistry = {
		onPermissionRequired: (listener: PermissionHarness["permissionRequired"]) => {
			permissionRequired = (call, decision, meta) => {
				if (!parked.some((entry) => entry.meta.requestId === meta.requestId)) parked.push({ call, decision, meta });
				listener(call, decision, meta);
			};
			return () => events.push("unsubscribe:permission");
		},
		onAutonomyDenied: () => () => events.push("unsubscribe:autonomy"),
		parkedCount: () => Math.max(1, parked.length),
		hasParkedCalls: () => parked.length > 0,
		cancelParkedCall: (requestId: string, reason: string) => {
			events.push(`cancel:${requestId}:${reason}`);
			const index = parked.findIndex((entry) => entry.meta.requestId === requestId);
			if (index !== -1) parked.splice(index, 1);
			return true;
		},
		cancelParkedCalls: (reason: string) => {
			events.push(`cancel-all:${reason}`);
			parked.length = 0;
		},
		renotifyHead: () => {
			events.push("renotify-head");
			const head = parked[0];
			if (head) permissionRequired(head.call, head.decision, head.meta);
		},
		resumeParkedCalls: (grant?: { requestId?: string }) => {
			const index = parked.findIndex((entry) => entry.meta.requestId === grant?.requestId);
			if (index !== -1) parked.splice(index, 1);
			return Promise.resolve();
		},
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
			startDispatchBoardTicker: () => events.push("start-board"),
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
		terminal: { columns: options.columns ?? 100 },
		dispatchBoard: { resetSelection: () => {} },
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: {
			getText: () => draft.text,
			setText: (text: string) => {
				draft.text = text;
			},
		},
		getSlashContext: () => ({}),
		openHelpOverlay: () => {
			events.push("show:help");
			return overlayHandle("help");
		},
		showOverlayFrame: (
			_tui: unknown,
			body: unknown,
			frameOptions: {
				footerHint?: (innerWidth: number) => string;
				title?: string | (() => string);
				tone?: string | (() => string | undefined);
			},
		) => {
			overlayNumber += 1;
			const current = overlayNumber;
			const title = typeof frameOptions.title === "function" ? frameOptions.title() : (frameOptions.title ?? "");
			const tone = typeof frameOptions.tone === "function" ? frameOptions.tone() : frameOptions.tone;
			const render =
				typeof body === "object" && body !== null && "render" in body && typeof body.render === "function"
					? body.render.bind(body)
					: undefined;
			frames.push({ title, ...(tone !== undefined ? { tone } : {}), body: render?.(80) ?? [] });
			events.push(`show:${current}`);
			return overlayHandle(String(current));
		},
	} as unknown as OverlayLifecycleRuntimeDeps;

	return {
		events,
		lifecycle: createOverlayLifecycle(runtime),
		permissionRequired: (...args) => permissionRequired(...args),
		permissionRequested: (payload) => permissionRequested(payload),
		parked,
		draft,
		frames,
	};
}

const askDecision = {
	kind: "ask",
	classification: { actionClass: "execute" },
	rejection: { short: "approval required", detail: "approval required" },
} as SafetyDecision;

describe("contracts/interactive permission overlay lifecycle", () => {
	/**
	 * One denial rendered the same state six times on one frame. The dialog
	 * already names the tool, the target, the action class, the axis that asked
	 * and the keys that answer it, so the `[approval] ... parked` notice above the
	 * transcript was the same sentence a line higher. It stays only for the case
	 * where no dialog can open, which is the one time it is the operator's only
	 * signal that a call is waiting.
	 */
	it("does not also announce a parked call the dialog is already showing", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "bash", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-quiet",
			toolCallId: "tool-quiet",
		} as PermissionRequiredMeta);

		strictEqual(harness.lifecycle.getState(), "permission-confirm", "the dialog is the rendering");
		ok(!harness.events.includes("notice"), `no notice beside the dialog: ${harness.events.join(",")}`);
	});

	it("announces a parked call that no dialog can show because one is already open", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired({ tool: "bash", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-first",
			toolCallId: "tool-first",
		} as PermissionRequiredMeta);
		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		harness.events.length = 0;

		harness.permissionRequired({ tool: "write", args: {} } as ClassifierCall, askDecision, {
			requestId: "req-queued",
			toolCallId: "tool-queued",
		} as PermissionRequiredMeta);

		ok(harness.events.includes("notice"), `the notice is the only signal here: ${harness.events.join(",")}`);
	});

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
			"cancel:req-denied:User cancelled this tool call from the permission confirmation prompt. Wait for new instruction.",
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

	it("retains each queued request's tier and attribution when the next dialog opens", () => {
		const harness = createPermissionHarness();
		harness.permissionRequired(
			{ tool: "write", args: { path: "src/a.ts" } },
			{
				kind: "ask",
				classification: { actionClass: "write", reasons: [] },
				rejection: { short: "write needs approval", detail: "write needs approval", hints: [] },
			} as SafetyDecision,
			{
				requestId: "req-workspace",
				axis: "autonomy:suggest",
			},
		);
		harness.permissionRequired(
			{ tool: "bash", args: { command: "sudo whoami" } },
			{
				kind: "ask",
				classification: { actionClass: "system_modify", reasons: ["sudo-or-doas"] },
				rejection: {
					short: "system modification needs approval",
					detail: "system modification needs approval",
					hints: [],
				},
			} as SafetyDecision,
			{ requestId: "req-system", axis: "net:system-modify-confirm" },
		);

		strictEqual(harness.frames.length, 1, "the queued request does not replace the active dialog");
		strictEqual(harness.frames[0]?.title, "Approve workspace action");
		ok(harness.frames[0]?.body.join(" ").includes("main agent through autonomy level (suggest)"));

		harness.lifecycle.closeOverlay();

		strictEqual(harness.frames.length, 2);
		strictEqual(harness.frames[1]?.title, "Approve system change");
		strictEqual(harness.frames[1]?.tone, "warning");
		ok(harness.frames[1]?.body.join(" ").includes("main agent through safety-net rail system-modify-confirm"));
		ok(!harness.frames[1]?.body.join(" ").includes("src/a.ts"), "the next request retains no prior target prose");
	});

	/**
	 * An approval that parked while help held the keyboard used to stay behind
	 * help while its transcript render covered the modal. The screen showed no
	 * actionable prompt and the scalar lifecycle had no way to raise one. The
	 * approval now interrupts help as the focused frame and restores help after
	 * the decision.
	 */
	it("raises a parked approval over help and restores help after the decision", () => {
		const harness = createPermissionHarness({ columns: 60 });
		harness.lifecycle.openHelpOverlayState();
		strictEqual(harness.lifecycle.getState(), "help");
		harness.events.length = 0;

		harness.permissionRequired(
			{ tool: "bash", args: { command: "echo hi | tee /tmp/x" } } as ClassifierCall,
			askDecision,
			{
				requestId: "req-deferred",
				toolCallId: "tool-deferred",
			} as PermissionRequiredMeta,
		);

		strictEqual(harness.lifecycle.getState(), "permission-confirm", "the approval takes input immediately");
		ok(harness.events.includes("show:1"), `the approval frame is mounted above help: ${harness.events.join(",")}`);
		ok(!harness.events.includes("notice"), "the visible approval does not need a queued notice");

		strictEqual(
			routePermissionOverlayKey("\u001b", {
				cancelPermission: () => harness.lifecycle.closeOverlay(),
				confirmPermission: () => harness.lifecycle.confirmPermission(),
				stopTurnFromPermission: () => harness.lifecycle.stopTurnFromPermission(),
			}),
			true,
		);
		strictEqual(harness.lifecycle.getState(), "help", "denying returns input to help");
		ok(harness.events.includes("hide:1"), `the approval frame closed: ${harness.events.join(",")}`);
		ok(harness.events.includes("focus:help"), `the interrupted frame regained focus: ${harness.events.join(",")}`);

		harness.events.length = 0;
		harness.lifecycle.closeOverlay();
		strictEqual(harness.lifecycle.getState(), "closed");
		ok(harness.events.includes("hide:help"), "the restored help overlay remains closable");
	});

	/**
	 * With the dialog open, Enter allows only from an empty composer, Esc denies,
	 * and the footer says so at 60 columns. The composer rail's own rendering of
	 * the same keys is pinned in clio-editor.test.ts.
	 */
	it("allows only from an empty composer and denies on Escape at 60 columns", () => {
		const harness = createPermissionHarness({ columns: 60 });
		harness.draft.text = "wait, what does this do";
		harness.permissionRequired(
			{ tool: "bash", args: { command: "echo hi | tee /tmp/x" } } as ClassifierCall,
			askDecision,
			{
				requestId: "req-draft",
				toolCallId: "tool-draft",
			} as PermissionRequiredMeta,
		);
		strictEqual(harness.lifecycle.getState(), "permission-confirm");
		const frame = harness.events.find((event) => event.startsWith("show:"));
		ok(frame, "the dialog opened");
		harness.events.length = 0;

		const hint = permissionOverlayHint(56, harness.draft.text.length > 0);
		ok(!hint.includes("[Enter]"), `a draft removes Enter from the footer: ${hint}`);
		ok(hint.includes("[Esc] deny"), `the footer names deny: ${hint}`);
		ok(hint.includes("[s] stop"), `the footer names stop: ${hint}`);
		strictEqual(
			routePermissionOverlayKey("\r", {
				cancelPermission: () => harness.lifecycle.closeOverlay(),
				confirmPermission: () => harness.lifecycle.confirmPermission(),
				stopTurnFromPermission: () => harness.lifecycle.stopTurnFromPermission(),
				composerHasDraft: () => harness.draft.text.length > 0,
			}),
			true,
		);
		strictEqual(harness.lifecycle.getState(), "permission-confirm", "Enter with a draft resolved nothing");
		ok(!harness.events.some((event) => event.includes(":granted:")), "nothing was granted");

		harness.draft.text = "";
		ok(permissionOverlayHint(56, false).includes("[Enter] allow"), "an empty composer restores Enter as allow");
		harness.lifecycle.closeOverlay();
		strictEqual(harness.lifecycle.getState(), "closed");
		ok(harness.events.includes(`emit:${BusChannels.PermissionResolved}:denied:req-draft`), "Esc denied the call");
		deepStrictEqual(harness.parked, [], "the denied call left the queue");
	});

	it("unsubscribes permission, worker, and autonomy listeners on disposal", () => {
		const harness = createPermissionHarness();
		harness.events.length = 0;

		harness.lifecycle.dispose();

		deepStrictEqual(harness.events, ["unsubscribe:permission", "unsubscribe:worker", "unsubscribe:autonomy"]);
	});
});
