/**
 * A consumed prompt looked idle while Clio prepared the turn.
 *
 * The editor is cleared and the prompt painted into the transcript before
 * admission, and everything between — the capability probe, pre-submit
 * auto-compaction, the prompt compile, the overflow preflight — happens after
 * that and before `state.streaming`. Nothing named that window, so the
 * composer went straight back to `MESSAGE` with `Ask Clio…` and the footer
 * still reported the previous turn as done. In the observed run that lasted
 * 77.4 seconds and the operator pressed Enter twice more, because there was no
 * way to tell a long compaction from a dropped keystroke (issue #251).
 *
 * The ordering that keeps compaction before the durable user turn is correct
 * and is asserted here too. What these tests pin is the state that was
 * missing.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { type TUI, visibleWidth } from "../../src/engine/tui.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { ClioEditor, type EditorChrome } from "../../src/interactive/clio-editor.js";
import { createInteractiveSlashRuntime } from "../../src/interactive/interactive-slash-runtime.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { reduceStatus } from "../../src/interactive/status/state-machine.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import type { TurnPreparationPhase } from "../../src/interactive/turn-state.js";
import { formatCouncilMemberShareNote } from "../../src/interactive/worker-share.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.chat.target = "test-target";
	value.chat.model = "model";
	value.targets = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 4000, maxTokens: 256, tools: true, chat: true },
		},
	];
	return value;
}

function providers(): ProvidersContract {
	const target: TargetDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 4000, maxTokens: 256, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 4000, maxTokens: 256 },
		synthesizeModel: () =>
			({
				id: "model",
				name: "model",
				api: "openai-completions",
				provider: "fake-runtime",
				contextWindow: 4000,
				maxTokens: 256,
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}) as unknown as EngineModel,
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		probeTarget: async () => status,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
		auth: {
			statusForTarget: () => ({ kind: "not-required" }) as never,
			resolveForTarget: async () => ({ apiKey: "", source: "none" }) as never,
		} as never,
	} as never;
}

function createSession(entries: SessionEntry[]): SessionContract {
	let current: SessionMeta | null = null;
	let counter = 0;
	const nextId = (): string => `turn-${++counter}`;
	return {
		current: () => current,
		create(input) {
			current = {
				id: "session-1",
				createdAt: new Date().toISOString(),
				cwd: input?.cwd ?? process.cwd(),
				model: input?.model ?? "model",
				target: input?.target ?? "test-target",
			} as SessionMeta;
			return current;
		},
		append(turn: TurnInput) {
			if (!current) this.create();
			const id = turn.id ?? nextId();
			const at = turn.at ?? new Date().toISOString();
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: at,
				role: turn.kind,
				payload: turn.payload,
			} as SessionEntry);
			return { ...turn, id, at };
		},
		appendEntry(entry: SessionEntryInput) {
			const withIds = {
				...entry,
				turnId: entry.turnId ?? nextId(),
				parentTurnId: entry.parentTurnId ?? null,
				timestamp: entry.timestamp ?? new Date().toISOString(),
			} as SessionEntry;
			entries.push(withIds);
			return withIds;
		},
		replaceEntries(next) {
			entries.splice(0, entries.length, ...next);
		},
		recordSkillActivation: (activation) => activation,
		checkpoint: async () => {},
		resume: () => current as SessionMeta,
		fork: () => current as SessionMeta,
		tree: () => ({ nodes: [], rootSessionId: "session-1" }) as never,
		switchBranch: () => current as SessionMeta,
		switchTurn: () => current as SessionMeta,
		editLabel: () => {},
		setName: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
	};
}

function createFakeAgentFactory(): unknown {
	return (options: { initialState?: { messages?: AgentMessage[] } } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: "",
			model: undefined as unknown,
			thinkingLevel: "off",
			tools: [] as unknown[],
			messages: options.initialState?.messages ?? [],
			errorMessage: undefined as string | undefined,
		};
		const controller = new AbortController();
		const agent = {
			state,
			sessionId: undefined as string | undefined,
			maxRetryDelayMs: undefined as number | undefined,
			prepareNextTurn: undefined,
			subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listeners.push(listener);
				return () => {};
			},
			async emit(event: AgentEvent) {
				for (const listener of listeners) await listener(event, controller.signal);
			},
			async prompt() {},
			async continue() {},
			followUp() {},
			steer() {},
			abort() {},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		};
		return { agent, state: () => state };
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const COMPACT_RESULT: CompactResult = {
	summary: "compacted older context",
	firstKeptEntryIndex: 0,
	firstKeptTurnId: "summary-1",
	tokensBefore: 1500,
	messagesSummarized: 3,
	isSplitTurn: false,
};

interface PreparedLoop {
	loop: ReturnType<typeof createChatLoop>;
	entries: SessionEntry[];
	phases: TurnPreparationPhase[];
	releaseCompaction: (result: CompactResult | null) => void;
	dispose: () => Promise<void>;
}

/**
 * A chat loop whose pre-submit auto-compaction is held open. `CLIO_CODER_FORCE_COMPACT`
 * is what makes the trigger fire unconditionally, which is the same flag the
 * production path reads.
 */
async function preparedLoop(options: { knownTarget?: boolean } = {}): Promise<PreparedLoop> {
	const isolated = await isolateClioEnv("clio-turn-preparation-");
	process.env.CLIO_CODER_FORCE_COMPACT = "1";
	const entries: SessionEntry[] = [];
	const session = createSession(entries);
	session.create({ cwd: process.cwd(), model: "model", target: "test-target" });
	const gate = deferred<CompactResult | null>();
	const phases: TurnPreparationPhase[] = [];
	const loop = createChatLoop({
		getSettings: settings,
		providers: providers(),
		knownTargets: () => new Set(options.knownTarget === false ? [] : ["test-target"]),
		session,
		readSessionEntries: () => entries,
		bus: createSafeEventBus(),
		autoCompact: async (): Promise<CompactResult | null> => {
			const result = await gate.promise;
			if (result !== null) {
				entries.push({
					kind: "compactionSummary",
					turnId: "summary-1",
					parentTurnId: null,
					timestamp: new Date().toISOString(),
					summary: result.summary,
					tokensBefore: result.tokensBefore,
					firstKeptTurnId: result.firstKeptTurnId,
					trigger: "auto",
				} as SessionEntry);
			}
			return result;
		},
		createAgent: createFakeAgentFactory(),
	} as never);
	loop.onTurnPreparation((phase) => phases.push(phase));
	return {
		loop,
		entries,
		phases,
		releaseCompaction: (result) => gate.resolve(result),
		dispose: async () => {
			Reflect.deleteProperty(process.env, "CLIO_CODER_FORCE_COMPACT");
			await isolated.restore();
		},
	};
}

/** Let the microtask queue drain so the held submit reaches the compaction await. */
async function settle(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function editorFor(chrome: Partial<EditorChrome>): ClioEditor {
	const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;
	return new ClioEditor(tui, {
		getModelLabel: () => "test-target·model",
		getThinkingLabel: () => "off",
		isStreaming: () => false,
		...chrome,
	});
}

describe("contracts/turn preparation", () => {
	/**
	 * The observed failure, held open. While the pre-submit compaction runs the
	 * composer must not read as an idle `MESSAGE` prompt, and the placeholder
	 * must say what is happening instead of `Ask Clio…`.
	 */
	it("shows a non-idle composer for the whole pre-submit compaction", async () => {
		const harness = await preparedLoop();
		try {
			const submitted = harness.loop.submit("plan the significance section");
			await settle();

			strictEqual(harness.loop.turnPreparation().phase, "compacting", "the window names the slow step");
			ok(harness.loop.turnPreparation().since > 0, "and carries when it opened, for an elapsed counter");
			strictEqual(harness.loop.isStreaming(), false, "the turn has not been admitted");

			const editor = editorFor({ getTurnPreparation: () => harness.loop.turnPreparation().phase });
			const frame = editor.render(80).map(stripAnsi);
			ok(frame[0]?.startsWith("COMPACTING "), `the rail is not idle: ${frame[0]}`);
			ok(
				frame.some((line) => line.includes("compacting the context")),
				`the placeholder says what Clio is doing: ${frame.join(" | ")}`,
			);
			ok(
				!frame.some((line) => line.includes("Ask Clio…")),
				`and never reads as an empty idle composer: ${frame.join(" | ")}`,
			);

			harness.releaseCompaction(COMPACT_RESULT);
			await submitted;
			strictEqual(harness.loop.turnPreparation().phase, "idle", "the window closes when the turn is admitted");
			const after = editorFor({ getTurnPreparation: () => harness.loop.turnPreparation().phase })
				.render(80)
				.map(stripAnsi);
			ok(after[0]?.startsWith("MESSAGE "), `and the composer goes back to idle: ${after[0]}`);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The production path paints through the slash runtime and a scheduled TUI
	 * commit. Rendering the editor manually against a held chat loop proved the
	 * components understood the state, but it did not prove a frame reached the
	 * terminal before a fast admission closed that state again.
	 */
	it("commits the pending row, preparing rail, and preparing footer before admission starts", async () => {
		const harness = await preparedLoop();
		const panel = createChatPanel({} as never);
		const editor = editorFor({ getTurnPreparation: () => harness.loop.turnPreparation().phase });
		const status = createStatusController({ chat: harness.loop, providers: providers() });
		const committedFrames: Array<{ editor: string; transcript: string; footerPhase: string; reason: string }> = [];
		const runtime = createInteractiveSlashRuntime({
			io: { stdout() {}, stderr() {} },
			bus: createSafeEventBus(),
			dispatch: {},
			providers: providers(),
			chat: harness.loop,
			chatPanel: {
				appendReplayBlock: (...args: Parameters<typeof panel.appendReplayBlock>) => panel.appendReplayBlock(...args),
				appendUser: (...args: Parameters<typeof panel.appendUser>) => panel.appendUser(...args),
				clearFoldOverrides: () => panel.clearFoldOverrides(),
			},
			stateDir: "/unused",
			shutdown() {},
			requestRender() {},
			beforeSemanticSubmit() {},
			settleVisibleFrame: async (reason: string) => {
				committedFrames.push({
					editor: editor.render(80).map(stripAnsi).join("\n"),
					transcript: panel.render(80).map(stripAnsi).join("\n"),
					footerPhase: status.current().phase,
					reason,
				});
			},
			refreshFooter() {},
			dismissContextBootstrapNotices() {},
			recordSubmittedTurn() {},
			readStructuredEntries: () => harness.entries,
			expandSubmit: async (text: string) => ({
				text,
				images: [],
				workingContextPaths: [],
				pendingSkillRequests: [],
			}),
		} as never);

		const admission = runtime.admitCommand("plan the significance section");
		try {
			await settle();
			const frame = committedFrames[0];
			ok(frame, "the real submit path commits once before it enters the held compaction");
			strictEqual(frame.reason, "submit-preparing");
			ok(frame.editor.startsWith("PREPARING "), frame.editor);
			ok(!frame.editor.includes("Ask Clio…"), frame.editor);
			ok(frame.transcript.includes("plan the significance section · preparing"), frame.transcript);
			strictEqual(frame.footerPhase, "preparing", "the footer no longer owns the previous turn's receipt");
			strictEqual(
				harness.entries.some((entry) => entry.kind === "message" && (entry as { role?: string }).role === "user"),
				false,
				"the visible frame precedes the durable user append",
			);
		} finally {
			harness.releaseCompaction(COMPACT_RESULT);
			await admission;
			status.dispose();
			await harness.dispose();
		}
	});

	it("preserves the compaction summary before the one user turn", async () => {
		const harness = await preparedLoop();
		try {
			const submitted = harness.loop.submit("plan the significance section");
			await settle();
			harness.releaseCompaction(COMPACT_RESULT);
			await submitted;

			const kinds = harness.entries.map((entry) => entry.kind);
			const summaryAt = kinds.indexOf("compactionSummary");
			const userEntries = harness.entries.filter(
				(entry) => entry.kind === "message" && (entry as { role?: string }).role === "user",
			);
			ok(summaryAt >= 0, `the compaction ran before the turn: ${kinds.join(",")}`);
			strictEqual(userEntries.length, 1, `exactly one user turn: ${kinds.join(",")}`);
			ok(
				harness.entries.indexOf(userEntries[0] as SessionEntry) > summaryAt,
				`the summary is still ordered before the user turn: ${kinds.join(",")}`,
			);
			strictEqual(harness.phases.at(-1), "idle");
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The window has to close on the paths that never reach admission too, or a
	 * refused turn would leave the composer claiming forever that Clio is
	 * preparing something.
	 */
	it("closes the window when admission refuses the turn", async () => {
		const harness = await preparedLoop({ knownTarget: false });
		try {
			await harness.loop.submit("plan the significance section");
			strictEqual(harness.loop.turnPreparation().phase, "idle", "a refused submit leaves no preparing state");
			strictEqual(harness.loop.isStreaming(), false);
			const userEntries = harness.entries.filter(
				(entry) => entry.kind === "message" && (entry as { role?: string }).role === "user",
			);
			strictEqual(userEntries.length, 0, "and no phantom user turn in the ledger");
			ok(harness.phases.includes("preparing"), `the window did open: ${harness.phases.join(",")}`);
			strictEqual(harness.phases.at(-1), "idle");
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The natural recovery from the false idle was to press Enter again or retype.
	 * An empty editor is refused before any of this (pinned in
	 * `interactive-editor-submit.test.ts`), but a retyped prompt is a real second
	 * submit: it queues behind the FIFO admission gate, and the window stays open
	 * until the last one out closes it.
	 */
	it("holds the window open across a second submit and lands one turn per prompt", async () => {
		const harness = await preparedLoop();
		try {
			const first = harness.loop.submit("plan the significance section");
			await settle();
			const second = harness.loop.submit("and the broader impacts section");
			await settle();
			strictEqual(harness.loop.turnPreparation().phase, "compacting", "the second submit does not close the window");

			harness.releaseCompaction(COMPACT_RESULT);
			await Promise.all([first, second]);

			strictEqual(harness.loop.turnPreparation().phase, "idle", "and the last one out closes it");
			const userTexts = harness.entries
				.filter((entry) => entry.kind === "message" && (entry as { role?: string }).role === "user")
				.map((entry) => String((entry as { payload?: { text?: string } }).payload?.text ?? ""));
			// Two distinct prompts are two turns, serialized by the FIFO admission
			// gate: neither is duplicated and neither overtakes the other.
			strictEqual(userTexts.length, 2, `one turn per prompt: ${userTexts.join(" | ")}`);
			ok(userTexts[0]?.includes("significance"), userTexts.join(" | "));
			ok(userTexts[1]?.includes("broader impacts"), userTexts.join(" | "));
		} finally {
			await harness.dispose();
		}
	});

	it("reports the whole window as one age, not the age of its current step", async () => {
		const harness = await preparedLoop();
		try {
			const submitted = harness.loop.submit("plan the significance section");
			await settle();
			const openedAt = harness.loop.turnPreparation().since;
			harness.releaseCompaction(COMPACT_RESULT);
			await submitted;
			ok(openedAt > 0);
			ok(
				harness.phases.slice(0, 2).join(",") === "preparing,compacting",
				`the window opens before the compaction names itself: ${harness.phases.join(",")}`,
			);
		} finally {
			await harness.dispose();
		}
	});
});

describe("contracts/turn preparation status", () => {
	const ctx = { now: 1_000, localRuntime: false, modelId: "model", targetId: "test-target" };

	it("takes the footer off the previous turn's receipt while the prompt is being prepared", () => {
		const ended = {
			...INITIAL_STATUS,
			phase: "ended" as const,
			summary: { elapsedMs: 676_000, stopReason: "stop" } as never,
		};
		const preparing = reduceStatus(ended, { type: "submit_accepted" }, ctx);
		strictEqual(preparing.phase, "preparing", "the footer stops saying the last turn is what is happening");
		strictEqual(preparing.preparingSubmission, true);
		ok(preparing.summary !== undefined, "the last turn's receipt is kept for when this one is refused");
	});

	/**
	 * `pushOverlay` ignores an overlay while the status is idle or ended, which
	 * is why the compaction overlay never landed: pre-submit compaction happens
	 * when the previous turn has already ended. `preparing` is an active phase,
	 * so the same bus event now reaches the footer.
	 */
	it("lets the compaction overlay land during the preparation window", () => {
		const preparing = reduceStatus(INITIAL_STATUS, { type: "submit_accepted" }, ctx);
		const compacting = reduceStatus(preparing, { type: "overlay_push", overlay: "compacting" }, ctx);
		strictEqual(compacting.phase, "compacting");
		const back = reduceStatus(compacting, { type: "overlay_pop", overlay: "compacting" }, ctx);
		strictEqual(back.phase, "preparing");
	});

	it("hands the window to the run rather than treating the start as a duplicate", () => {
		const preparing = reduceStatus(INITIAL_STATUS, { type: "submit_accepted" }, ctx);
		const started = reduceStatus(preparing, { type: "agent_start" } as never, { ...ctx, now: 2_000, runId: "run-1" });
		strictEqual(started.phase, "preparing");
		strictEqual(started.preparingSubmission, undefined, "the run owns the phase now");
		strictEqual(started.since, 2_000, "and its own clock");
	});

	it("puts the footer back on the last completed turn when admission refuses", () => {
		const ended = {
			...INITIAL_STATUS,
			phase: "ended" as const,
			summary: { elapsedMs: 676_000, stopReason: "stop" } as never,
		};
		const preparing = reduceStatus(ended, { type: "submit_accepted" }, ctx);
		const settled = reduceStatus(preparing, { type: "submit_settled" }, { ...ctx, now: 2_000 });
		strictEqual(settled.phase, "ended");
		strictEqual(settled.preparingSubmission, undefined);
		ok(settled.summary !== undefined, "the receipt for the turn that did run is back");
	});

	it("leaves a live run alone", () => {
		const writing = { ...INITIAL_STATUS, phase: "writing" as const };
		strictEqual(reduceStatus(writing, { type: "submit_accepted" }, ctx), writing);
	});
});

describe("contracts/pending transcript row", () => {
	const panelFor = (status: () => "pending" | "committed" | "refused") => {
		const panel = createChatPanel({} as never);
		panel.appendUser("plan the significance section", status);
		return panel;
	};

	it("marks a painted prompt that is not in the ledger yet", () => {
		let state: "pending" | "committed" | "refused" = "pending";
		const panel = panelFor(() => state);
		const pending = panel.render(60).map(stripAnsi).join("\n");
		ok(pending.includes("· preparing"), `a pending row says so: ${pending}`);

		state = "committed";
		const committed = panel.render(60).map(stripAnsi).join("\n");
		ok(!committed.includes("· preparing"), `and stops saying it once the turn is durable: ${committed}`);
		ok(committed.includes("plan the significance section"), committed);
	});

	it("marks a row whose submit never reached the ledger", () => {
		let state: "pending" | "committed" | "refused" = "pending";
		const panel = panelFor(() => state);
		panel.render(60);
		state = "refused";
		const refused = panel.render(60).map(stripAnsi).join("\n");
		ok(refused.includes("· not sent"), `a refused row is not a committed turn: ${refused}`);
	});

	it("leaves a replayed turn exactly as it was", () => {
		const panel = createChatPanel({} as never);
		panel.appendUser("plan the significance section");
		const rendered = panel.render(60).map(stripAnsi).join("\n");
		ok(!rendered.includes("· preparing") && !rendered.includes("· not sent"), rendered);
	});
});

/**
 * The uncommitted tail used to be concatenated onto the last rendered line with
 * no width budget, so a body that had folded to the full content width came out
 * wider than the terminal and pi-tui's `doRender` killed the process. `/share`
 * of a worker answer is the ordinary way to reach it: a `research-report` body
 * is JSON with no space to fold at (#257).
 */
describe("contracts/pending transcript row width", () => {
	/** A `research-report` answer: JSON, no space anywhere in it to fold at. */
	const spacelessBody = (length: number): string => {
		const wrapper = '{"finding":""}';
		return `{"finding":"${"z".repeat(Math.max(0, length - wrapper.length))}"}`;
	};
	const shareNote = (body: string): string => {
		const note = formatCouncilMemberShareNote(
			{ agentId: "researcher", runId: "pk8h3nfzy5xc", outcome: "succeeded", text: body },
			"alpha",
		);
		ok(note !== null, "the share note has a body");
		return note;
	};
	const renderRow = (note: string, status: "pending" | "refused", width: number): string[] => {
		const panel = createChatPanel({} as never);
		panel.appendUser(note, () => status);
		return panel.render(width);
	};

	for (const [state, tail] of [
		["pending", "· preparing"],
		["refused", "· not sent"],
	] as const) {
		it(`folds a 200-character spaceless shared body at 80 columns while a row is ${state}`, () => {
			const body = spacelessBody(200);
			const rendered = renderRow(shareNote(body), state, 80);
			for (const line of rendered) {
				ok(visibleWidth(line) <= 80, `${visibleWidth(line)} cells of 80 in ${JSON.stringify(line)}`);
			}
			const text = rendered.map(stripAnsi).join("\n");
			ok(text.includes(tail), `the row still reports its state: ${text}`);
			strictEqual(text.replace(/\n {2}/gu, "").includes(body), true, "the body is folded, not dropped");
		});
	}

	/**
	 * The crash needed the last folded line to be close enough to full that the
	 * tail pushed it over, which a single body length does not reliably produce.
	 * Sweeping the length walks the last line across every offset in the fold.
	 */
	it("keeps every shared-note body length inside an 80-column terminal", () => {
		for (let length = 14; length <= 260; length += 1) {
			const note = shareNote(spacelessBody(length));
			for (const status of ["pending", "refused"] as const) {
				for (const line of renderRow(note, status, 80)) {
					ok(visibleWidth(line) <= 80, `body ${length}, ${status}: ${visibleWidth(line)} cells in ${JSON.stringify(line)}`);
				}
			}
		}
	});

	/** Every terminal an operator can drag to, down to the ones that leave no room for the tail. */
	it("never renders past the terminal at any width", () => {
		const note = shareNote(spacelessBody(194));
		for (let width = 8; width <= 120; width += 1) {
			for (const line of renderRow(note, "pending", width)) {
				ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} cells in ${JSON.stringify(line)}`);
			}
		}
	});
});
