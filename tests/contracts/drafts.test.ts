import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import litellmRuntime from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { setDiffusionFramesEnabled } from "../../src/engine/apis/diffusion-frames.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import { type DraftOverlayState, formatDraftOverlayBody, takenDraft } from "../../src/interactive/overlays/draft.js";
import {
	DRAFT_DEFAULT,
	DRAFT_SYSTEM_PROMPT,
	DRAFT_TOOL_CALL_REASON,
	draftCandidateFromText,
	draftSystemPrompt,
	draftTemperature,
	isTemperatureRejection,
	parseDraftArgs,
	runDraftWithSamplerFallback,
} from "../../src/session-control/drafts.js";
import { runOutOfTurnRound } from "../../src/session-control/side-question.js";

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
		selected: 0,
		scroll: 0,
	});

	it("shows each candidate's state and the selected draft's text", () => {
		const text = plain(formatDraftOverlayBody(base(), 90, 10).join("\n"));
		ok(text.includes("def fib(n): ..."), "the selected draft's text is shown");
		ok(!text.includes("judge"), "/draft reads unjudged");
	});

	it("holds an open URL while a draft forms and hides a complete password once it settles (#446)", () => {
		const body = (phase: DraftOverlayState["candidates"][number]): string => {
			const state = base();
			state.candidates[0] = phase;
			return plain(formatDraftOverlayBody(state, 90, 10).join("\n"));
		};
		ok(!body({ kind: "streaming", text: "clone https://user:hunter2" }).includes("hunter2"));
		ok(!body({ kind: "streaming", text: "clone https://user:hunter2@host/x now" }).includes("hunter2"));
		ok(!body({ kind: "drafted", text: "clone https://user:hunter2@host/x now" }).includes("hunter2"));
		ok(body({ kind: "streaming", text: "see http://h:8080/health soon" }).includes("http://h:8080/health"));
		ok(body({ kind: "drafted", text: "see http://h:8080 soon" }).includes("http://h:8080"));
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
		selected: 1,
		scroll: 0,
	});

	it("takes only a settled draft, trimmed", () => {
		const state = settled();
		const taken = takenDraft(state);
		ok(taken !== null);
		deepStrictEqual([taken.index, taken.label, taken.text], [1, "B", "memoized fib"]);
		state.selected = 2;
		strictEqual(takenDraft(state), null, "a draft still denoising cannot be taken");
	});

	it("fails a tool-call draft and blocks raw markup even if it reaches the overlay", () => {
		const markup = "<tool_call><function=bash>echo hi</function></tool_call>";
		const candidate = draftCandidateFromText(markup);
		deepStrictEqual(candidate, { status: "failed", reason: DRAFT_TOOL_CALL_REASON });
		deepStrictEqual(draftCandidateFromText(`Some prose\n${markup}\nMore prose`), candidate);
		const state = settled();
		state.candidates[1] = { kind: "failed", reason: DRAFT_TOOL_CALL_REASON };
		ok(plain(formatDraftOverlayBody(state, 90, 10).join("\n")).includes(DRAFT_TOOL_CALL_REASON));
		strictEqual(takenDraft(state), null);
		state.candidates[1] = { kind: "drafted", text: markup };
		strictEqual(takenDraft(state), null, "the use key must reject unclassified markup");
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
				thinkingLevel: "off",
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

	it("asks the wire for the round's own thinking level, never an inferred one", async () => {
		// The bare engine stream inferred "medium" for any reasoning model, so a
		// Qwen-template route got enable_thinking true on every handoff, triage,
		// System One and side round, whatever the caller needed.
		registerClioApiProviders();
		const model = litellmRuntime.synthesizeModel(
			{
				id: "litellm",
				runtime: "litellm",
				url: "http://fixture.invalid",
				capabilities: { reasoning: true, thinkingFormat: "qwen-chat-template" },
			},
			"mini/ornith1.5-35b-moe-q4km",
			null,
		);
		const bodies: Array<Record<string, unknown>> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return frames(["A"]);
		}) as typeof fetch;
		try {
			for (const thinkingLevel of ["off", "high"] as const) {
				await runOutOfTurnRound({
					model: model as never,
					messages: [],
					systemPrompt: "Answer with one letter.",
					userText: "A or B?",
					apiKey: "test-key",
					thinkingLevel,
				});
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		const thinking = bodies.map((body) => (body.chat_template_kwargs as { enable_thinking?: unknown }).enable_thinking);
		deepStrictEqual(thinking, [false, true]);
	});
});
