import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createOverlayGeneralOpeners } from "../../src/interactive/overlay-general-openers.js";
import type { OverlayTransitions } from "../../src/interactive/overlay-transitions.js";
import {
	formatSideQuestionBody,
	type SideQuestionOverlayPhase,
	type SideQuestionOverlaySession,
	sideQuestionOverlayWidth,
} from "../../src/interactive/overlays/side-question.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function slashContext(sink: { opened: string[]; notices: string[]; submitted: string[] }): SlashCommandContext {
	return {
		io: { stdout: () => undefined, stderr: () => undefined },
		notice: (_level, text) => sink.notices.push(text),
		dispatch: {} as DispatchContract,
		bus: createSafeEventBus(),
		shutdown: () => undefined,
		runInit: () => undefined,
		runContextClear: () => undefined,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		listAgents: () => [],
		listDelegationAgents: () => [],
		openCost: () => undefined,
		openSideQuestion: (question) => sink.opened.push(`btw:${question}`),
		openContextView: () => undefined,
		openTasks: () => undefined,
		openDecisions: () => undefined,
		openMemory: () => undefined,
		openView: () => undefined,
		openModel: () => undefined,
		providers: {} as ProvidersContract,
		applyModelRef: () => undefined,
		openSettings: () => undefined,
		openResume: () => undefined,
		startNewSession: () => undefined,
		openTree: () => undefined,
		openMessagePicker: () => undefined,
		openHelp: () => undefined,
		openAgents: () => undefined,
		openPrompts: () => undefined,
		openExtensions: () => undefined,
		runCompact: () => undefined,
		exportTranscript: () => undefined,
		verifyReceipt: () => ({ ok: false, reason: "missing" }),
		submitChat: (text) => sink.submitted.push(text),
		render: () => undefined,
	};
}

describe("contracts//btw command spec", () => {
	it("takes the whole line as one greedy question and never reaches the model as chat", () => {
		const sink = { opened: [] as string[], notices: [] as string[], submitted: [] as string[] };
		const ctx = slashContext(sink);
		dispatchSlashCommand(parseSlashCommand("/btw which file did the lease land in?"), ctx);
		deepStrictEqual(sink.opened, ["btw:which file did the lease land in?"]);
		deepStrictEqual(sink.submitted, [], "a side question is never submitted as a turn");
	});

	it("prints usage through the existing usage path when no question is given", () => {
		const sink = { opened: [] as string[], notices: [] as string[], submitted: [] as string[] };
		const ctx = slashContext(sink);
		dispatchSlashCommand(parseSlashCommand("/btw"), ctx);
		dispatchSlashCommand(parseSlashCommand("/btw    "), ctx);
		deepStrictEqual(sink.opened, []);
		strictEqual(sink.notices.length, 2);
		for (const notice of sink.notices) strictEqual(notice, "usage: /btw <question>");
	});
});

interface FakeOverlay extends SideQuestionOverlaySession {
	answers: string[];
	settled: SideQuestionOverlayPhase[];
	hidden: boolean;
}

function opener(options: {
	ask: NonNullable<Parameters<typeof createOverlayGeneralOpeners>[0]["askSideQuestion"]>;
	transitions?: OverlayTransitions;
}): {
	openSideQuestion: (question: string) => void;
	overlay: () => FakeOverlay | null;
	transitions: OverlayTransitions;
	notices: string[];
} {
	let overlay: FakeOverlay | null = null;
	const notices: string[] = [];
	let state: OverlayTransitions["state"] = "closed";
	let handle: OverlayTransitions["handle"] = null;
	const transitions: OverlayTransitions = {
		get state() {
			return state;
		},
		set state(next) {
			state = next;
		},
		get handle() {
			return handle;
		},
		set handle(next) {
			handle = next;
		},
		close(): void {
			state = "closed";
			handle?.hide();
			handle = null;
		},
	};
	const openers = createOverlayGeneralOpeners({
		tui: { requestRender: () => undefined } as never,
		transitions,
		observability: {} as never,
		getContextLedger: () => ({}) as never,
		contextChat: {} as never,
		bus: createSafeEventBus(),
		stderr: () => undefined,
		refreshFooter: () => undefined,
		toggleFooter: () => undefined,
		renderTaskIsland: () => undefined,
		requestRender: () => undefined,
		submitChat: () => undefined,
		dataDir: "/tmp",
		notify: (_level, text) => notices.push(text),
		dispatch: {} as never,
		stateDir: "/tmp",
		getSessionMeta: () => null,
		terminal: { columns: 100 },
		dispatchBoard: {} as never,
		startDispatchBoardTicker: () => undefined,
		closeOverlay: () => transitions.close(),
		askSideQuestion: options.ask,
		openSideQuestionOverlay: (_tui, overlayOptions) => {
			const session: FakeOverlay = {
				answers: [],
				settled: [],
				hidden: false,
				setHidden: (value: boolean) => {
					session.hidden = value;
				},
				isHidden: () => session.hidden,
				focus: () => undefined,
				unfocus: () => undefined,
				isFocused: () => false,
				setAnswer(text) {
					session.answers.push(text);
				},
				settle(phase) {
					session.settled.push(phase);
				},
				hide() {
					session.hidden = true;
					overlayOptions.onClose();
				},
			};
			overlay = session;
			return session;
		},
	});
	return { openSideQuestion: openers.openSideQuestion, overlay: () => overlay, transitions, notices };
}

describe("contracts//btw round", () => {
	it("streams the answer into the overlay and settles it, appending nothing", async () => {
		const deltas = ["it ", "it landed ", "it landed in terminal-lease.ts"];
		let settledPromise: Promise<unknown> = Promise.resolve();
		const { openSideQuestion, overlay, transitions } = opener({
			ask: (question, askOptions) => {
				strictEqual(question, "where did the lease land");
				for (const delta of deltas) askOptions.onDelta(delta);
				const answered = Promise.resolve({ status: "answered" as const, text: deltas[2] as string });
				settledPromise = answered;
				return answered;
			},
		});
		openSideQuestion("where did the lease land");
		strictEqual(transitions.state, "side-question");
		await settledPromise;
		await new Promise((resolve) => setImmediate(resolve));
		deepStrictEqual(overlay()?.answers, deltas);
		deepStrictEqual(overlay()?.settled, [{ kind: "answered", text: "it landed in terminal-lease.ts" }]);
	});

	it("aborts the round when the overlay closes", async () => {
		let observed: AbortSignal | null = null;
		let resolveAsk: ((value: { status: "aborted"; text: string }) => void) | undefined;
		const { openSideQuestion, overlay, transitions } = opener({
			ask: (_question, askOptions) => {
				observed = askOptions.signal;
				return new Promise((resolve) => {
					resolveAsk = resolve;
				});
			},
		});
		openSideQuestion("still going?");
		ok(observed !== null);
		strictEqual((observed as unknown as AbortSignal).aborted, false);
		transitions.close();
		strictEqual((observed as unknown as AbortSignal).aborted, true, "Esc cancels the in-flight round");
		resolveAsk?.({ status: "aborted", text: "partial" });
		await new Promise((resolve) => setImmediate(resolve));
		deepStrictEqual(overlay()?.settled, [{ kind: "aborted", text: "partial" }]);
	});

	it("shows a refusal as an error phase rather than queueing the question", async () => {
		const { openSideQuestion, overlay } = opener({
			ask: () => Promise.resolve({ status: "refused" as const, reason: "a turn is in flight" }),
		});
		openSideQuestion("mid-run question");
		await new Promise((resolve) => setImmediate(resolve));
		deepStrictEqual(overlay()?.settled, [{ kind: "error", reason: "a turn is in flight" }]);
	});

	it("refuses to open a second overlay over an open one", () => {
		const { openSideQuestion, transitions, overlay } = opener({
			ask: () => new Promise(() => undefined),
		});
		transitions.state = "cost";
		openSideQuestion("nope");
		strictEqual(overlay(), null);
		strictEqual(transitions.state, "cost");
	});
});

describe("contracts//btw overlay body", () => {
	it("shows the question above the answer and names the live state", () => {
		const streaming = strip(formatSideQuestionBody("why", { kind: "streaming", text: "" }, 40, "·").join("\n"));
		ok(streaming.includes("why"));
		ok(streaming.includes("asking"));
		const answered = strip(formatSideQuestionBody("why", { kind: "answered", text: "because" }, 40, "·").join("\n"));
		ok(answered.includes("why"));
		ok(answered.includes("because"));
		const aborted = strip(formatSideQuestionBody("why", { kind: "aborted", text: "part" }, 40, "·").join("\n"));
		ok(aborted.includes("cancelled"));
		const failed = strip(formatSideQuestionBody("why", { kind: "error", reason: "no target" }, 40, "·").join("\n"));
		ok(failed.includes("no target"));
		ok(!failed.includes("cancelled"));
	});

	it("keeps the box inside the terminal at every width", () => {
		for (const columns of [20, 44, 80, 200]) {
			const width = sideQuestionOverlayWidth(columns);
			ok(width >= 44, `${columns} keeps a legible floor`);
			ok(width <= 100, `${columns} keeps a readable ceiling`);
		}
	});
});
