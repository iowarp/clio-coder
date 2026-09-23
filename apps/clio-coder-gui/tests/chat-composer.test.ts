import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capabilityRefusal,
	composerKeyAction,
	DEFAULT_STEER_MODE,
	type Draft,
	DraftStore,
	draftStore,
	MAX_DRAFT_STORES,
	messageActionOffers,
	NO_STEERING,
	noticeForError,
	noticeForRefusal,
	PROMPT_TEXT_MAX_CHARACTERS,
	projectQueue,
	queueSummary,
	resetDraftStores,
	restoredDraft,
	type SteeringAffordances,
	steeringAffordances,
	steerModeOffers,
	submitIntent,
	submitLabel,
	turnOutcome,
	usageSummary,
	usageTitle,
} from "../client/chat/composer.js";
import type { KeyEventLike } from "../client/interaction/keybindings.js";
import type { AgentCapabilities } from "../contracts/capabilities.js";
import type { Turn, Usage } from "../contracts/sessions.js";
import { STEER_TEXT_MAX_BYTES } from "../contracts/steering.js";

function keys(): () => string {
	let next = 0;
	return () => {
		next += 1;
		return `key-${next}`;
	};
}

const FULL_STEERING: SteeringAffordances = {
	steer: true,
	modes: ["next-slot", "end-of-turn"],
	interrupt: true,
	queue: true,
	dispatch: true,
};

function situation(overrides: Partial<Parameters<typeof submitIntent>[1]> = {}) {
	return {
		sessionState: "open" as const,
		turnRunning: false,
		sending: false,
		steering: FULL_STEERING,
		...overrides,
	};
}

function draft(overrides: Partial<Draft> = {}): Draft {
	return { text: "explain this repository", mode: DEFAULT_STEER_MODE, key: "key-1", ...overrides };
}

function press(key: string, held: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike {
	return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held };
}

// --- the draft store -------------------------------------------------------

test("the idempotency key survives typing and a retry, and moves only when the draft is cleared", () => {
	const store = new DraftStore(keys());
	const first = store.snapshot().key;
	store.write("map the project");
	store.write("map the project carefully");
	assert.equal(store.snapshot().key, first, "typing minted a new key, so a double send would make two turns");
	store.write("");
	assert.equal(store.snapshot().key, first, "emptying the field is not the same as clearing the draft");
	store.clear();
	const second = store.snapshot().key;
	assert.notEqual(second, first);
	store.write("map the project carefully");
	assert.equal(store.snapshot().key, second, "a retry fill re-uses the cleared draft's key");
});

test("the store notifies only on a real change, so a no-op keystroke does not re-render", () => {
	const store = new DraftStore(keys());
	let notifications = 0;
	const unsubscribe = store.subscribe(() => {
		notifications += 1;
	});
	store.write("a");
	store.write("a");
	store.chooseMode(DEFAULT_STEER_MODE);
	store.chooseMode("end-of-turn");
	assert.equal(notifications, 2);
	unsubscribe();
	store.write("b");
	assert.equal(notifications, 2);
});

test("drafts are kept per session, returned identically, and capped", () => {
	resetDraftStores();
	const one = draftStore("session-a");
	one.write("held across a navigation");
	assert.equal(draftStore("session-a").snapshot().text, "held across a navigation");
	assert.notEqual(draftStore("session-b"), one);
	for (let index = 0; index < MAX_DRAFT_STORES; index += 1) draftStore(`filler-${index}`);
	assert.equal(draftStore("session-a").snapshot().text, "", "the oldest store should have been evicted, not reused");
	resetDraftStores();
});

// --- capabilities ----------------------------------------------------------

test("an engine that announced nothing offers no steering control at all", () => {
	const older: AgentCapabilities = { loadSession: false, mediatedTools: false };
	assert.deepEqual(steeringAffordances(older), NO_STEERING);
	assert.deepEqual(steeringAffordances(undefined), NO_STEERING);
	assert.deepEqual(steerModeOffers(NO_STEERING), []);
});

test("an announced steering capability is projected mode by mode and never invented", () => {
	const announced: AgentCapabilities = {
		loadSession: true,
		mediatedTools: true,
		steering: {
			version: 1,
			main: true,
			dispatch: false,
			modes: ["next-slot", "sideways"],
			interrupt: true,
			methods: { steer: "s", queue: "q", clear: "c", interrupt: "i", dispatch: "d" },
		},
	};
	const affordances = steeringAffordances(announced);
	assert.deepEqual(affordances.modes, ["next-slot"], "an unknown mode must not reach the wire");
	assert.equal(affordances.steer, true);
	assert.equal(affordances.dispatch, false);
	assert.equal(affordances.queue, true);
	const offers = steerModeOffers(affordances);
	assert.equal(offers.length, 1);
	assert.match(offers[0]?.lands ?? "", /still running/);
});

test("a build with the steering member but no steer queue does not offer a steer", () => {
	const announced: AgentCapabilities = {
		loadSession: true,
		mediatedTools: true,
		steering: {
			version: 1,
			main: false,
			dispatch: true,
			modes: ["next-slot", "end-of-turn"],
			interrupt: true,
			methods: { steer: "s", queue: "q", clear: "c", interrupt: "i", dispatch: "d" },
		},
	};
	const affordances = steeringAffordances(announced);
	assert.equal(affordances.steer, false);
	assert.equal(affordances.interrupt, true, "interrupt is a separate announcement from the steer queue");
});

// --- the submit decision ---------------------------------------------------

test("an idle open session sends a prompt carrying the draft's key", () => {
	assert.deepEqual(submitIntent(draft(), situation()), {
		kind: "prompt",
		text: "explain this repository",
		idempotencyKey: "key-1",
	});
});

test("a running turn steers instead of blocking, in the mode the operator chose", () => {
	const intent = submitIntent(draft({ mode: "end-of-turn" }), situation({ turnRunning: true }));
	assert.deepEqual(intent, {
		kind: "steer",
		text: "explain this repository",
		mode: "end-of-turn",
		idempotencyKey: "key-1",
	});
	assert.equal(submitLabel(intent, situation({ turnRunning: true })), "Queue for after");
});

test("a chosen mode the engine did not announce falls back to one it did", () => {
	const only = { ...FULL_STEERING, modes: ["next-slot"] as const };
	const intent = submitIntent(draft({ mode: "end-of-turn" }), situation({ turnRunning: true, steering: only }));
	assert.equal(intent.kind === "steer" && intent.mode, "next-slot");
});

test("a running turn on a build without steering explains itself and keeps the draft", () => {
	const intent = submitIntent(draft(), situation({ turnRunning: true, steering: NO_STEERING }));
	assert.equal(intent.kind, "blocked");
	assert.match(intent.kind === "blocked" ? intent.reason : "", /Your draft is kept/);
});

test("a send already on the wire blocks the next one", () => {
	const intent = submitIntent(draft(), situation({ sending: true }));
	assert.deepEqual(intent, { kind: "blocked", reason: "The previous send is still on the wire." });
});

test("every non-open session state names itself rather than failing silently", () => {
	for (const state of ["starting", "unknown", "closed", "failed"] as const) {
		const intent = submitIntent(draft(), situation({ sessionState: state }));
		assert.equal(intent.kind, "blocked");
		assert.notEqual(intent.kind === "blocked" ? intent.reason : "", "");
	}
});

test("whitespace is never a message", () => {
	assert.deepEqual(submitIntent(draft({ text: "  \n\t " }), situation()), {
		kind: "blocked",
		reason: "Write a message first.",
	});
});

test("the composer refuses past the engine's own bounds rather than spending a round trip", () => {
	const overPrompt = draft({ text: "x".repeat(PROMPT_TEXT_MAX_CHARACTERS + 1) });
	const prompt = submitIntent(overPrompt, situation());
	assert.equal(prompt.kind, "blocked");
	assert.match(prompt.kind === "blocked" ? prompt.reason : "", /32,000/);
	const overSteer = draft({ text: "x".repeat(STEER_TEXT_MAX_BYTES + 1) });
	const steer = submitIntent(overSteer, situation({ turnRunning: true }));
	assert.equal(steer.kind, "blocked");
	assert.match(steer.kind === "blocked" ? steer.reason : "", /16,384/);
});

test("a multibyte steer is measured in bytes, the unit the engine bounds", () => {
	const text = "é".repeat(STEER_TEXT_MAX_BYTES - 1);
	const intent = submitIntent(draft({ text }), situation({ turnRunning: true }));
	assert.equal(intent.kind, "blocked", "two-byte characters must count twice");
});

test("the submit label promises what the send will actually do", () => {
	assert.equal(submitLabel(submitIntent(draft(), situation()), situation()), "Send");
	const running = situation({ turnRunning: true });
	assert.equal(submitLabel(submitIntent(draft(), running), running), "Send now");
	const blocked = situation({ turnRunning: true, steering: NO_STEERING });
	assert.equal(submitLabel(submitIntent(draft(), blocked), blocked), "Send");
});

// --- the Enter policy ------------------------------------------------------

test("Enter sends, Shift and Enter do not, and the declared chord still sends", () => {
	const idle = { layerOwned: false, composing: false };
	assert.equal(composerKeyAction(press("Enter"), idle), "send");
	assert.equal(composerKeyAction(press("Enter", { shiftKey: true }), idle), "newline");
	assert.equal(composerKeyAction(press("Enter", { ctrlKey: true }), idle), "send");
	assert.equal(composerKeyAction(press("Enter", { metaKey: true }), idle), "send");
	assert.equal(composerKeyAction(press("Enter", { altKey: true }), idle), "newline");
	assert.equal(composerKeyAction(press("a"), idle), "ignore");
});

test("the send key never fires while a dialog or the palette owns the layer, or mid-composition", () => {
	assert.equal(composerKeyAction(press("Enter"), { layerOwned: true, composing: false }), "newline");
	assert.equal(composerKeyAction(press("Enter", { ctrlKey: true }), { layerOwned: true, composing: false }), "newline");
	assert.equal(composerKeyAction(press("Enter"), { layerOwned: false, composing: true }), "newline");
});

// --- the queue -------------------------------------------------------------

test("the queue projects in the order the engine will read it and says when each lands", () => {
	const rows = projectQueue({ steer: ["check the tests first"], followUp: ["then write the note", "and stop"] });
	assert.deepEqual(
		rows.map((row) => [row.queue, row.position, row.text]),
		[
			["steer", 1, "check the tests first"],
			["follow-up", 1, "then write the note"],
			["follow-up", 2, "and stop"],
		],
	);
	assert.equal(new Set(rows.map((row) => row.id)).size, 3);
	assert.match(rows[0]?.lands ?? "", /between tool calls/);
	assert.match(rows[1]?.lands ?? "", /settled/);
});

test("an empty or absent queue reports nothing waiting rather than an empty list", () => {
	assert.deepEqual(projectQueue(undefined), []);
	assert.deepEqual(projectQueue(null), []);
	assert.equal(queueSummary([]), "Nothing is waiting.");
	assert.equal(
		queueSummary(projectQueue({ steer: ["a"], followUp: ["b", "c"] })),
		"1 waiting for the next tool call · 2 waiting for the turn to end.",
	);
});

test("clearing the queue puts the drained texts back in the draft without duplicating them", () => {
	assert.equal(restoredDraft("", ["first", "second"]), "first\n\nsecond");
	assert.equal(restoredDraft("already typed", ["already typed", "new"]), "already typed\n\nnew");
	assert.equal(restoredDraft("  ", ["  ", "only"]), "only");
	assert.ok(restoredDraft("x".repeat(PROMPT_TEXT_MAX_CHARACTERS), ["more"]).length <= PROMPT_TEXT_MAX_CHARACTERS);
});

// --- refusals --------------------------------------------------------------

test("a 409 reads as a refusal sentence, never as a failure", () => {
	const conflict = { problem: { status: 409, detail: "This Clio build does not expose mid-turn steering." } };
	assert.equal(capabilityRefusal(conflict), "This Clio build does not expose mid-turn steering.");
	assert.deepEqual(noticeForError(conflict), {
		tone: "warn",
		message: "This Clio build does not expose mid-turn steering.",
	});
	assert.equal(capabilityRefusal({ problem: { status: 500, detail: "boom" } }), null);
	assert.equal(capabilityRefusal(new Error("offline")), null);
	assert.deepEqual(noticeForError(new Error("offline")), { tone: "fail", message: "offline" });
	assert.equal(noticeForError(null), null);
});

test("a 200 that refused is reported, not swallowed", () => {
	assert.deepEqual(noticeForRefusal({ accepted: false, refusal: "the run is no longer accepting input" }), {
		tone: "warn",
		message: "the run is no longer accepting input",
	});
	assert.deepEqual(noticeForRefusal({ cancelled: false }), {
		tone: "warn",
		message: "The engine refused, and reported no reason.",
	});
	assert.equal(noticeForRefusal({ accepted: true }), null);
	assert.equal(noticeForRefusal(null), null);
});

// --- message actions -------------------------------------------------------

test("try again is offered only on a failed or stopped turn that recorded a prompt", () => {
	const retry = (status: Turn["status"], requestText: string | null) =>
		messageActionOffers({ requestText, responseText: "done", status }).find((offer) => offer.id === "retry");
	assert.equal(retry("failed", "do it")?.available, true);
	assert.equal(retry("cancelled", "do it")?.available, true);
	assert.equal(retry("succeeded", "do it")?.available, false);
	assert.equal(retry("running", "do it")?.available, false);
	assert.equal(retry("failed", null)?.available, false);
	assert.match(retry("succeeded", "do it")?.unavailable ?? "", /failed or stopped/);
});

test("copy is offered only for text that exists", () => {
	const offers = messageActionOffers({ requestText: "   ", responseText: "", status: "succeeded" });
	assert.deepEqual(
		offers.map((offer) => [offer.id, offer.available]),
		[
			["copy-request", false],
			["copy-response", false],
			["retry", false],
		],
	);
	for (const offer of offers) assert.notEqual(offer.unavailable, null);
});

// --- the outcome footer ----------------------------------------------------

const usage: Usage = { input: 12345, output: 678, cacheRead: 90, cacheWrite: 1, reasoning: 234 };

function turn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: "turn-1",
		prompt: "explain this repository",
		origin: "live",
		status: "succeeded",
		startedAt: "2026-09-20T10:00:00.000Z",
		finishedAt: "2026-09-20T10:00:12.000Z",
		stopReason: "end_turn",
		usage,
		problem: null,
		...overrides,
	};
}

test("usage shows two numbers and carries five in the tooltip", () => {
	assert.equal(usageSummary(usage), "12,345 in · 678 out");
	assert.equal(usageTitle(usage), "input 12,345 · output 678 · cache read 90 · cache write 1 · reasoning 234");
});

test("a completed turn footer carries its reported tool count and spend, and nothing else", () => {
	const view = turnOutcome(turn(), 3);
	assert.equal(view.tone, "success");
	assert.equal(view.label, "Turn complete");
	assert.deepEqual(view.facts, ["3 tool calls", "tokens 12,345 in · 678 out"]);
	assert.equal(view.usage, usage, "the full reported accounting stays reachable from the compact outcome");
	assert.equal(view.detail, null);
	assert.equal(view.stopReason, null, "a stop reason on a successful turn is noise");
	assert.deepEqual(turnOutcome(turn(), 1).facts[0], "1 tool call");
	const withoutUsage = turnOutcome(turn({ usage: null }), 0);
	assert.deepEqual(withoutUsage.facts, []);
	assert.equal(withoutUsage.usage, null);
});

test("a failed turn shows its problem detail and its stop reason; a stopped one is not a failure", () => {
	const failed = turnOutcome(
		turn({
			status: "failed",
			stopReason: "refusal",
			problem: {
				type: "urn:clio-coder:problem:upstream_acp",
				title: "Upstream refused",
				status: 409,
				code: "upstream_acp",
				detail: "the target refused the request",
				instance: "session",
			},
		}),
		0,
	);
	assert.equal(failed.tone, "fail");
	assert.equal(failed.detail, "the target refused the request");
	assert.equal(failed.stopReason, "refusal");
	const stopped = turnOutcome(turn({ status: "cancelled", problem: null }), 0);
	assert.equal(stopped.tone, "warn");
	assert.equal(stopped.label, "Turn stopped");
	assert.equal(stopped.stopReason, null);
	assert.equal(turnOutcome(turn({ status: "running", usage: null, finishedAt: null }), 0).tone, "running");
});
