import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatSteerCandidates,
	parseEditorSteerMention,
	type RunningDispatchRef,
	resolveSteerTarget,
} from "../../src/interactive/editor-steer.js";

const run = (runId: string, agentId: string): RunningDispatchRef => ({ runId, agentId });

describe("contracts/editor-steer parser", () => {
	it("parses @<target> <text> with a bare-word target", () => {
		deepStrictEqual(parseEditorSteerMention("@scout only list directories"), {
			target: "scout",
			text: "only list directories",
		});
		deepStrictEqual(parseEditorSteerMention("  @34o7kkk stop editing files  "), {
			target: "34o7kkk",
			text: "stop editing files",
		});
		deepStrictEqual(parseEditorSteerMention("@code-reviewer focus on chat-loop.ts"), {
			target: "code-reviewer",
			text: "focus on chat-loop.ts",
		});
	});

	it("preserves multiline steer text", () => {
		const parsed = parseEditorSteerMention("@scout first line\nsecond line");
		strictEqual(parsed?.target, "scout");
		strictEqual(parsed?.text, "first line\nsecond line");
	});

	it("rejects targets that look like file references so @file expansion keeps working", () => {
		strictEqual(parseEditorSteerMention("@package.json explain the scripts"), null);
		strictEqual(parseEditorSteerMention("@src/interactive/index.ts what does this do"), null);
		strictEqual(parseEditorSteerMention("@.config/settings.yaml check"), null);
	});

	it("rejects non-mention lines and mentions without text", () => {
		strictEqual(parseEditorSteerMention("plain chat message"), null);
		strictEqual(parseEditorSteerMention("!ls -la"), null);
		strictEqual(parseEditorSteerMention("/help"), null);
		strictEqual(parseEditorSteerMention("@scout"), null);
		strictEqual(parseEditorSteerMention("@scout   "), null);
		strictEqual(parseEditorSteerMention("a@scout hello"), null);
	});
});

describe("contracts/editor-steer resolution", () => {
	const running = [run("34o7kkk9qs04", "scout"), run("36gwrgruzned", "verifier"), run("36zzz111aaaa", "scout")];

	it("resolves a unique agentId to its run", () => {
		deepStrictEqual(resolveSteerTarget("verifier", running), {
			kind: "match",
			run: run("36gwrgruzned", "verifier"),
		});
	});

	it("treats a duplicated agentId as ambiguous and lists the candidates", () => {
		const resolution = resolveSteerTarget("scout", running);
		strictEqual(resolution.kind, "ambiguous");
		if (resolution.kind === "ambiguous") {
			deepStrictEqual(resolution.candidates, [run("34o7kkk9qs04", "scout"), run("36zzz111aaaa", "scout")]);
		}
	});

	it("falls back to runId prefix when no agentId matches", () => {
		deepStrictEqual(resolveSteerTarget("34o7", running), {
			kind: "match",
			run: run("34o7kkk9qs04", "scout"),
		});
	});

	it("reports an ambiguous runId prefix", () => {
		const resolution = resolveSteerTarget("36", running);
		strictEqual(resolution.kind, "ambiguous");
		if (resolution.kind === "ambiguous") {
			strictEqual(resolution.candidates.length, 2);
		}
	});

	it("prefers an exact agentId over a runId prefix shared with another run", () => {
		const tricky = [run("scout111aaaa", "verifier"), run("9999zzzz8888", "scout")];
		deepStrictEqual(resolveSteerTarget("scout", tricky), {
			kind: "match",
			run: run("9999zzzz8888", "scout"),
		});
	});

	it("returns none when nothing matches", () => {
		deepStrictEqual(resolveSteerTarget("nonsense", running), { kind: "none" });
	});

	it("formats candidates as agentId (runId) pairs", () => {
		strictEqual(
			formatSteerCandidates([run("34o7kkk9qs04", "scout"), run("36gwrgruzned", "verifier")]),
			"scout (34o7kkk9qs04), verifier (36gwrgruzned)",
		);
	});
});
