import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEGRADED_FLOOR_TOKENS_PER_SECOND,
	startDegradedInferenceWatchdog,
} from "../../src/engine/apis/degraded-inference.js";
import {
	CO_RESIDENT_CONTEXT_CEILING,
	coResidentContextCeiling,
	duplicateInstances,
	fitLoadContextLength,
} from "../../src/engine/apis/lmstudio-residency.js";

describe("contracts/lmstudio context fit", () => {
	it("leaves the requested window alone on a server serving nothing else", () => {
		const fit = fitLoadContextLength({
			requested: 262_144,
			resident: [],
			keepModelId: "thinkingcap",
			ceiling: CO_RESIDENT_CONTEXT_CEILING,
		});
		strictEqual(fit.contextLength, 262_144);
		strictEqual(fit.clampedFrom, undefined);
		deepStrictEqual(fit.neighbours, []);
	});

	/**
	 * The defect this pins: loading a 27B model at its 262,144-token default
	 * beside a resident 26B model overflowed the card's KV budget, LM Studio
	 * capped GPU offload rather than failing, and the turn produced 25 tokens in
	 * 2m18s. The same model at 131,072 answered in seconds.
	 */
	it("clamps to the co-resident ceiling while another model is loaded", () => {
		const fit = fitLoadContextLength({
			requested: 262_144,
			resident: [{ modelKey: "google/gemma-4-26b-a4b-qat" }, { modelKey: "thinkingcap" }],
			keepModelId: "thinkingcap",
			ceiling: CO_RESIDENT_CONTEXT_CEILING,
		});
		strictEqual(fit.contextLength, CO_RESIDENT_CONTEXT_CEILING);
		strictEqual(fit.clampedFrom, 262_144);
		deepStrictEqual(fit.neighbours, ["google/gemma-4-26b-a4b-qat"]);
	});

	it("never raises a request that already fits under the ceiling", () => {
		const fit = fitLoadContextLength({
			requested: 32_768,
			resident: [{ modelKey: "memory-small" }],
			keepModelId: "coder",
			ceiling: CO_RESIDENT_CONTEXT_CEILING,
		});
		strictEqual(fit.contextLength, 32_768);
		strictEqual(fit.clampedFrom, undefined);
	});

	it("reads the operator ceiling override, including the off switch", () => {
		strictEqual(coResidentContextCeiling({}), CO_RESIDENT_CONTEXT_CEILING);
		strictEqual(coResidentContextCeiling({ CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT: "196608" }), 196_608);
		strictEqual(coResidentContextCeiling({ CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT: "off" }), undefined);
		strictEqual(
			coResidentContextCeiling({ CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT: "nonsense" }),
			CO_RESIDENT_CONTEXT_CEILING,
		);
	});

	it("does not clamp when the operator turned the ceiling off", () => {
		const fit = fitLoadContextLength({
			requested: 262_144,
			resident: [{ modelKey: "memory-small" }],
			keepModelId: "coder",
			ceiling: undefined,
		});
		strictEqual(fit.contextLength, 262_144);
	});
});

describe("contracts/lmstudio duplicate instances", () => {
	it("reports every instance of the requested model past the first", () => {
		const extras = duplicateInstances(
			[
				{ modelKey: "gemma", identifier: "gemma" },
				{ modelKey: "gemma", identifier: "gemma:2" },
				{ modelKey: "gemma", identifier: "gemma:3" },
				{ modelKey: "coder", identifier: "coder" },
			],
			"gemma",
		);
		deepStrictEqual(
			extras.map((entry) => entry.identifier),
			["gemma:2", "gemma:3"],
		);
	});

	it("reports nothing for a single instance or an absent model", () => {
		deepStrictEqual(duplicateInstances([{ modelKey: "gemma" }, { modelKey: "coder" }], "gemma"), []);
		deepStrictEqual(duplicateInstances([{ modelKey: "coder" }], "gemma"), []);
	});
});

describe("contracts/degraded inference watchdog", () => {
	function manualTimer(): { timer: (fn: () => void, ms: number) => { cancel: () => void }; cancelled: () => boolean } {
		let cancelled = false;
		return {
			timer: () => ({
				cancel: () => {
					cancelled = true;
				},
			}),
			cancelled: () => cancelled,
		};
	}

	it("reports once when the token rate stays under the floor past the grace period", () => {
		const reports: Array<{ tokens: number; tokensPerSecond: number }> = [];
		let now = 0;
		const { timer } = manualTimer();
		const watchdog = startDegradedInferenceWatchdog({
			onDegraded: (report) => reports.push(report),
			graceMs: 30_000,
			now: () => now,
			setTimer: timer,
		});

		watchdog.addTokens(25);
		now = 20_000;
		watchdog.check();
		strictEqual(reports.length, 0, "the grace period has not elapsed");

		now = 138_000;
		watchdog.check();
		watchdog.check();
		strictEqual(reports.length, 1, "a degraded turn is reported exactly once");
		strictEqual(reports[0]?.tokens, 25);
		strictEqual(reports[0] !== undefined && reports[0].tokensPerSecond < DEGRADED_FLOOR_TOKENS_PER_SECOND, true);
	});

	it("stays silent for a healthy generation rate", () => {
		const reports: number[] = [];
		let now = 0;
		const { timer } = manualTimer();
		const watchdog = startDegradedInferenceWatchdog({
			onDegraded: () => reports.push(1),
			graceMs: 30_000,
			now: () => now,
			setTimer: timer,
		});

		now = 60_000;
		watchdog.addTokens(1_800);
		watchdog.check();
		strictEqual(reports.length, 0);
	});

	it("cancels its timer on stop so a finished turn leaves nothing running", () => {
		const { timer, cancelled } = manualTimer();
		const watchdog = startDegradedInferenceWatchdog({ onDegraded: () => {}, setTimer: timer });
		watchdog.stop();
		strictEqual(cancelled(), true);
	});
});
