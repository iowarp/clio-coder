import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import type { Decider } from "../../src/domains/providers/decisions.js";
import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import type { DecisionAnswer } from "../../src/domains/providers/types/inference.js";
import { setDiffusionFramesEnabled } from "../../src/engine/apis/diffusion-frames.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import {
	DRAFT_DEFAULT,
	DRAFT_SYSTEM_PROMPT,
	draftJudgeRequest,
	judgeDrafts,
	parseDraftArgs,
	readDraftVerdict,
} from "../../src/interactive/drafts.js";
import { type DraftOverlayState, formatDraftOverlayBody } from "../../src/interactive/overlays/draft.js";
import { runOutOfTurnRound } from "../../src/interactive/side-question.js";

afterEach(() => setDiffusionFramesEnabled(false));

function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the subject under test.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The judge's answers for three candidates with a planted wrong B, in the
 * shape jev-latest returned live: a `choice` with its distribution, and one
 * `noul` per candidate with no `confidence` field.
 */
const LIVE_ANSWERS: Record<string, DecisionAnswer> = {
	best: { type: "choice", choice: "A", probabilities: { A: 0.99, B: 0, C: 0.01 }, confidence: 0.98 },
	"sound.A": { type: "noul", noul: 0.93 },
	"sound.B": { type: "noul", noul: 0.03 },
	"sound.C": { type: "noul", noul: 0.52 },
};

describe("/draft arguments", () => {
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

describe("/draft judgment", () => {
	it("carries each candidate once in state and names it from the questions", () => {
		const { state, questions } = draftJudgeRequest("sum a list", ["sum(xs)", "reduce(add, xs)"]);
		deepStrictEqual(state, { request: "sum a list", candidates: { A: "sum(xs)", B: "reduce(add, xs)" } });
		deepStrictEqual(Object.keys(questions).sort(), ["best", "sound.A", "sound.B"]);
		deepStrictEqual(questions.best?.criteria, {
			A: "Candidate A in state.candidates",
			B: "Candidate B in state.candidates",
		});
		ok(!JSON.stringify(questions).includes("reduce(add"), "candidate text never repeats inside a question");
	});

	it("reads the pick, its distribution, and an undecided soundness as null", () => {
		const verdict = readDraftVerdict(LIVE_ANSWERS, 3, "jev/jev-latest", 263);
		strictEqual(verdict.picked, "A");
		deepStrictEqual(verdict.probabilities, { A: 0.99, B: 0, C: 0.01 });
		deepStrictEqual(verdict.sound, { A: true, B: false, C: null });
	});

	it("never picks a label outside the candidates it was given", () => {
		const verdict = readDraftVerdict({ ...LIVE_ANSWERS, best: { type: "choice", choice: "Z" } }, 3, "jev", 1);
		strictEqual(verdict.picked, null);
	});

	it("resolves to null for a failing judge and for fewer than two candidates", async () => {
		const failing: Decider = {
			ask: async () => {
				throw new Error("ECONNREFUSED");
			},
			askDetailed: async () => {
				throw new Error("ECONNREFUSED");
			},
		};
		strictEqual(await judgeDrafts(failing, "x", ["a", "b"], "jev"), null);
		let asked = false;
		const counting: Decider = {
			ask: async () => {
				asked = true;
				return LIVE_ANSWERS;
			},
			askDetailed: async () => ({ answers: LIVE_ANSWERS }) as never,
		};
		strictEqual(await judgeDrafts(counting, "x", ["only one"], "jev"), null);
		strictEqual(asked, false, "one candidate is nothing to choose between, so the judge is never billed");
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
		judge: { kind: "judged", verdict: readDraftVerdict(LIVE_ANSWERS, 3, "jev/jev-latest", 263) },
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
		state.judge = { kind: "unjudged", reason: "not judged: bind fleet.decisionProfiles.drafts to a System One profile" };
		const text = plain(formatDraftOverlayBody(state, 90, 10).join("\n"));
		ok(text.includes("bind fleet.decisionProfiles.drafts"));
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
