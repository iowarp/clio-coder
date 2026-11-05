import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setImmediate as nextLoop } from "node:timers/promises";
import {
	applyModelAdmission,
	type ModelAdmissionEvent,
	type ModelAdmissionWait,
} from "../../src/core/model-admission.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { foregroundEndpointBlock } from "../../src/domains/dispatch/admission.js";
import { createGrantBroker } from "../../src/domains/dispatch/grant-broker.js";
import {
	createWorkerApprovalWindows,
	WORKER_APPROVAL_HOLD_CEILING_MS,
	workerApprovalBackstopMs,
} from "../../src/domains/dispatch/worker-approval-window.js";
import { type TrustSummaryProjection, trustFailureWords } from "../../src/domains/evidence/trust-projection.js";
import { credentialedCallKind, mainCallExposure } from "../../src/domains/safety/call-consequence.js";
import { outwardShellReason } from "../../src/domains/safety/containment.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { grantEffectDigest } from "../../src/domains/safety/grant-effect.js";
import {
	DEFAULT_RETRY_SETTINGS,
	formatStatedWait,
	RATE_LIMIT_WAIT_BUDGET_MS,
	retryWaitCause,
	statedRetryWaitMs,
} from "../../src/domains/session/retry.js";
import { createWorkerProgressFold, type WorkerProgressSnapshot } from "../../src/domains/telemetry/worker-progress.js";
import { markClioLoaded, reconcileResidency } from "../../src/engine/apis/residency.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
import { railDetail } from "../../src/interactive/footer/live-work.js";
import { type Notification, topNotification } from "../../src/interactive/footer/notifications.js";
import { composerPhasePresentation } from "../../src/interactive/footer/widgets.js";
import type { OverlayState } from "../../src/interactive/overlay-key-routing.js";
import { modelListTurnEffect, routeTurnEffect } from "../../src/interactive/overlay-model-selectors.js";
import { createOverlayPermissionLifecycle } from "../../src/interactive/overlay-permission-lifecycle.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	permissionRailTitle,
} from "../../src/interactive/permission-overlay.js";
import {
	presentProviderError,
	providerFailureAdvice,
	providerFailureEvidence,
	providerFailureHeadline,
	providerFailureRailFacts,
} from "../../src/interactive/renderers/provider-error.js";
import { formatRetryStatus } from "../../src/interactive/renderers/retry-status.js";
import { buildSummary, reduceStatus, type StatusInputEvent } from "../../src/interactive/status/index.js";
import { approvalWaitWords, workerActivityWords } from "../../src/interactive/worker-activity.js";
import { classifyTurnEnding } from "../../src/session-control/chat-loop-messages.js";
import {
	type AgentStatus,
	INITIAL_STATUS,
	type ModelRequestFacts,
	type RetryOverlay,
} from "../../src/session-control/status-types.js";
import type { RetryStatusPayload, TurnRecoveryDeps } from "../../src/session-control/turn-recovery.js";
import { createTurnRecovery } from "../../src/session-control/turn-recovery.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { createWorkerStdinDemux } from "../../src/worker/stdin-demux.js";

const STUCK_AFTER_MS = 180_000;

function reducer(start = 1_000_000) {
	let now = start;
	let status: AgentStatus = INITIAL_STATUS;
	const apply = (event: StatusInputEvent | { type: string; [key: string]: unknown }): AgentStatus => {
		status = reduceStatus(status, event as StatusInputEvent, { now, localRuntime: false });
		return status;
	};
	return {
		apply,
		advance(ms: number): AgentStatus {
			for (let spent = 0; spent < ms; spent += 1_000) {
				now += 1_000;
				apply({ type: "watchdog_tick" });
			}
			return status;
		},
		current: () => status,
		now: () => now,
	};
}

function waitingOnModel(machine: ReturnType<typeof reducer>): void {
	machine.apply({ type: "agent_start" });
	machine.apply({ type: "turn_start" });
}

test("an open approval stays human-owned past the stuck threshold and the clock restarts when it resolves", () => {
	const machine = reducer();
	waitingOnModel(machine);
	machine.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
	machine.apply({ type: "overlay_push", overlay: "tool_blocked" });
	const held = machine.advance(STUCK_AFTER_MS + 20_000);
	strictEqual(held.phase, "tool_blocked");
	strictEqual(held.watchdogTier, 0);
	strictEqual(held.watchdogPeak, 0);
	const resolved = machine.apply({ type: "overlay_pop", overlay: "tool_blocked" });
	strictEqual(resolved.phase, "tool_running");
	strictEqual(resolved.lastMeaningfulAt, machine.now());
	strictEqual(machine.advance(9_000).watchdogTier, 0);
	strictEqual(machine.advance(2_000).watchdogTier, 1);
});

test("an open interview stays human-owned past the stuck threshold and the wait is the operator's, not the turn's", () => {
	const machine = reducer();
	waitingOnModel(machine);
	machine.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "ask_user", args: {} });
	const held = machine.advance(STUCK_AFTER_MS + 20_000);
	strictEqual(held.phase, "tool_running");
	strictEqual(held.watchdogTier, 0);
	machine.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "ask_user", result: "", isError: false });
	const ended = machine.apply({ type: "agent_end", messages: [] });
	strictEqual(ended.phase, "ended");
	strictEqual(ended.summary?.humanWaitMs, STUCK_AFTER_MS + 20_000);
});

test("a model that goes silent with nobody waiting still reaches stuck", () => {
	const machine = reducer();
	waitingOnModel(machine);
	strictEqual(machine.advance(STUCK_AFTER_MS + 1_000).phase, "stuck");
});

function failedAttempt(attempt: number) {
	const retryPending = { attempt, maxAttempts: 3 };
	const message = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: '503: {"message":"overloaded"}',
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	return [
		{ type: "message_start", message },
		{ type: "message_end", message, retryPending },
		{ type: "agent_end", messages: [message], retryPending },
		{
			type: "retry_status",
			status: { phase: "scheduled", attempt, maxAttempts: 3, delayMs: 8_000, retryAfterMs: 8_000 },
		},
	] as const;
}

const retrying = (attempt: number) => ({
	type: "retry_status",
	status: { phase: "retrying", attempt, maxAttempts: 3 },
});
const screen = (panel: ReturnType<typeof createChatPanel>): string =>
	panel.render(100).map(stripTerminalSequences).join("\n");

test("a retry backoff stays retrying with no failed receipt until exhaustion", () => {
	const machine = reducer();
	const panel = createChatPanel({ now: () => machine.now() });
	const both = (event: { type: string; [key: string]: unknown }): void => {
		machine.apply(event);
		panel.applyEvent(event as never);
	};
	panel.appendUser("hello");
	both({ type: "agent_start" });
	both({ type: "turn_start" });
	for (const event of failedAttempt(1)) both(event);
	strictEqual(machine.current().phase, "retrying");
	strictEqual(machine.current().retry?.dueAt, machine.now() + 8_000);
	machine.advance(5_000);
	strictEqual(machine.current().phase, "retrying");
	strictEqual((screen(panel).match(/↻/gu) ?? []).length, 1);
	doesNotMatch(screen(panel), /Failed|✗|\[error\]/u);

	both(retrying(1));
	both({ type: "agent_start" });
	strictEqual(machine.current().retry?.stage, "attempt");
	for (const event of failedAttempt(2)) both(event);
	both(retrying(2));
	both({ type: "agent_start" });
	doesNotMatch(screen(panel), /Failed|✗|\[error\]/u);

	const last = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: '503: {"message":"overloaded"}',
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	both({ type: "message_start", message: last });
	both({ type: "message_end", message: last });
	both({ type: "agent_end", messages: [last] });
	both({ type: "retry_status", status: { phase: "exhausted", attempt: 2, maxAttempts: 2 } });
	strictEqual(machine.current().phase, "ended");
	strictEqual(machine.current().summary?.stopReason, "error");
	strictEqual((screen(panel).match(/✗ Failed/gu) ?? []).length, 1);
	strictEqual((screen(panel).match(/\[error\]/gu) ?? []).length, 1);
	match(screen(panel), /✗ Failed · [^\n]*2 retries/u);
});

test("a retried run recovers into one receipt that notes the retries", () => {
	let now = 1_000;
	const panel = createChatPanel({ now: () => now });
	panel.appendUser("hello");
	panel.applyEvent({ type: "agent_start" } as never);
	for (const event of failedAttempt(1)) panel.applyEvent(event as never);
	now += 8_000;
	panel.applyEvent(retrying(1) as never);
	panel.applyEvent({ type: "agent_start" } as never);
	const answer = {
		role: "assistant",
		content: [{ type: "text", text: "Recovered answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
	};
	panel.applyEvent({ type: "message_start", message: answer } as never);
	panel.applyEvent({ type: "message_end", message: answer } as never);
	panel.applyEvent({ type: "agent_end", messages: [answer] } as never);
	panel.applyEvent({ type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 3 } } as never);
	const output = screen(panel);
	strictEqual((output.match(/✓ Done/gu) ?? []).length, 1);
	match(output, /✓ Done · 8\.0s · 1 retry/u);
	match(output, /provider retry recovered after 1 attempt/u);
	doesNotMatch(output, /Failed/u);
});

test("Esc during a first-token wait puts the receipt under the cancelled prompt and leaves the last receipt intact", () => {
	let now = 1_000;
	const panel = createChatPanel({ now: () => now });
	panel.appendUser("first prompt");
	panel.applyEvent({ type: "agent_start" } as never);
	const answer = {
		role: "assistant",
		content: [{ type: "text", text: "First answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
	};
	panel.applyEvent({ type: "message_end", message: answer } as never);
	now += 3_000;
	panel.applyEvent({ type: "agent_end", messages: [answer] } as never);

	panel.appendUser("second prompt");
	panel.applyEvent({ type: "agent_start" } as never);
	now += 15_000;
	// The engine's abort arrives with no message_end: a synthetic window and nothing rendered.
	const aborted = {
		role: "assistant",
		content: [],
		stopReason: "aborted",
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	panel.applyEvent({ type: "agent_end", messages: [aborted] } as never);

	const output = screen(panel);
	const firstReceipt = output.indexOf("✓ Done · 3.0s");
	const prompt = output.indexOf("second prompt");
	const cancelled = output.indexOf("⊘ Cancelled · 15s");
	ok(firstReceipt >= 0, output);
	ok(prompt > firstReceipt, output);
	ok(cancelled > prompt, output);
});

test("a backoff longer than the stuck threshold is Clio's own countdown and never reads as silence", () => {
	const machine = reducer();
	waitingOnModel(machine);
	machine.apply({
		type: "retry_status",
		status: { phase: "scheduled", attempt: 1, maxAttempts: 3, delayMs: STUCK_AFTER_MS * 2 },
	});
	strictEqual(machine.advance(STUCK_AFTER_MS + 30_000).phase, "retrying");
});

test("a silent wait keeps state, elapsed and the way out at every width past 90 seconds, in that order", () => {
	const machine = reducer();
	waitingOnModel(machine);
	for (const [silence, head] of [
		[91_000, "waiting"],
		[STUCK_AFTER_MS + 1_000, "no output"],
	] as const) {
		machine.advance(silence - (machine.now() - 1_000_000));
		for (const width of [160, 109, 80, 60, 40]) {
			const { label } = composerPhasePresentation(machine.current(), width, machine.now(), "qwopus");
			const rail = `${width}: ${label}`;
			const state = label.indexOf(head);
			const elapsed = label.search(/\b\d+m\d*s/u);
			ok(state >= 0 && state < elapsed && elapsed < label.indexOf("Esc"), rail);
			if (width >= 80) ok(label.includes("/model"), rail);
		}
	}
});

test("reasoning a target's history dropped replays as streamed and not kept, with nothing to open", () => {
	const panel = createChatPanel();
	panel.appendUser("question");
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "Answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
		clioCoderReasoningNotRetained: true,
	};
	panel.applyEvent({ type: "message_start", message } as never);
	panel.applyEvent({ type: "message_end", message } as never);
	panel.applyEvent({ type: "agent_end", messages: [message], replayed: { elapsedMs: 5_000 } } as never);
	const rendered = screen(panel);
	match(rendered, /streamed live, not kept/u);
	doesNotMatch(rendered, /Thinking · \/view/u);
});

test("a replayed receipt splits work from the operator wait the live run recorded", () => {
	const panel = createChatPanel();
	panel.appendUser("question");
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "Answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
	};
	panel.applyEvent({ type: "message_start", message } as never);
	panel.applyEvent({ type: "message_end", message } as never);
	panel.applyEvent({
		type: "agent_end",
		messages: [message],
		replayed: { elapsedMs: 50_000, humanWaitMs: 30_000 },
	} as never);
	match(screen(panel), /20s work · 30s waiting on you/u);
});

function waitOnRequest(extra: Partial<ModelRequestFacts>, at = 1_000_000): AgentStatus {
	return {
		...INITIAL_STATUS,
		phase: "waiting_model",
		since: at,
		waitingSince: at,
		lastMeaningfulAt: at,
		modelRequest: { sentAt: at, modelId: "cold-a", firstByteAt: null, bytesObservable: true, ...extra },
	};
}

const WIDTHS = [109, 80, 60, 40] as const;

test("a cold load keeps its state, clock and way out at every width and never says the request went out", () => {
	const at = 1_000_000;
	const facts: ModelRequestFacts = { sentAt: at, modelId: "cold-a", firstByteAt: null, bytesObservable: true };
	applyModelAdmission(facts, { stage: "loading", model: "cold-a", evidence: "requested" }, at);
	applyModelAdmission(facts, { stage: "loading", model: "cold-a", evidence: "reported" }, at + 500);
	strictEqual(facts.admission?.since, at);
	const status = waitOnRequest(facts);
	for (const width of WIDTHS) {
		const { label } = composerPhasePresentation(status, width, at + 12_000);
		match(label, /loading/);
		match(label, /12s/);
		match(label, /Esc/);
		doesNotMatch(label, /request sent|no bytes|waiting for a response/);
	}
	match(composerPhasePresentation(status, 200, at + 12_000).label, /target reports loading/);
});

test("the load that confirmed residency closes the wait for it, and the response gets its own clock", () => {
	const at = 1_000_000;
	const facts: ModelRequestFacts = {
		sentAt: at,
		modelId: "cold-a",
		firstByteAt: null,
		bytesObservable: true,
		probedResidency: "absent",
	};
	applyModelAdmission(facts, { stage: "loading", model: "cold-a", evidence: "requested" }, at);
	applyModelAdmission(facts, { stage: "admitted" }, at + 20_000);
	strictEqual(facts.admission, null);
	strictEqual(facts.sentAt, at + 20_000);
	const { label } = composerPhasePresentation(waitOnRequest(facts), 200, at + 23_000);
	match(label, /waiting for a response · 3s/);
	match(label, /loaded in 20/);
	doesNotMatch(label, /not resident/);
});

test("a reconcile that holds a request past the stuck threshold is not silence", () => {
	const machine = reducer();
	waitingOnModel(machine);
	const facts: ModelRequestFacts = {
		sentAt: machine.now(),
		firstByteAt: null,
		bytesObservable: true,
		admission: { stage: "lock", holder: null, since: machine.now() },
	};
	machine.apply({ type: "message_start" });
	const status = machine.current();
	const held = reduceStatus(
		{ ...status, modelRequest: facts },
		{ type: "watchdog_tick" },
		{
			now: machine.now() + STUCK_AFTER_MS + 1_000,
			localRuntime: false,
			modelRequest: facts,
		},
	);
	strictEqual(held.phase, "waiting_model");
	strictEqual(held.watchdogTier, 0);
});

test("a lock, an unload, a switch and a load each say their own thing, and a lock names its owner when it can", () => {
	const at = 1_000_000;
	const wait = (admission: ModelAdmissionWait) =>
		composerPhasePresentation(waitOnRequest({ admission }), 200, at + 5_000);
	const held = wait({
		stage: "lock",
		holder: { pid: 4242, host: null, self: false, wants: "big-model" },
		since: at,
	});
	strictEqual(held.subject, "Clio");
	match(held.label, /residency lock/);
	match(held.label, /held by Clio pid 4242 for Big-model/);
	match(wait({ stage: "lock", holder: null, since: at }).label, /holder unknown/);
	match(
		wait({ stage: "lock", holder: { pid: 1, host: "other", self: false, wants: null }, since: at }).label,
		/on other/,
	);
	match(wait({ stage: "lock", holder: { pid: 1, host: null, self: true, wants: null }, since: at }).label, /this Clio/);
	match(wait({ stage: "unloading", model: "old", since: at }).label, /is unloading Old/);
	match(wait({ stage: "switching", from: "old", to: "new", since: at }).label, /is replacing Old with New/);
	match(
		wait({ stage: "loading", model: "new", evidence: "reported", replacing: "old", since: at }).label,
		/replacing Old/,
	);
	match(
		wait({ stage: "loading", model: "new", evidence: "reported", startedElsewhere: true, since: at }).label,
		/already loading when asked/,
	);
	for (const width of WIDTHS) {
		const { label } = composerPhasePresentation(
			waitOnRequest({ admission: { stage: "switching", from: "old", to: "new", since: at } }),
			width,
			at + 5_000,
		);
		match(label, /5s/);
		match(label, /Esc/);
	}
});

test("silence alone never claims a load, and only a word from the target earns one", () => {
	const at = 1_000_000;
	const late = at + 100_000;
	const silent = composerPhasePresentation(waitOnRequest({}, at), 200, late).label;
	match(silent, /target state unknown/);
	doesNotMatch(silent, /loading/);
	const probed = composerPhasePresentation(waitOnRequest({ probedResidency: "absent" }, at), 200, late).label;
	match(probed, /not resident at last probe/);
	match(probed, /may be loading or stuck/);
	match(composerPhasePresentation(waitOnRequest({ coldAtSend: "sleeping" }, at), 200, late).label, /asleep when sent/);
});

test("a probe's word stands on a target Clio only observes and yields to a reconcile that looked", () => {
	const at = 1_000_000;
	const fresh = (): ModelRequestFacts => ({
		sentAt: at,
		firstByteAt: null,
		bytesObservable: true,
		probedResidency: "absent",
	});
	const observed = fresh();
	applyModelAdmission(observed, { stage: "admitted" }, at + 1);
	strictEqual(observed.probedResidency, "absent");
	strictEqual(observed.sentAt, at);
	const looked = fresh();
	applyModelAdmission(looked, { stage: "resident" }, at + 1);
	applyModelAdmission(looked, { stage: "admitted" }, at + 2);
	strictEqual(looked.probedResidency, undefined);
});

test("a wait with every known slot taken is a wait for a slot, and an unknown limit never becomes one", () => {
	const at = 1_000_000;
	const slots = { limit: 1, workers: 1, reservations: 0, otherRequests: 0 };
	for (const width of WIDTHS) {
		const full = composerPhasePresentation(waitOnRequest({ slots }), width, at + 5_000);
		match(full.label, /slot/);
		match(full.label, /5s/);
		match(full.label, /Esc/);
		strictEqual(full.namesRoute, false);
	}
	match(composerPhasePresentation(waitOnRequest({ slots }), 200, at + 5_000).label, /1\/1 held by a worker/);
	match(composerPhasePresentation(waitOnRequest({ slots }), 200, at + 5_000).label, /queue position unknown/);
	const unknown = composerPhasePresentation(waitOnRequest({ slots: { ...slots, limit: null } }), 200, at + 15_000).label;
	match(unknown, /waiting for a response/);
	match(unknown, /a worker also on target/);
	const open = composerPhasePresentation(waitOnRequest({ slots, firstByteAt: at + 1_000 }), 200, at + 5_000).label;
	doesNotMatch(open, /slot|also on target/);
});

test("a backoff says what the target said it is waiting on, and nothing when it said nothing", () => {
	const at = 1_000_000;
	const backoff = (cause: RetryOverlay["cause"]) =>
		composerPhasePresentation(
			{
				...INITIAL_STATUS,
				phase: "retrying",
				since: at,
				lastMeaningfulAt: at,
				retry: {
					attempt: 1,
					maxAttempts: 3,
					waitMs: 15_000,
					stage: "backoff",
					dueAt: at + 15_000,
					...(cause ? { cause, causeSince: at - 20_000 } : {}),
				},
			},
			200,
			at,
		).label;
	match(backoff("model-loading"), /target has said not loaded for 20/);
	match(backoff("capacity"), /at capacity/);
	match(backoff("rate-limit"), /rate limited/);
	doesNotMatch(backoff(undefined), /loading|capacity|limited|not loaded/);
	strictEqual(retryWaitCause({ kind: "model-loading", message: "Model is unloaded." }), "model-loading");
	strictEqual(retryWaitCause({ kind: "transient-provider", message: "503: server overloaded" }), "capacity");
	strictEqual(retryWaitCause({ kind: "transient-provider", message: "429 too many requests" }), "rate-limit");
	strictEqual(retryWaitCause({ kind: "transient-provider", message: "503: unavailable" }), null);
});

test("a cancel that leaves a load behind and a restore that outlives the cancel both say so", () => {
	const at = 1_000_000;
	const facts: ModelRequestFacts = { sentAt: at, firstByteAt: null, bytesObservable: true };
	applyModelAdmission(facts, { stage: "loading", model: "cold-a", evidence: "reported" }, at);
	applyModelAdmission(facts, { stage: "abandoned" }, at + 1_000);
	const ended = composerPhasePresentation(
		{
			...INITIAL_STATUS,
			phase: "ended",
			since: at,
			lastMeaningfulAt: at,
			modelRequest: facts,
			summary: { stopReason: "cancelled" } as AgentStatus["summary"],
		},
		200,
		at + 2_000,
	).label;
	match(ended, /was cancelled · target may finish the load/);
	const stopping = composerPhasePresentation(
		{
			...INITIAL_STATUS,
			phase: "cancelling",
			since: at,
			lastMeaningfulAt: at,
			cancelRequestedAt: at,
			modelRequest: {
				sentAt: at,
				firstByteAt: null,
				bytesObservable: true,
				admission: { stage: "restoring", model: "old", since: at },
			},
		},
		200,
		at + 4_000,
	).label;
	match(stopping, /is cancelling · 4s · restoring Old/);
});

test("a reconcile reports the switch it makes and the restore a failed load forces, in order", async () => {
	const events: ModelAdmissionEvent[] = [];
	const targetKey = "http://st2-reconcile.example";
	markClioLoaded(targetKey, "old");
	await rejects(
		reconcileResidency({
			targetKey,
			targetId: "router",
			runtimeId: "llamacpp",
			keepModelId: "new",
			managed: true,
			strategy: "router",
			ttlMs: 0,
			capacity: async () => 1,
			listResident: async () => [{ modelId: "old" }],
			unload: async () => {},
			load: async () => {
				events.push({ stage: "loading", model: "new", evidence: "requested" });
				throw new Error("load refused");
			},
			reloadEvicted: async () => {},
			withLock: (_key, fn) => fn(),
			onAdmission: (event) => events.push(event),
		}),
		/load refused/,
	);
	deepStrictEqual(
		events.map((event) => event.stage),
		["switching", "loading", "restoring"],
	);
});

test("an outward call is not titled a workspace action", () => {
	const decision = (exposure?: "outward"): SafetyDecision =>
		({
			kind: "ask",
			classification: { actionClass: "execute", reasons: [], ...(exposure ? { exposure } : {}) },
		}) as never;
	const push = { tool: "bash", args: { command: "git push origin main" } };
	strictEqual(mainCallExposure(push, decision("outward")), "outward");
	strictEqual(mainCallExposure({ tool: "bash", args: { command: "npm publish" } }, decision()), "outward");
	strictEqual(mainCallExposure({ tool: "bash", args: { command: "npm test" } }, decision()), "local");
	const view: ApprovalRequestView = {
		requestId: "req",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "default" },
		origin: { kind: "main" },
		exposure: "outward",
		reason: "bash needs approval",
	};
	match(permissionRailTitle(view, { actor: "Clio", room: 80 }), /outward consequence/u);
	doesNotMatch(permissionRailTitle(view, { actor: "Clio", room: 80 }), /workspace action/u);
});

test("a 40x15 card shows the effect and every choice without scrolling, and leaves no label alone", () => {
	const view: ApprovalRequestView = {
		requestId: "req",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "default" },
		origin: { kind: "main" },
		exposure: "outward",
		reason: "bash needs approval",
		target: "git push origin main",
		consequence: ["Publishes to origin"],
	};
	const body = createPermissionOverlayBody(
		view,
		undefined,
		undefined,
		() => "Clio's safety judge gave no verdict because its answer could not be read.",
		() => 298_000,
	);
	body.setBodyRows(8);
	const rows = body.render(36).map((row) => stripTerminalSequences(row).trimEnd());
	strictEqual(rows.length, 8);
	const card = rows.join("\n");
	match(card, /effect\s+Publishes to origin/u);
	match(card, /\[Enter\] allow/u);
	match(card, /\[Esc\] deny/u);
	match(card, /\[alt\+x\] stop/u);
	match(card, /4:58 denies/u, "the timer stays on screen beside the position");
	for (const row of rows) doesNotMatch(row, /^(?:rule|effect|advisory)$/u);
});

test("a worker card's stop does not promise to end a main turn that is not running", () => {
	const view: ApprovalRequestView = {
		requestId: "req",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "default" },
		origin: { kind: "worker", agentId: "coder", runId: "run" },
		reason: "bash needs approval",
	};
	const stopRow = (running: boolean): string => {
		const body = createPermissionOverlayBody(view, undefined, undefined, undefined, undefined, undefined, () => running);
		return body
			.render(200)
			.map((row) => stripTerminalSequences(row))
			.join("\n");
	};
	match(stopRow(false), /no main turn is running/u);
	doesNotMatch(stopRow(false), /ends the main/u);
	match(stopRow(true), /ends the main turn/u);
});

/** A chain of failures that each state their own wait, driven to its settle on a mocked clock. */
async function statedWaitChain(c: TestContext, waitsSeconds: ReadonlyArray<number>) {
	c.mock.timers.enable({ apis: ["setTimeout"] });
	let clock = 0;
	c.mock.method(performance, "now", () => clock);
	const failure = (seconds: number): Record<string, unknown> => ({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "429 rate_limit_error: slow down",
		retryAfterMs: seconds * 1000,
		timestamp: Date.now(),
	});
	let sent = 0;
	const runtime = {
		runtimeId: "openai-compat",
		runtimeResolution: { contextWindowDetails: { effectiveContextWindow: 131072 } },
		agent: {
			state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
			async continue() {
				sent += 1;
				const next = waitsSeconds[sent];
				this.state.messages.push(
					next !== undefined
						? failure(next)
						: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now() },
				);
			},
		},
	} as unknown as AgentRuntime;
	const state = createTurnState();
	const statuses: RetryStatusPayload[] = [];
	const recovery = createTurnRecovery({
		state,
		isYolo: () => false,
		turnIdentity: () => state,
		persistence: { appendRetryStatus() {}, wasPersisted: () => true } as unknown as TurnRecoveryDeps["persistence"],
		context: {} as unknown as TurnRecoveryDeps["context"],
		retrySettings: () => ({ ...DEFAULT_RETRY_SETTINGS, maxDelayMs: 5000 }),
		markPersistedUserEcho: async (_text, prompt) => prompt(),
		emitRetryStatus: (status) => {
			statuses.push(status);
		},
		emitFailureMessage() {},
		emitNotice() {},
	});
	let done = false;
	void recovery
		.runTransientRetryChain(runtime, "request", {
			stopReason: "error",
			errorMessage: "429 rate_limit_error: slow down",
			message: failure(waitsSeconds[0] ?? 0) as never,
		})
		.then(() => {
			done = true;
		});
	for (let tick = 0; !done && tick < 20_000; tick++) {
		await nextLoop();
		clock += 1000;
		c.mock.timers.tick(1000);
	}
	strictEqual(done, true);
	const delays = statuses.filter((status) => status.phase === "scheduled").map((status) => status.delayMs);
	return { delays, sent, state, last: statuses.at(-1) };
}

test("a stated wait is sat out whole in attended mode, past maxDelayMs and without spending attempts", async (c) => {
	const { delays, sent, last, state } = await statedWaitChain(c, [12, 12, 12, 12, 12]);
	deepStrictEqual(delays, [12_000, 12_000, 12_000, 12_000, 12_000]);
	strictEqual(sent, 5);
	strictEqual(last?.phase, "recovered");
	strictEqual(last?.attempt, 5);
	strictEqual(state.turnStop, null);
});

test("stated waits that add up past the hour stop before the wait that would cross it, with no partial wait", async (c) => {
	const { delays, sent, last, state } = await statedWaitChain(c, [2400, 2400]);
	deepStrictEqual(delays, [2_400_000]);
	strictEqual(sent, 1);
	strictEqual(last?.phase, "exhausted");
	strictEqual(last?.waitBudgetMs, RATE_LIMIT_WAIT_BUDGET_MS);
	strictEqual(last?.waitedMs, 2_400_000);
	strictEqual(state.turnStop?.cause, "wait_past_budget");
	match(
		formatRetryStatus(last as RetryStatusPayload),
		/stopped without retrying: provider asked to wait 40m after waiting 40m/u,
	);
});

test("a wait of exactly the budget is honoured, and one past it sends nothing and claims no retries", async (c) => {
	const exact = await statedWaitChain(c, [3600]);
	deepStrictEqual(exact.delays, [RATE_LIMIT_WAIT_BUDGET_MS]);
	strictEqual(exact.last?.phase, "recovered");
	c.mock.timers.reset();
	const past = await statedWaitChain(c, [7200]);
	deepStrictEqual(past.delays, []);
	strictEqual(past.sent, 0);
	strictEqual(past.last?.attempt, 0);
	match(formatRetryStatus(past.last as RetryStatusPayload), /provider asked to wait 2h, and Clio waits at most 1h/u);
	doesNotMatch(formatRetryStatus(past.last as RetryStatusPayload), /exhausted/u);
});

test("a long countdown reads in minutes on the rail and says the provider asked for it", () => {
	const now = 1_000_000;
	const status = (width: number) =>
		composerPhasePresentation(
			{
				phase: "retrying",
				since: now - 1000,
				lastMeaningfulAt: now - 1000,
				watchdogTier: 0,
				watchdogPeak: 0,
				localRuntime: false,
				retry: {
					attempt: 1,
					maxAttempts: 3,
					waitMs: 3_412_000,
					stage: "backoff",
					dueAt: now + 3_412_000,
					retryAfterMs: 3_600_000,
				},
			} as never,
			width,
			now,
			"Qwopus3.8",
		).label;
	match(status(111), /in 56m52s · provider asked for 1h · Esc cancels/u);
	match(status(80), /provider wait 56m52s · Esc cancels/u);
	doesNotMatch(status(111), /3412s/u);
});

test("formatStatedWait uses the units a person plans by", () => {
	deepStrictEqual([48_000, 60_000, 3_412_000, 3_600_000, 5_400_000, 7_200_000].map(formatStatedWait), [
		"48s",
		"1m",
		"56m52s",
		"1h",
		"1h30m",
		"2h",
	]);
});

test("Pi's fail-fast text for a wait past its cap still names the wait", () => {
	strictEqual(statedRetryWaitMs(null, "Server requested 7200s retry delay (max: 5s). 429 slow down"), 7_200_000);
	strictEqual(statedRetryWaitMs(null, "429 quota exceeded, retry-after: 60"), null);
	strictEqual(statedRetryWaitMs(null, "400 bad request, retry-after: 60"), null);
});

test("a run reads as no answer only when nothing answers it and a run with real work ending quietly stays apart", () => {
	const markup = '<tool_call>\n{"name": "edit", "arguments": {}}\n</tool_call>';
	const reply = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason }) as never;
	const thinking = (text: string) => ({ type: "thinking", thinking: text });
	const text = (value: string) => ({ type: "text", text: value });
	const worked = { role: "toolResult", toolName: "bash", isError: false } as never;
	const failed = { role: "toolResult", toolName: "bash", isError: true } as never;
	const cause = (messages: never[]) => {
		const ending = classifyTurnEnding(messages);
		return ending?.kind === "no_answer" ? ending.cause : (ending?.kind ?? null);
	};

	strictEqual(cause([reply([thinking(`Now the edit. ${markup}`)])]), "tool_call_in_reasoning");
	strictEqual(cause([worked, reply([thinking(markup)])]), "tool_call_in_reasoning");
	strictEqual(cause([reply([text(markup)])]), "tool_call_as_text");
	strictEqual(cause([reply([thinking("Nothing further to add.")])]), "reasoning_only");
	strictEqual(cause([reply([])]), "empty");
	strictEqual(cause([failed, reply([])]), "empty");
	strictEqual(cause([worked, reply([])]), "quiet");
	// Reasoning may quote markup on the way to a real answer, and prose may quote it too.
	strictEqual(cause([reply([thinking(markup), text("Fixed it.")])]), null);
	strictEqual(cause([reply([text(`The model wrote ${markup} here.`)])]), null);
	// Every other stop has its own report.
	strictEqual(cause([reply([], "length")]), null);
	strictEqual(cause([reply([], "error")]), null);
	strictEqual(cause([reply([{ type: "toolCall", id: "a", name: "bash", arguments: {} }], "toolUse")]), null);
});

test("a no-answer receipt says why, with or without usage, and never wears the green check", () => {
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "<tool_call>\n{}\n</tool_call>" }],
		stopReason: "stop",
	};
	const panel = createChatPanel({ now: () => 1_000 });
	panel.appendUser("fix it");
	panel.applyEvent({ type: "agent_start" } as never);
	panel.applyEvent({ type: "message_start", message } as never);
	panel.applyEvent({ type: "message_end", message } as never);
	panel.applyEvent({ type: "agent_end", messages: [message] } as never);
	const output = screen(panel);
	doesNotMatch(output, /✓/u);
	match(output, /No answer/u);
	match(output, /into its reasoning/u);
	strictEqual(
		buildSummary({
			startedAt: 0,
			endedAt: 1,
			modelId: "m",
			targetId: "t",
			messages: [message] as never,
			watchdogPeak: 0,
			cancelled: false,
		}).stopReason,
		"no_answer",
	);
});

test("each provider failure names its own way out", () => {
	const route = { targetId: "gw", url: "http://gw.test:4000" };
	const refused = providerFailureAdvice({ ...route, stage: "auth", errorClass: "http_401" });
	match(refused, /^clio-coder configure --id gw replaces it/u);
	const cut = providerFailureAdvice({ ...route, stage: "transport", errorClass: "stream_dropped", partialReply: true });
	match(cut, /Up recalls your message, Enter resends/u);
	match(cut, /The model will not see the partial reply\./u);
	doesNotMatch(cut, /configure/u);
	doesNotMatch(providerFailureAdvice({ ...route, stage: "provider", errorClass: "http_503" }), /configure/u);
	match(providerFailureAdvice(route), /clio-coder configure --id gw edits this target/u);
});

test("a provider failure leads with a plain sentence and the rail gives the block's way out", () => {
	const route = { targetId: "gw", url: "http://gw.test:4000" };
	const dropped = { ...route, stage: "transport", errorClass: "stream_dropped", partialReply: true };
	strictEqual(providerFailureHeadline(dropped), "The connection dropped before the reply finished.");
	strictEqual(providerFailureRailFacts(dropped)?.cause.text, "connection dropped");
	const refused = { ...route, stage: "auth", errorClass: "http_401" };
	strictEqual(providerFailureHeadline(refused), "The provider refused the credential.");
	strictEqual(providerFailureRailFacts(refused)?.way?.text, "clio-coder configure --id gw");
	match(
		providerFailureEvidence(refused, '401 {"error":{"message":"bad key"}}'),
		/gw at http:\/\/gw\.test:4000 · HTTP 401; bad key/u,
	);
	strictEqual(providerFailureHeadline({ ...route, stage: "admission", errorClass: "admission_refused" }), null);
	doesNotMatch(presentProviderError("Provider stream ended before a finish reason was received."), /finish reason/u);
});

test("what just happened borrows the footer slot from a standing warning, never from an error", () => {
	const notice = (
		id: string,
		level: Notification["level"],
		addedAt: number,
		expiresAt: number | null,
	): Notification => ({
		id,
		key: null,
		level,
		text: id,
		addedAt,
		expiresAt,
	});
	const standing = notice("standing", "warning", 1_000, 121_000);
	const applied = notice("applied", "success", 5_000, 17_000);
	strictEqual(topNotification([standing, applied], 6_000)?.id, "applied");
	strictEqual(topNotification([standing, applied], 18_000)?.id, "standing");
	strictEqual(topNotification([standing, notice("older", "info", 500, 12_000)], 6_000)?.id, "standing");
	strictEqual(topNotification([standing, notice("tip: keys", "info", 5_000, 17_000)], 6_000)?.id, "standing");
	strictEqual(topNotification([notice("fault", "error", 1_000, null), applied], 6_000)?.id, "fault");
});

function manualWindows(denyResult = true) {
	let at = 0;
	const timers = new Map<number, { fire: () => void; dueAt: number }>();
	let nextId = 0;
	const denials: string[] = [];
	const windows = createWorkerApprovalWindows({
		now: () => at,
		setTimer: (callback, ms) => {
			nextId += 1;
			timers.set(nextId, { fire: callback, dueAt: at + ms });
			return nextId;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
	});
	return {
		windows,
		denials,
		open(requestId: string, windowMs = 120_000): void {
			windows.open({
				runId: "run",
				agentId: "coder",
				requestId,
				windowMs,
				fallback: "deny",
				deny: () => {
					denials.push(requestId);
					return denyResult;
				},
			});
		},
		advance(ms: number): void {
			at += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.dueAt > at) continue;
				timers.delete(id);
				timer.fire();
			}
		},
	};
}

test("a parent-owned worker window answers with a timeout at its end, and a late answer is known to be late", () => {
	const rig = manualWindows();
	rig.open("ask");
	rig.advance(119_000);
	deepStrictEqual(rig.denials, []);
	strictEqual(rig.windows.read("ask")?.remainingMs, 1_000);
	rig.advance(1_000);
	deepStrictEqual(rig.denials, ["ask"]);
	ok(rig.windows.isExpired("ask"), "an answer racing the denial reaches nothing");
	rig.windows.settle("ask");
	strictEqual(rig.windows.read("ask"), null);
});

test("a key holds a worker window until its ceiling, not forever, and the worker's backstop sits past that", () => {
	const rig = manualWindows();
	rig.open("ask");
	rig.advance(60_000);
	ok(rig.windows.hold("ask"));
	strictEqual(rig.windows.hold("ask"), false, "a second key cannot extend it");
	const held = rig.windows.read("ask");
	strictEqual(held?.held, true);
	strictEqual(held?.remainingMs, WORKER_APPROVAL_HOLD_CEILING_MS - 60_000);
	rig.advance(WORKER_APPROVAL_HOLD_CEILING_MS - 61_000);
	deepStrictEqual(rig.denials, [], "still held past the window it was given");
	rig.advance(1_000);
	deepStrictEqual(rig.denials, ["ask"]);
	ok(workerApprovalBackstopMs(120_000) > WORKER_APPROVAL_HOLD_CEILING_MS);
	ok(workerApprovalBackstopMs(3_600_000) > 3_600_000, "a window past the ceiling still ends before the backstop");
});

test("an answered worker ask cannot be denied by its window afterwards", () => {
	const rig = manualWindows();
	rig.open("ask");
	rig.windows.settle("ask");
	rig.advance(WORKER_APPROVAL_HOLD_CEILING_MS);
	deepStrictEqual(rig.denials, []);
});

test("a queued worker ask starts its window again when the person shows up, never past its ceiling", () => {
	const rig = manualWindows();
	rig.open("queued");
	rig.advance(100_000);
	ok(rig.windows.restart("queued"));
	strictEqual(rig.windows.read("queued")?.remainingMs, 120_000);
	rig.advance(100_000);
	deepStrictEqual(rig.denials, []);
	ok(rig.windows.hold("queued"));
	strictEqual(rig.windows.restart("queued"), false, "a held window is not restarted");
});

test("only a denial on the permission_decision line can carry the timeout cause", () => {
	const demux = createWorkerStdinDemux();
	const seen: unknown[] = [];
	demux.feed(`${JSON.stringify({ not: "a spec" })}\n`);
	demux.readSpec().catch(() => {});
	demux.onPermissionDecision((decision) => seen.push(decision));
	demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "a", decision: "deny", cause: "timeout" })}\n`);
	demux.feed(
		`${JSON.stringify({ type: "permission_decision", requestId: "b", decision: "approve", cause: "timeout" })}\n`,
	);
	demux.feed(`${JSON.stringify({ type: "permission_decision", requestId: "c", decision: "deny" })}\n`);
	deepStrictEqual(seen, [
		{ requestId: "a", decision: "deny", cause: "timeout" },
		{ requestId: "b", decision: "approve" },
		{ requestId: "c", decision: "deny" },
	]);
});

test("a worker's wait states when it ends, what happens then, and that it is held", () => {
	const fold = createWorkerProgressFold();
	fold.observe({ type: "clio_coder_permission_escalated", payload: { requestId: "ask", tool: "bash" } });
	strictEqual(workerActivityWords(fold.snapshot()), "waiting for your approval", "no window, no claimed end");
	fold.observe({
		type: "clio_coder_permission_window",
		payload: { requestId: "ask", held: false, expiresAt: 119_000, fallback: "deny" },
	});
	strictEqual(workerActivityWords(fold.snapshot(), { now: 0 }), "waiting for your approval · denied in 1:59");
	strictEqual(workerActivityWords(fold.snapshot(), { now: 0, room: 30 }), "your approval · denied in 1:59");
	fold.observe({
		type: "clio_coder_permission_window",
		payload: { requestId: "ask", held: true, expiresAt: 822_000, fallback: "fail" },
	});
	strictEqual(workerActivityWords(fold.snapshot(), { now: 0 }), "waiting for your approval · held · run fails in 13:42");
	fold.observe({ type: "clio_coder_permission_resolved", payload: { requestId: "ask", tool: "bash" } });
	strictEqual(fold.snapshot().approvalWindow, undefined);
	strictEqual(fold.snapshot().awaitingApproval, undefined);
});

test("a worker card with a parent-owned window offers the hold, then says it is held and when it still ends", () => {
	const view: ApprovalRequestView = {
		requestId: "req",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "default" },
		origin: { kind: "worker", agentId: "coder", runId: "run" },
		reason: "bash needs approval",
	};
	const card = (window: { remainingMs: number; held: boolean } | null, seen: ApprovalRequestView = view): string =>
		createPermissionOverlayBody(
			seen,
			undefined,
			undefined,
			undefined,
			() => (window === null ? 119_000 : null),
			undefined,
			undefined,
			() => window,
		)
			.render(200)
			.map((row) => stripTerminalSequences(row))
			.join("\n");
	match(card({ remainingMs: 119_000, held: false }), /No answer in 1:59 denies this call.*Any key holds the card\./u);
	const held = card({ remainingMs: 822_000, held: true });
	match(held, /Timer held\. No answer in 13:42 denies this call/u);
	doesNotMatch(held, /Any key holds/u);
	match(card(null), /No key pauses this\./u, "a window inside the worker makes no promise a key can keep");
	const owned = card(null, { ...view, origin: { kind: "worker", agentId: "coder", runId: "run", endsWithTurn: true } });
	match(owned, /ends the main turn, which also stops this worker/u);
});

test("a key on a worker card holds that ask, restarts the ones queued behind it, and the expiry says it was held", () => {
	const bus = createTelemetryHub();
	const holds: string[] = [];
	const restarts: string[] = [];
	const notices: string[] = [];
	const windows = new Map([
		[
			"first",
			{
				held: false,
				remainingMs: 100_000,
				ceilingMs: 900_000,
				ceilingRemainingMs: 880_000,
				fallback: "deny" as const,
				decider: "operator" as const,
			},
		],
		[
			"second",
			{
				held: false,
				remainingMs: 90_000,
				ceilingMs: 900_000,
				ceilingRemainingMs: 870_000,
				fallback: "deny" as const,
				decider: "operator" as const,
			},
		],
	]);
	const readers: Array<() => { remainingMs: number; held: boolean } | null> = [];
	let state: OverlayState = "closed";
	const lifecycle = createOverlayPermissionLifecycle({
		bus,
		dispatch: {
			workerPermissionWindow: (requestId) => windows.get(requestId) ?? null,
			holdWorkerPermission: (requestId) => {
				holds.push(requestId);
				const window = windows.get(requestId);
				if (window !== undefined) windows.set(requestId, { ...window, held: true });
				return true;
			},
			restartWorkerPermission: (requestId) => {
				restarts.push(requestId);
				return true;
			},
		},
		getAutonomy: () => "default",
		getOverlayState: () => state,
		openPermissionOverlay: (_view, _inspect, _invocation, _advisory, _countdown, workerWindow) => {
			if (state === "permission-confirm") return false;
			state = "permission-confirm";
			if (workerWindow !== undefined) readers.push(workerWindow);
			return true;
		},
		closeOverlay: () => {
			if (state !== "permission-confirm") return;
			state = "closed";
			lifecycle.onPermissionOverlayClosed();
		},
		appendNotice: (_level, text) => {
			notices.push(text);
		},
		applyApprovalState: () => {},
		requestRender: () => {},
		stopActiveTurn: () => {},
	});
	const ask = (requestId: string, runId: string): void => {
		bus.emit("approval.requested", {
			tool: "bash",
			actionClass: "execute",
			requestId,
			requestedBy: runId,
			origin: `worker:${runId}`,
			agentId: "coder",
			timeoutMs: 120_000,
			fallback: "deny",
			escalation: true,
		});
	};
	ask("first", "run-a");
	ask("second", "run-b");
	deepStrictEqual(readers[0]?.(), { remainingMs: 100_000, held: false });
	lifecycle.notePresence();
	deepStrictEqual(holds, ["first"]);
	deepStrictEqual(restarts, ["second"]);
	strictEqual(readers[0]?.()?.held, true);
	bus.emit("approval.resolved", {
		status: "denied",
		requestId: "first",
		decidedBy: "timeout",
		fallback: "deny",
		at: 0,
	} as never);
	match(notices.at(-1) ?? "", /nobody answered in the 15m(?:0s)? it was held/u);
	lifecycle.dispose();
});

test("the rail beside a worker's ask states its expiry, and a short rail keeps the time before the words", () => {
	const progress = {
		phase: "tool",
		currentAction: null,
		awaitingApproval: true,
		approvalWindow: { expiresAt: 119_000, held: false, fallback: "deny", decider: "operator" },
	} as unknown as WorkerProgressSnapshot;
	const facts = (width: number) =>
		railDetail(
			{
				actor: "Judge-model",
				status: INITIAL_STATUS,
				workers: [{ agentId: "coder", status: "running", progress } as DispatchBoardRow],
				workerActivity: (row, room) => workerActivityWords(row.progress ?? progress, { now: 0, room }),
				background: [],
				now: 0,
			},
			width,
		);
	match(facts(100) ?? "", /^coder waiting for your approval · denied in 1:59/u);
	match(facts(40) ?? "", /^coder your approval · denied in 1:59/u);
});

test("a route pick says what it does to the running turn, and only what is still true", () => {
	match(modelListTurnEffect("first-output") ?? "", /moves the waiting request/u);
	match(modelListTurnEffect("retry-wait") ?? "", /sends the request now/u);
	match(modelListTurnEffect("output") ?? "", /next turn, because output has started/u);
	match(modelListTurnEffect("tool") ?? "", /next turn, because a tool is running/u);
	strictEqual(modelListTurnEffect("idle"), null);
	const fits = { kind: "fits" } as const;
	match(routeTurnEffect("first-output", fits, "second") ?? "", /moves the waiting request to second/u);
	match(routeTurnEffect("retry-wait", fits, "second") ?? "", /sends the request to second/u);
	// Output arriving while the dialog is open changes the line, whatever the route's size.
	match(routeTurnEffect("output", fits, "second") ?? "", /next turn, because output has started/u);
	match(
		routeTurnEffect("first-output", { kind: "too-large", neededTokens: 13000, window: 8000 }, "small") ?? "",
		/next turn, because this conversation needs about 13k tokens and that model's window is 8k/u,
	);
	strictEqual(routeTurnEffect("first-output", { kind: "same" }, "same"), null);
	strictEqual(routeTurnEffect("idle", fits, "second"), null);
});

test("a moved request reads as a move, and the same model on another target names the targets", () => {
	const movedFrom = { targetId: "a", modelId: "lab/first-model" };
	const movedTo = { targetId: "b", modelId: "lab/second-model" };
	const moved = { phase: "moved", attempt: 1, maxAttempts: 1, movedFrom, movedTo } as const;
	strictEqual(
		formatRetryStatus({ ...moved, movedAborted: true }),
		"moved to Second-model · First-model had sent no output",
	);
	strictEqual(
		formatRetryStatus({ ...moved, movedAborted: false }),
		"moved to Second-model instead of waiting on First-model",
	);
	strictEqual(
		formatRetryStatus({ ...moved, movedTo: { targetId: "b", modelId: movedFrom.modelId }, movedAborted: true }),
		"moved to b · a had sent no output",
	);
});

/** A ladder whose agent answers at once, for what a pick does to it. */
function movableLadder(retries: { enabled: boolean; maxRetries: number }) {
	let sent = 0;
	const runtime = {
		runtimeId: "openai-compat",
		runtimeResolution: { contextWindowDetails: { effectiveContextWindow: 131072 } },
		agent: {
			state: { messages: [] as unknown[], errorMessage: undefined as string | undefined },
			async continue() {
				sent += 1;
				this.state.messages.push({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
					timestamp: Date.now(),
				});
			},
		},
	} as unknown as AgentRuntime;
	const state = createTurnState();
	const statuses: RetryStatusPayload[] = [];
	const from = { targetId: "a", modelId: "first" };
	const to = { targetId: "a", modelId: "second" };
	let applied = 0;
	const recovery = createTurnRecovery({
		state,
		isYolo: () => false,
		turnIdentity: () => state,
		persistence: { appendRetryStatus() {}, wasPersisted: () => true } as unknown as TurnRecoveryDeps["persistence"],
		context: {} as unknown as TurnRecoveryDeps["context"],
		retrySettings: () => ({ ...DEFAULT_RETRY_SETTINGS, ...retries }),
		applyRouteMove: async () => {
			state.routeMove = null;
			applied += 1;
			return { from, to };
		},
		markPersistedUserEcho: async (_text, prompt) => prompt(),
		emitRetryStatus: (status) => {
			statuses.push(status);
		},
		emitFailureMessage() {},
		emitNotice() {},
	});
	return { recovery, runtime, state, statuses, sent: () => sent, applied: () => applied };
}

test("a pick during a stated wait goes now, on no wait of the old route's, and is no cancel or recovery", async () => {
	const ladder = movableLadder({ enabled: true, maxRetries: 3 });
	const errorMessage = "429 rate_limit_error: slow down";
	let done = false;
	void ladder.recovery
		.runTransientRetryChain(ladder.runtime, "request", {
			stopReason: "error",
			errorMessage,
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage,
				retryAfterMs: 3_000_000,
				timestamp: Date.now(),
			} as never,
		})
		.then(() => {
			done = true;
		});
	await nextLoop();
	strictEqual(ladder.recovery.inRetryWait(), true);
	ladder.state.routeMove = {} as never;
	ladder.recovery.cancelRetryCountdown();
	for (let tick = 0; !done && tick < 50; tick++) await nextLoop();
	strictEqual(done, true);
	strictEqual(ladder.sent(), 1);
	strictEqual(ladder.applied(), 1);
	deepStrictEqual(
		ladder.statuses.map((status) => status.phase).filter((phase) => phase !== "waiting"),
		["scheduled", "moved"],
	);
});

test("a moved request needs no retry budget and its aborted call forecasts no failure", async () => {
	const ladder = movableLadder({ enabled: false, maxRetries: 0 });
	ladder.state.routeMove = {} as never;
	const aborted = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "aborted to move this request",
		timestamp: Date.now(),
	} as never;
	ok(ladder.recovery.forecastRetry(ladder.runtime, aborted) !== null);
	const handled = await ladder.recovery.runTransientRetryChain(ladder.runtime, "request", {
		stopReason: "error",
		errorMessage: "aborted to move this request",
		message: aborted,
	});
	strictEqual(handled, true);
	strictEqual(ladder.sent(), 1);
	deepStrictEqual(
		ladder.statuses.map((status) => status.phase),
		["moved"],
	);
});

test("the hint row says what Enter does with the draft and never offers exit or a key with no target", () => {
	const hint = (context: Parameters<typeof footerKeyHint>[3], now = 0): string =>
		footerKeyHint(now, false, Number.POSITIVE_INFINITY, context, { queued: 0, workers: 0, thinkingCycles: false }) ?? "";
	match(hint("run-command:/rewind"), /Enter runs \/rewind · Esc stops the run$/u);
	doesNotMatch(hint("run-command:/rewind"), /steers/u);
	match(hint("shell-refused"), /Esc stops what is running, then Enter runs this/u);
	match(hint("steer-empty"), /^Type to steer · Esc stops the run/u);
	const learned = Array.from({ length: 12 }, (_, slot) => hint("idle", slot * 60_000)).join("\n");
	doesNotMatch(learned, /Exit|Suspend|Music|Files pane|Thinking effort/u);
	strictEqual(hint("idle", 0), hint("idle", 59_999), "a learning hint holds for its minute");
	strictEqual(hint("send", 0), hint("send", 600_000), "a draft silences the learning");
	const running = Array.from({ length: 12 }, (_, slot) => hint("steer-empty", slot * 60_000)).join("\n");
	doesNotMatch(running, /Workers dock|Queue navigator|Send now/u);
});

test("a cancelled interview ends the turn as cancelled, not as a success", () => {
	strictEqual(
		buildSummary({
			startedAt: 0,
			endedAt: 1,
			modelId: "m",
			targetId: "t",
			messages: [
				{ role: "assistant", stopReason: "toolUse", content: [], usage: {} },
				{ role: "toolResult", toolName: "ask_user", details: { cancelled: true }, content: [] },
			] as never,
			watchdogPeak: 0,
			cancelled: false,
		}).stopReason,
		"cancelled",
	);
});

test("a brokered ask's window hands the person the whole time, and running out says it timed out", () => {
	const fired: Array<() => void> = [];
	const delivered: Array<{ decision: string; cause: string | undefined }> = [];
	let at = 0;
	const broker = createGrantBroker({
		now: () => 1_000,
		deliver: (_record, decision, _reason, cause) => {
			delivered.push({ decision, cause });
			return true;
		},
	});
	const opened = broker.open({
		workerRequestId: "ask",
		runId: "run",
		rootRunId: "run",
		attempt: 0,
		attemptToken: "token",
		ownerSessionId: null,
		agentId: "coder",
		tool: "bash",
		actionClass: "execute",
		approvalAuthority: "main",
		argDigest: grantEffectDigest({ tool: "bash", args: { command: "true" } }),
		effect: { tool: "bash", args: { command: "true" } },
		cwd: "/w",
		permitTools: ["bash"],
		summary: "bash",
		reasons: [],
		deadlineAt: 900_000,
		windowMs: 20_000,
	});
	if (!opened.ok) throw new Error(opened.reason);
	const requestId = opened.record.requestId;
	const windows = createWorkerApprovalWindows({
		now: () => at,
		setTimer: (callback) => {
			fired.push(callback);
			return fired.length;
		},
		clearTimer: () => {},
	});
	windows.open({
		runId: "run",
		agentId: "coder",
		requestId,
		windowMs: 20_000,
		fallback: "fail",
		decider: "judge",
		deny: () => {
			broker.expire(requestId);
			return true;
		},
	});
	strictEqual(windows.read(requestId)?.decider, "judge");
	at = 15_000;
	strictEqual(windows.handToOperator(requestId), true);
	strictEqual(windows.read(requestId)?.decider, "operator");
	strictEqual(windows.read(requestId)?.remainingMs, 20_000, "the judge's time is not taken from the person");
	fired.at(-1)?.();
	deepStrictEqual(delivered, [{ decision: "deny", cause: "timeout" }]);
	strictEqual(broker.get(requestId)?.state, "expired");
	broker.dispose();
	windows.dispose();
});

test("a wait names who it is on and keeps its time left as the room shrinks", () => {
	const words = (
		decider: "operator" | "main" | "judge",
		room?: number,
		held = false,
		fallback: "deny" | "fail" = "fail",
	) =>
		approvalWaitWords(
			{ approvalWindow: { expiresAt: 119_000, held, fallback, decider } },
			{ now: 0, ...(room === undefined ? {} : { room }) },
		);
	strictEqual(words("operator"), "waiting for your approval · run fails in 1:59");
	strictEqual(words("operator", 34), "your approval · run fails in 1:59");
	strictEqual(words("operator", 26), "asks you · fails in 1:59");
	strictEqual(words("operator", 13), "fails in 1:59");
	strictEqual(words("operator", 20, true), "held · fails in 1:59");
	strictEqual(words("operator", 14, true), "fails in 1:59");
	strictEqual(words("judge", 80, false, "deny"), "waiting for the safety judge · denied in 1:59");
	strictEqual(words("main", 80, false, "deny"), "waiting for the main agent · denied in 1:59");
});

test("a run's list row and a credentialed call's title say only what is known", () => {
	const summary = (axes: Partial<TrustSummaryProjection["axes"]>, verdict: TrustSummaryProjection["verdict"]) =>
		({ verdict, axes }) as Pick<TrustSummaryProjection, "verdict" | "axes">;
	strictEqual(trustFailureWords(summary({ validationGrounding: "failed" }, "compromised")), "validation failed");
	strictEqual(trustFailureWords(summary({ validationGrounding: "absent" }, "unverified")), null);
	strictEqual(outwardShellReason("gh pr list"), "gh reads with your credentials");
	strictEqual(outwardShellReason("gh pr merge 3"), "gh acts with your credentials");
	strictEqual(outwardShellReason("gh api repos/o/r/issues"), "gh acts with your credentials");
	strictEqual(credentialedCallKind(["gh reads with your credentials"]), "reads with your credentials");
	strictEqual(credentialedCallKind(["gh acts with your credentials"]), "uses your credentials");
	strictEqual(credentialedCallKind(["Publishes to origin"]), null);
});

test("a person's /run refused beside the main turn says why without a deadlock or a model's remedy", () => {
	const detail =
		foregroundEndpointBlock({
			endpointKey: "http://127.0.0.1:1",
			operatorStarted: true,
			limits: { endpoints: { "http://127.0.0.1:1": 1 } },
			usage: {
				endpoints: { "http://127.0.0.1:1": 1 },
				endpointHolders: {
					"http://127.0.0.1:1": { foregroundStreams: 1, workers: 0, background: 0 } as never,
				},
			},
		} as never) ?? "";
	match(detail, /the main turn is using the only slot/u);
	strictEqual(detail.includes("deadlock"), false);
});
