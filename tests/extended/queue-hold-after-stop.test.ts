import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnQueues, type QueuedChatMessage } from "../../src/session-control/turn-queues.js";
import { type ChatTurnState, ContinuationState } from "../../src/session-control/turn-state.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function fixture() {
	const steered: string[] = [];
	const agent = {
		steer: (message: { content: string }) => steered.push(message.content),
		followUp: (message: { content: string }) => steered.push(message.content),
		clearAllQueues: () => {},
	};
	const state = { streaming: true, runtime: { agent }, continuation: new ContinuationState() };
	const held: number[] = [];
	const notices: string[] = [];
	const dropped: string[][] = [];
	const submitted: Array<{ text: string; queued?: QueuedChatMessage }> = [];
	const queues = createTurnQueues({
		state: state as unknown as ChatTurnState,
		emitQueueUpdateEvent: () => {},
		emitQueuedUserTurn: () => {},
		emitNotice: (text) => notices.push(text),
		emitQueueHeld: (count) => held.push(count),
		emitQueueDropped: (texts) => dropped.push(texts),
		submit: async (text, options) => {
			submitted.push({ text, ...(options?.queued ? { queued: options.queued } : {}) });
		},
	});
	const texts = () => queues.entries().map((entry) => entry.text);
	const prompt = (options?: { keepOperatorHold?: boolean }) =>
		queues.handOverBeforePrompt(agent as unknown as Parameters<typeof queues.handOverBeforePrompt>[0], options);
	return { queues, state, steered, held, notices, dropped, submitted, texts, prompt };
}

it("an operator stop sends nothing, keeps entries separate and in order, and announces them once", async () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.steer("two");
	f.queues.queueFollowUp("peer", undefined, { origin: "a peer" });
	f.queues.onRunCancelled({ hold: false });
	assert.deepEqual(f.texts(), ["one", "two"]);
	assert.match(f.notices[0] ?? "", /a peer was accepted into the queue and dropped unrun/);
	f.queues.handOverAtFinishTurn(true);
	f.queues.handOverAfterPrepareNextTurn();
	assert.deepEqual(f.steered, []);
	f.state.streaming = false;
	assert.equal(await f.queues.resubmitStranded(), false);
	f.queues.settleSubmit(true);
	f.queues.settleSubmit(true);
	assert.deepEqual(f.held, [2]);
});

it("a held queue survives a prompt the operator did not type, and lands at the first slot of one they did", () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.onRunCancelled({ hold: false });
	f.prompt({ keepOperatorHold: true });
	f.queues.handOverAtFinishTurn(false);
	assert.deepEqual(f.steered, []);
	f.prompt();
	assert.deepEqual(f.steered, []);
	f.queues.handOverAtFinishTurn(false);
	assert.deepEqual(f.steered, ["one"]);
});

it("a flush sends the held queue in order, each as its own message", () => {
	const f = fixture();
	for (const text of ["one", "two", "three"]) f.queues.steer(text);
	f.queues.onRunCancelled({ hold: false });
	f.queues.removeEntry(f.queues.entries()[0]?.id ?? "", "sent-now");
	f.queues.flushOnNextPrompt();
	f.prompt();
	assert.deepEqual(f.steered, ["two", "three"]);
});

it("a guard stop delivers the operator's entries at settle and retires a machine's", async () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.steer("two");
	f.queues.queueFollowUp("peer", undefined, { origin: "a peer" });
	f.queues.onRunCancelled({ hold: false, settle: true });
	assert.deepEqual(f.texts(), ["one", "two"]);
	assert.match(f.notices[0] ?? "", /dropped unrun/);
	f.state.streaming = false;
	assert.equal(await f.queues.resubmitStranded(), true);
	assert.equal(f.submitted[0]?.text, "one");
	f.prompt();
	assert.deepEqual(f.steered, ["two"]);
	assert.deepEqual(f.held, []);
});

it("a prompt that never starts returns its entry to the head and says so again", () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.steer("two");
	f.queues.onRunCancelled({ hold: false });
	f.state.streaming = false;
	f.queues.settleSubmit(true);
	const taken = f.queues.removeEntry(f.queues.entries()[0]?.id ?? "", "sent-now");
	assert.ok(taken);
	f.queues.flushOnNextPrompt();
	f.queues.requeueUnstarted(taken);
	f.queues.settleSubmit(false);
	assert.deepEqual(f.texts(), ["one", "two"]);
	assert.deepEqual(f.held, [2, 2]);
	f.queues.handOverAtFinishTurn(true);
	f.prompt();
	assert.deepEqual(f.steered, [], "the failed flush must not stay armed");
});

it("an interrupt's prompt that never starts leaves its queue held with a notice", () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.onRunCancelled({ hold: true });
	f.queues.settleSubmit(true);
	assert.deepEqual(f.held, [], "the cancelled run's settle precedes the interrupt's prompt");
	f.queues.settleSubmit(false);
	assert.deepEqual(f.held, [1]);
});

it("a message typed after the stop goes out at settle and the held entries take its first slot", async () => {
	const f = fixture();
	f.queues.steer("before");
	f.queues.onRunCancelled({ hold: false });
	f.queues.steer("after");
	f.queues.handOverAtFinishTurn(true);
	assert.deepEqual(f.steered, []);
	f.state.streaming = false;
	assert.equal(await f.queues.resubmitStranded(), true);
	assert.equal(f.submitted[0]?.text, "after");
	assert.equal(f.submitted[0]?.queued?.text, "after");
	f.prompt();
	assert.deepEqual(f.steered, []);
	f.queues.handOverAtFinishTurn(false);
	assert.deepEqual(f.steered, ["before"]);
});

it("a message typed after a stop with an empty queue is not lost, and a second stop holds it", async () => {
	const f = fixture();
	f.queues.onRunCancelled({ hold: false });
	f.queues.steer("after");
	f.queues.onRunCancelled({ hold: false });
	f.state.streaming = false;
	assert.equal(await f.queues.resubmitStranded(), false);
	f.queues.settleSubmit(true);
	assert.deepEqual(f.held, [1]);
	assert.deepEqual(f.texts(), ["after"]);
});

it("a session change hands operator entries back, and a refresh within the session keeps them held", () => {
	const f = fixture();
	f.queues.steer("one");
	f.queues.onRunCancelled({ hold: false });
	f.queues.reset({ keepOperator: true });
	assert.deepEqual(f.texts(), ["one"]);
	assert.deepEqual(f.dropped, []);
	f.queues.reset();
	assert.deepEqual(f.texts(), []);
	assert.deepEqual(f.dropped, [["one"]]);
});

it("a queued entry refused for its task constraints returns to the head of the queue", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	let release!: () => void;
	const turnHeld = new Promise<void>((resolve) => {
		release = resolve;
	});
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		hasAttachedDispatch: () => true,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: {
				state: options?.initialState as { messages: AgentMessage[] },
				subscribe: () => () => {},
				abort() {},
				clearAllQueues() {},
				async prompt() {
					await turnHeld;
				},
			},
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		const turn = loop.submit("long running turn");
		for (let i = 0; i < 1000 && !loop.isStreaming(); i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(loop.isStreaming(), true);
		loop.steer("one");
		loop.steer("two");
		const taken = loop.removeQueuedEntry(loop.queueEntries()[0]?.id ?? "", "sent-now");
		assert.ok(taken);
		let refusedFor = "";
		await loop.submit(taken.text, {
			steering: "interrupt",
			queued: taken,
			constraints: { allowedTools: ["read"] },
			onRefused: (reason) => {
				refusedFor = reason;
			},
		});
		assert.equal(refusedFor, "constrained-turn-in-flight");
		assert.deepEqual(
			loop.queueEntries().map((entry) => entry.text),
			["one", "two"],
		);
		loop.clearQueuedFollowUps();
		release();
		await turn;
	} finally {
		release();
		loop.dispose();
		await loop.whenSettled();
	}
});

it("names exactly what a clear would restore, in-flight entries included, without draining (A5)", () => {
	const f = fixture();
	f.queues.steer("handed");
	f.queues.handOverAtFinishTurn(false);
	assert.deepEqual(f.steered, ["handed"]);
	f.queues.steer("waiting");
	f.queues.queueFollowUp("peer", undefined, { origin: "a peer" });
	assert.deepEqual(f.texts(), ["waiting", "peer"]);
	const candidates = f.queues.restorableQueued().map((entry) => entry.text);
	assert.deepEqual(candidates, ["handed", "waiting"]);
	assert.deepEqual(f.texts(), ["waiting", "peer"], "the snapshot drains nothing");
	assert.deepEqual(
		f.queues.clearQueuedMirror().map((entry) => entry.text),
		candidates,
	);
});
