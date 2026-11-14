import assert from "node:assert/strict";
import { test } from "node:test";
import { readoutAnnouncement, readoutChips } from "../client/chat/readouts-model.js";
import type { SessionReadouts } from "../contracts/readouts.js";

const NONE: SessionReadouts = { autonomy: null, throughput: null, skills: null, retry: null };
const YOLO = {
	level: "yolo",
	confinement: "contained",
	osSandbox: true,
	label: "YOLO · contained",
	tone: "warning",
	window: { display: "3/600 calls", tone: "neutral", halted: false },
} as const;
const LIVE: SessionReadouts = {
	autonomy: YOLO,
	throughput: { display: "42 tok/s", estimated: false, flowing: false },
	skills: { names: ["review", "release"], display: "skills review, release" },
	retry: { phase: "waiting", active: true, display: "provider retry 1/3 in 4s" },
};

test("no readouts, or only nulls, is no chip at all", () => {
	assert.deepEqual(readoutChips(undefined, true), []);
	assert.deepEqual(readoutChips(NONE, true), []);
});

test("contained yolo shows its label then its window, in the engine's words", () => {
	const chips = readoutChips({ ...NONE, autonomy: YOLO }, false);
	assert.deepEqual(
		chips.map((chip) => chip.text),
		["YOLO · contained", "3/600 calls"],
	);
	assert.deepEqual(
		chips.map((chip) => chip.tone),
		["warn", "neutral"],
	);
});

test("a halted window is a yolo paused chip carrying the engine's reason", () => {
	const halted = {
		...YOLO,
		window: { display: "600/600 calls", tone: "warning", halted: true, haltDetail: "the call limit was reached" },
	} as const;
	const pause = readoutChips({ ...NONE, autonomy: halted }, false).find((chip) => chip.key === "window");
	assert.equal(pause?.text, "yolo paused");
	assert.equal(pause?.title, "the call limit was reached");
	assert.equal(pause?.tone, "warn");
});

test("an unconfined error-toned yolo maps to fail", () => {
	const unconfined = { ...YOLO, confinement: "unconfined", tone: "error", label: "YOLO · unconfined" } as const;
	assert.equal(readoutChips({ ...NONE, autonomy: unconfined }, false)[0]?.tone, "fail");
});

test("the rate and the retry belong to a running turn; yolo and skills do not", () => {
	assert.deepEqual(
		readoutChips(LIVE, false).map((chip) => chip.key),
		["autonomy", "window", "skills"],
	);
	const running = readoutChips(LIVE, true);
	assert.deepEqual(
		running.map((chip) => chip.key),
		["autonomy", "window", "throughput", "skills", "retry"],
	);
	assert.equal(running.find((chip) => chip.key === "throughput")?.dim, true, "a stalled rate is dimmed, not hidden");
	assert.equal(running.find((chip) => chip.key === "skills")?.title, "review, release");
	assert.equal(readoutAnnouncement(running), "provider retry 1/3 in 4s", "the rate never speaks");
});
