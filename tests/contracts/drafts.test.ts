import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import { draftTakenOutcome } from "../../src/domains/system-one/outcomes.js";
import { setDiffusionFramesEnabled } from "../../src/engine/apis/diffusion-frames.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import {
	DRAFT_DEFAULT,
	DRAFT_SYSTEM_PROMPT,
	DRAFT_TOOL_CALL_REASON,
	draftCandidateFromText,
	draftSystemPrompt,
	draftsToJudge,
	draftTemperature,
	isTemperatureRejection,
	parseDraftArgs,
	runDraftWithSamplerFallback,
} from "../../src/interactive/drafts.js";
import type { OverlayGeneralOpenersDeps } from "../../src/interactive/overlay-general-openers.js";
import { createOverlayGeneralOpeners } from "../../src/interactive/overlay-general-openers.js";
import {
	type DraftOverlayState,
	formatDraftOverlayBody,
	type OpenDraftOverlayOptions,
	takenDraft,
} from "../../src/interactive/overlays/draft.js";
import { runOutOfTurnRound } from "../../src/interactive/side-question.js";

afterEach(() => setDiffusionFramesEnabled(false));

function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the subject under test.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("/draft arguments", () => {
	it("omits temperature for every Claude model that answers one with HTTP 400, on every transport", () => {
		for (const id of [
			"claude-sonnet-5",
			"anthropic/claude-sonnet-5",
			"us.anthropic.claude-sonnet-5",
			"claude-fable-5",
			"claude-opus-4-7",
			"anthropic/claude-opus-4.8:batch",
			"claude-opus-5-5",
		]) {
			strictEqual(draftTemperature(id, 0.7), undefined, id);
		}
		// Models that still take a sampler keep the spread that makes drafts differ,
		// including dated snapshots whose date is not a minor version.
		for (const id of ["mercury-2.5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-20250514"]) {
			strictEqual(draftTemperature(id, 0.7), 0.7, id);
		}
	});
	it("omits temperature where the transport refuses it and varies the drafts by prompt instead", () => {
		strictEqual(draftTemperature({ id: "gpt-6-luna", api: "openai-codex-responses" }, 0.7), undefined);
		strictEqual(draftTemperature({ id: "gpt-5", api: "openai-responses", reasoning: true }, 0.7), undefined);
		strictEqual(
			draftTemperature({ id: "x", api: "openai-completions", compat: { supportsTemperature: false } }, 0.7),
			undefined,
		);
		strictEqual(draftTemperature({ id: "gpt-4o", api: "openai-responses", reasoning: false }, 0.7), 0.7);
		strictEqual(draftSystemPrompt(0, true), DRAFT_SYSTEM_PROMPT);
		ok(draftSystemPrompt(1, true).startsWith(DRAFT_SYSTEM_PROMPT) && draftSystemPrompt(1, true) !== DRAFT_SYSTEM_PROMPT);
		strictEqual(draftSystemPrompt(1, false), DRAFT_SYSTEM_PROMPT, "a candidate that kept its sampler needs no angle");
	});
	it("retries a draft once without the sampler when the provider refuses temperature", async () => {
		ok(isTemperatureRejection("Codex error: Unsupported parameter: temperature"));
		ok(!isTemperatureRejection("HTTP 429 rate limited"));
		const seen: Array<number | undefined> = [];
		const text = await runDraftWithSamplerFallback(1, 0.7, async (sampling) => {
			seen.push(sampling.temperature);
			if (sampling.temperature !== undefined) throw new Error("Codex error: Unsupported parameter: temperature");
			return "drafted";
		});
		strictEqual(text, "drafted");
		deepStrictEqual(seen, [0.7, undefined]);
		// Any other failure is not retried.
		let calls = 0;
		await runDraftWithSamplerFallback(0, 0.3, async () => {
			calls += 1;
			throw new Error("HTTP 500");
		}).then(
			() => ok(false, "should reject"),
			(error: Error) => strictEqual(error.message, "HTTP 500"),
		);
		strictEqual(calls, 1);
	});
	it("reads a leading count and defaults to three", () => {
		deepStrictEqual(parseDraftArgs("2 write a retry helper"), { count: 2, request: "write a retry helper" });
		deepStrictEqual(parseDraftArgs("write a retry helper"), { count: DRAFT_DEFAULT, request: "write a retry helper" });
		// A number that is the request's own first word still reads as a count
		// only when a request follows it.
		deepStrictEqual(parseDraftArgs("42"), { count: DRAFT_DEFAULT, request: "42" });
	});

	it("refuses a count out of range rather than clamping it", () => {
		deepStrictEqual(parseDraftArgs("9 write it"), { error: "draft count must be 2 to 4, got 9" });
		deepStrictEqual(parseDraftArgs("1 write it"), { error: "draft count must be 2 to 4, got 1" });
		deepStrictEqual(parseDraftArgs("   "), { error: "a draft needs a request" });
	});
});

describe("/draft overlay", () => {
	const base = (): DraftOverlayState => ({
		request: "fib(n)",
		candidates: [
			{ kind: "drafted", text: "def fib(n): ..." },
			{ kind: "drafted", text: "def fib(n): return n * 2" },
			{ kind: "drafted", text: "memoized fib" },
		],
		judge: {
			kind: "judged",
			verdict: {
				picked: "A",
				probabilities: { A: 0.99, B: 0, C: 0.01 },
				sound: { A: true, B: false, C: null },
				source: "jev/jev-latest",
				elapsedMs: 263,
			},
		},
		selected: 0,
		scroll: 0,
	});

	it("shows each candidate's mass, the pick, and a candidate judged unsound", () => {
		const text = plain(formatDraftOverlayBody(base(), 90, 10).join("\n"));
		ok(/A\s+█+░*\s0\.99\s+✓ picked/u.test(text), text);
		ok(/B\s+░+\s0\.00\s+judged unsound/u.test(text), text);
		ok(!/C.*judged unsound/u.test(text), "an undecided soundness says nothing");
		ok(text.includes("judged by jev/jev-latest in 263ms"));
		ok(text.includes("def fib(n): ..."), "the selected draft's text is shown");
	});

	it("says why a draft was not judged instead of drawing empty bars", () => {
		const state = base();
		state.judge = { kind: "unjudged", reason: "not judged: bind systemOne.sites.drafts to an engine" };
		const text = plain(formatDraftOverlayBody(state, 90, 10).join("\n"));
		ok(text.includes("bind systemOne.sites.drafts"));
		ok(!text.includes("█"));
	});

	it("windows a long draft and counts what is below", () => {
		const state = base();
		state.candidates[0] = { kind: "drafted", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") };
		const text = plain(formatDraftOverlayBody(state, 90, 5).join("\n"));
		ok(text.includes("line 4"));
		ok(!text.includes("line 5\n"));
		ok(text.includes("↓ 25 more lines"));
	});
});

describe("/draft use key", () => {
	const settled = (): DraftOverlayState => ({
		request: "fib(n)",
		candidates: [
			{ kind: "drafted", text: "def fib(n): ..." },
			{ kind: "drafted", text: "  memoized fib\n" },
			{ kind: "streaming", text: "half a dra" },
		],
		judge: {
			kind: "judged",
			verdict: {
				picked: "A",
				probabilities: { A: 0.9, B: 0.1 },
				sound: {},
				source: "jev/jev-latest",
				elapsedMs: 263,
				ref: "draft_1",
			},
		},
		selected: 1,
		scroll: 0,
	});

	it("takes only a settled draft, trimmed, with the verdict that judged it", () => {
		const state = settled();
		const taken = takenDraft(state);
		ok(taken !== null);
		deepStrictEqual([taken.index, taken.label, taken.text], [1, "B", "memoized fib"]);
		strictEqual(taken.verdict?.ref, "draft_1");
		state.selected = 2;
		strictEqual(takenDraft(state), null, "a draft still denoising cannot be taken");
	});

	it("fails a tool-call draft and blocks raw markup even if it reaches the overlay", () => {
		const markup = "<tool_call><function=bash>echo hi</function></tool_call>";
		const candidate = draftCandidateFromText(markup);
		deepStrictEqual(candidate, { status: "failed", reason: DRAFT_TOOL_CALL_REASON });
		deepStrictEqual(draftCandidateFromText(`Some prose\n${markup}\nMore prose`), candidate);
		deepStrictEqual(draftsToJudge([candidate, { status: "drafted", text: "a reply" }]), {
			reason: "not judged: a draft failed or came back empty",
		});
		const state = settled();
		state.candidates[1] = { kind: "failed", reason: DRAFT_TOOL_CALL_REASON };
		ok(plain(formatDraftOverlayBody(state, 90, 10).join("\n")).includes(DRAFT_TOOL_CALL_REASON));
		strictEqual(takenDraft(state), null);
		state.candidates[1] = { kind: "drafted", text: markup };
		strictEqual(takenDraft(state), null, "the use key must reject unclassified markup");
	});

	it("keeps a clean draft takeable when the judge marks it unsound", () => {
		const state = settled();
		if (state.judge.kind !== "judged") throw new Error("expected a judged draft");
		state.judge.verdict.sound.B = false;
		strictEqual(takenDraft(state)?.text, "memoized fib");
	});

	it("records the taken label, the judge's pick and whether they agree, keyed by the judging call", () => {
		deepStrictEqual(draftTakenOutcome({ ref: "draft_1", taken: "B", judgedPick: "A" }), {
			ref: "draft_1",
			source: "draft",
			facts: { taken: "B", judgedPick: "A", agreed: false },
		});
		deepStrictEqual(draftTakenOutcome({ ref: "draft_1", taken: "A", judgedPick: "A" }).facts, {
			taken: "A",
			judgedPick: "A",
			agreed: true,
		});
		strictEqual(draftTakenOutcome({ ref: "draft_1", taken: "A", judgedPick: null }).facts.agreed, false);
	});

	it("records a draft taken while the judge still runs under the judging call's ref, with no pick", async () => {
		let overlay: OpenDraftOverlayOptions | undefined;
		let judgeRef: string | undefined;
		let judgeSignal: AbortSignal | undefined;
		const recorded: Array<{ ref: string; source: string; facts: Readonly<Record<string, unknown>> }> = [];
		const composed: string[] = [];
		const deps = {
			transitions: { state: "closed" },
			tui: {},
			terminal: { columns: 100 },
			requestRender() {},
			closeOverlay: () => overlay?.onClose(),
			composer: { getText: () => "", setText: (text: string) => composed.push(text) },
			recordOutcome: (outcome: (typeof recorded)[number]) => recorded.push(outcome),
			openDraftOverlay: (_tui: unknown, options: OpenDraftOverlayOptions) => {
				overlay = options;
				return { setCandidate() {}, setJudge() {}, refuse() {} };
			},
			draftCandidates: async () => ({
				status: "drafted",
				aborted: false,
				candidates: [
					{ status: "drafted", text: "first" },
					{ status: "drafted", text: "second" },
				],
			}),
			judgeDrafts: (_request: string, _texts: ReadonlyArray<string>, signal: AbortSignal, ref: string) => {
				judgeRef = ref;
				judgeSignal = signal;
				return new Promise(() => {});
			},
		} as unknown as OverlayGeneralOpenersDeps;
		createOverlayGeneralOpeners(deps).openDraft("write it", 2);
		while (judgeRef === undefined) await new Promise((resolve) => setImmediate(resolve));
		ok(overlay?.onUse);
		overlay.onUse({ index: 1, label: "B", text: "second", verdict: null });
		deepStrictEqual(composed, ["second"]);
		strictEqual(judgeSignal?.aborted, true, "taking a draft aborts the judge");
		deepStrictEqual(recorded, [
			{ ref: judgeRef, source: "draft", facts: { taken: "B", judgedPick: null, agreed: false } },
		]);
	});
});

describe("/draft rounds", () => {
	function mercury(): Model<"openai-completions"> {
		return inceptionRuntime.synthesizeModel(
			{ id: "inception", runtime: "inception", defaultModel: "mercury-2.5" },
			"mercury-2.5",
			null,
		) as Model<"openai-completions">;
	}

	function frames(texts: ReadonlyArray<string>): Response {
		const chunks = texts.map((content, index) => ({
			id: "draft",
			model: "mercury-2.5",
			choices: [{ index: 0, delta: { content }, finish_reason: index === texts.length - 1 ? "stop" : null }],
			diffusion_meta: { diffusion_content: true, diffusion_progress: index === texts.length - 1 ? 1 : 0 },
		}));
		const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	it("sends the candidate's temperature and previews each frame whole", async () => {
		// The TUI registers Clio's completions adapter at boot; without it the
		// engine seam falls through to pi-ai's own and frames concatenate.
		registerClioApiProviders();
		setDiffusionFramesEnabled(true);
		let body: Record<string, unknown> = {};
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return frames(["d%f f(x)", "def f(x)"]);
		}) as typeof fetch;
		const previews: string[] = [];
		try {
			const result = await runOutOfTurnRound({
				model: mercury() as never,
				messages: [],
				systemPrompt: DRAFT_SYSTEM_PROMPT,
				userText: "write f",
				apiKey: "test-key",
				temperature: 0.7,
				onDelta: (text) => previews.push(text),
			});
			strictEqual(result.text, "def f(x)");
		} finally {
			globalThis.fetch = realFetch;
		}
		strictEqual(body.temperature, 0.7);
		deepStrictEqual(previews, ["d%f f(x)", "def f(x)"], "a preview is one frame, never two glued together");
	});
});
