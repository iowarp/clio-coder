import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	applyModelAdmission,
	type ModelAdmissionEvent,
	type ModelAdmissionWait,
} from "../../src/core/model-admission.js";
import {
	createWorkerApprovalWindows,
	WORKER_APPROVAL_HOLD_CEILING_MS,
	workerApprovalBackstopMs,
} from "../../src/domains/dispatch/worker-approval-window.js";
import { mainCallExposure } from "../../src/domains/safety/call-consequence.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { retryWaitCause } from "../../src/domains/session/retry.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import { markClioLoaded, reconcileResidency } from "../../src/engine/apis/residency.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { composerPhasePresentation } from "../../src/interactive/footer/widgets.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	permissionRailTitle,
} from "../../src/interactive/permission-overlay.js";
import { reduceStatus, type StatusInputEvent } from "../../src/interactive/status/index.js";
import { workerActivityWords } from "../../src/interactive/worker-activity.js";
import {
	type AgentStatus,
	INITIAL_STATUS,
	type ModelRequestFacts,
	type RetryOverlay,
} from "../../src/session-control/status-types.js";
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
			if (width >= 80) ok(label.includes("then /model"), rail);
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
	strictEqual(workerActivityWords(fold.snapshot(), { now: 0, narrow: true }), "your approval · denied in 1:59");
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
