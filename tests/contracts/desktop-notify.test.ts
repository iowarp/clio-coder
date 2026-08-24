import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildDesktopNotifySequence,
	createDesktopNotifier,
	createInteractiveDesktopNotifications,
	DESKTOP_NOTIFY_BODY_MAX_BYTES,
	DESKTOP_NOTIFY_TITLE,
	type DesktopNotifyBatchView,
	desktopNotifyBody,
	prefersOsc9,
} from "../../src/interactive/footer/notifications.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function osc777(body: string): string {
	return `${ESC}]777;notify;${DESKTOP_NOTIFY_TITLE};${body}${BEL}`;
}

function osc9(body: string): string {
	return `${ESC}]9;${body}${BEL}`;
}

describe("contracts/desktop notification sequence", () => {
	it("emits OSC 777 with the fixed title by default", () => {
		strictEqual(buildDesktopNotifySequence({ kind: "turn-finished" }, {}), osc777("turn finished"));
		strictEqual(buildDesktopNotifySequence({ kind: "approval-needed" }, {}), osc777("approval needed"));
		strictEqual(
			buildDesktopNotifySequence({ kind: "batch-settled", shortId: "a1b2c3d4" }, {}),
			osc777("batch a1b2c3d4 settled"),
		);
	});

	it("emits OSC 9 for iTerm2, Windows Terminal, and ConEmu, and never both sequences", () => {
		for (const env of [
			{ TERM_PROGRAM: "iTerm.app" },
			{ TERM_PROGRAM: "WindowsTerminal" },
			{ WT_SESSION: "3f0c" },
			{ TERM_PROGRAM: "ConEmu" },
		]) {
			const sequence = buildDesktopNotifySequence({ kind: "turn-finished" }, env);
			strictEqual(sequence, osc9("turn finished"));
			ok(!sequence.includes("777"), `${JSON.stringify(env)} must not carry an OSC 777 payload`);
			strictEqual(sequence.split(BEL).length - 1, 1, "exactly one sequence per event");
			ok(prefersOsc9(env));
		}
		ok(!prefersOsc9({ TERM_PROGRAM: "ghostty" }));
		ok(!prefersOsc9({}));
		strictEqual(
			buildDesktopNotifySequence({ kind: "turn-finished" }, { TERM_PROGRAM: "ghostty" }),
			osc777("turn finished"),
		);
	});

	it("keeps the body inside a closed vocabulary and strips control characters", () => {
		const hostile = `x${ESC}]0;pwned${BEL}y;z\nw`;
		const body = desktopNotifyBody({ kind: "batch-settled", shortId: hostile });
		ok(!body.includes(ESC), "no escape byte survives");
		ok(!body.includes(BEL), "no bell byte survives");
		ok(!body.includes(";"), "no OSC separator survives");
		ok(!body.includes("\n"));
		const sequence = buildDesktopNotifySequence({ kind: "batch-settled", shortId: hostile }, {});
		strictEqual(sequence.split(BEL).length - 1, 1, "a hostile id cannot close the sequence early");
		strictEqual(sequence.split(`${ESC}]`).length - 1, 1, "a hostile id cannot open a second sequence");
	});

	it("bounds the body to 128 bytes", () => {
		const body = desktopNotifyBody({ kind: "batch-settled", shortId: "é".repeat(400) });
		ok(new TextEncoder().encode(body).length <= DESKTOP_NOTIFY_BODY_MAX_BYTES);
		const sequence = buildDesktopNotifySequence({ kind: "batch-settled", shortId: "z".repeat(4096) }, {});
		const payload = sequence.slice(`${ESC}]777;notify;${DESKTOP_NOTIFY_TITLE};`.length, -1);
		ok(new TextEncoder().encode(payload).length <= DESKTOP_NOTIFY_BODY_MAX_BYTES);
	});
});

interface Harness {
	writes: string[];
	notifications: ReturnType<typeof createInteractiveDesktopNotifications>;
	setBatches(views: DesktopNotifyBatchView[]): void;
}

function harness(options: { enabled?: boolean; interactiveTty?: boolean } = {}): Harness {
	const writes: string[] = [];
	let batches: DesktopNotifyBatchView[] = [];
	const notifications = createInteractiveDesktopNotifications({
		write: (data) => writes.push(data),
		enabled: () => options.enabled ?? true,
		interactiveTty: () => options.interactiveTty ?? true,
		getOpenBatches: () => batches,
		env: {},
	});
	return {
		writes,
		notifications,
		setBatches(views) {
			batches = views;
		},
	};
}

describe("contracts/desktop notification events", () => {
	it("emits exactly once for each of the three events when the setting is on", () => {
		const h = harness();
		h.notifications.turnEnded();
		h.notifications.approvalParked();
		h.setBatches([{ id: "batch-aaaa1111", total: 2, terminal: 2 }]);
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, [osc777("turn finished"), osc777("approval needed"), osc777("batch batch-aa settled")]);
	});

	it("never emits when the setting is off", () => {
		const h = harness({ enabled: false });
		h.setBatches([{ id: "batch-aaaa1111", total: 1, terminal: 1 }]);
		h.notifications.turnEnded();
		h.notifications.approvalParked();
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, []);
	});

	it("never emits outside the interactive TTY path even with the setting on", () => {
		const h = harness({ enabled: true, interactiveTty: false });
		h.setBatches([{ id: "batch-aaaa1111", total: 1, terminal: 1 }]);
		h.notifications.turnEnded();
		h.notifications.approvalParked();
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, []);
	});

	it("announces a batch once as it settles, and never while it is still running", () => {
		const h = harness();
		h.setBatches([{ id: "batch-aaaa1111", total: 3, terminal: 1 }]);
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, []);
		h.setBatches([{ id: "batch-aaaa1111", total: 3, terminal: 3 }]);
		h.notifications.dispatchSettled();
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, [osc777("batch batch-aa settled")]);
	});

	it("stays silent on a dispatch terminal event that settles no batch", () => {
		const h = harness();
		h.setBatches([]);
		h.notifications.dispatchSettled();
		deepStrictEqual(h.writes, []);
	});

	it("survives a terminal that refuses the write", () => {
		const notifications = createDesktopNotifier({
			write: () => {
				throw new Error("EPIPE");
			},
			enabled: () => true,
			interactiveTty: () => true,
			env: {},
		});
		notifications.notify({ kind: "turn-finished" });
	});
});
