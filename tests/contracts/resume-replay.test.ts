import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import {
	assistantSessionPayload,
	noticeMessage,
	terminalFailureFromAssistantMessage,
} from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const theme = clioTheme();

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

// A grep tool_result as the on-disk ledger stores it: the full text body plus a
// structured observation envelope in `details` (match/byte counts, offload
// path). The live collapsed ledger line is derived from that envelope.
function grepReplayTurns(): SessionEntry[] {
	const lines: string[] = [];
	for (let i = 1; i <= 261; i += 1) lines.push(`many.txt:${i}: e match line ${String(i).padStart(4, "0")}`);
	const body = `${lines.join("\n")}\n[grep: 261/261+ matches shown (16.0KB of 186.4KB) | full: /state/scratch/x.txt | next: limit=6000]`;
	const observation = {
		unit: "matches",
		shownCount: 261,
		totalCount: null,
		shownBytes: 16100,
		offloadPath: "/state/scratch/x.txt",
	};
	const ts = "2026-07-02T12:00:00.000Z";
	return [
		{
			kind: "message",
			role: "user",
			turnId: "u1",
			parentTurnId: null,
			timestamp: ts,
			payload: { text: "grep e in src" },
		},
		{
			kind: "message",
			role: "tool_call",
			turnId: "a1",
			parentTurnId: "u1",
			timestamp: ts,
			payload: { toolCallId: "g1", toolName: "grep", args: { pattern: "e", path: "src", limit: 3000 } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "a2",
			parentTurnId: "a1",
			timestamp: ts,
			payload: {
				toolCallId: "g1",
				toolName: "grep",
				result: { content: [{ type: "text", text: body }], details: { observation } },
				isError: false,
				durationMs: 114,
			},
		},
		{ kind: "message", role: "assistant", turnId: "a3", parentTurnId: "a2", timestamp: ts, payload: { text: "done" } },
	];
}

function editReplayTurns(): SessionEntry[] {
	const ts = "2026-07-02T12:00:00.000Z";
	return [
		{
			kind: "message",
			role: "tool_call",
			turnId: "edit-call",
			parentTurnId: null,
			timestamp: ts,
			payload: {
				toolCallId: "edit-1",
				toolName: "edit",
				args: { path: "a.ts", edits: [{ oldText: "const old = one;", newText: "const new = two;" }] },
			},
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "edit-result",
			parentTurnId: "edit-call",
			timestamp: ts,
			payload: {
				toolCallId: "edit-1",
				toolName: "edit",
				result: {
					content: [{ type: "text", text: "edited a.ts" }],
					details: { diff: "-1 const old = one;\n+1 const new = two;" },
				},
				isError: false,
			},
		},
	];
}

function localBashReplayTurn(output: string): SessionEntry {
	return {
		kind: "bashExecution",
		turnId: "local-bash",
		parentTurnId: null,
		timestamp: "2026-07-02T12:00:00.000Z",
		command: "printf local",
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
}

describe("contracts/resume replay ledger fidelity", () => {
	it("replays a grep tool as the collapsed one-line ledger summary, not the expanded body", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, grepReplayTurns());
		const rendered = strip(panel.render(100).join("\n"));

		// Collapsed live-parity ledger line: grep verb + outcome facts from the
		// observation envelope (count, bytes, offload path).
		ok(rendered.includes("searching for"), "collapsed grep subline should show the grep verb");
		ok(rendered.includes("261+ matches"), "collapsed line should carry the match count from the observation envelope");
		ok(rendered.includes("full: /state/scratch/x.txt"), "collapsed line should carry the offload path");

		// The expanded body and its UI middle-elision must not appear in replay.
		ok(!rendered.includes("many.txt:1:"), "replay must not render the expanded grep body");
		ok(!rendered.includes("lines hidden"), "replay must not carry the expanded body's middle-elision");
	});

	it("keeps a replayed edit diff plain when the operator expands it", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, editReplayTurns());
		panel.toggleLastToolExpanded();
		const rendered = panel.render(100).join("\n");

		ok(strip(rendered).includes("-1 const old = one;"), rendered);
		ok(strip(rendered).includes("+1 const new = two;"), rendered);
		ok(!rendered.includes(`${String.fromCharCode(27)}[7m`), "replay must not carry live word emphasis");
	});
});

describe("contracts/resume replay operator turns", () => {
	const ts = "2026-07-02T12:00:00.000Z";
	const reminder =
		'<system-reminder>\n[Skills] 9 installed. Start this task by listing them with context(scope="skills").\n</system-reminder>';

	it("renders the operator's typed text, not the composed prompt, when the entry carries it", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "message",
				role: "user",
				turnId: "u1",
				parentTurnId: null,
				timestamp: ts,
				payload: { text: `${reminder}\n\nPlan an input-validation layer`, operatorText: "Plan an input-validation layer" },
			},
		]);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("Plan an input-validation layer"), rendered);
		ok(!rendered.includes("system-reminder"), rendered);
		ok(!rendered.includes("[Skills]"), rendered);
	});

	it("drops the leading reminder scaffolding from an entry written before operator text was persisted", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "message",
				role: "user",
				turnId: "u1",
				parentTurnId: null,
				timestamp: ts,
				payload: { text: `${reminder}\n\nPlan an input-validation layer` },
			},
		]);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("Plan an input-validation layer"), rendered);
		ok(!rendered.includes("system-reminder"), rendered);
		ok(!rendered.includes("[Skills]"), rendered);
	});

	it("leaves a reminder the operator quoted mid-message alone", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "message",
				role: "user",
				turnId: "u1",
				parentTurnId: null,
				timestamp: ts,
				payload: { text: "why did you show me <system-reminder>this</system-reminder>?" },
			},
		]);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("why did you show me <system-reminder>this</system-reminder>?"), rendered);
	});
});

describe("contracts/resume replay transcript notices", () => {
	const ts = "2026-07-02T12:00:00.000Z";

	it("styles a replayed [model] tag dim with a muted body", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "modelChange",
				turnId: "m1",
				parentTurnId: null,
				timestamp: ts,
				provider: "anthropic",
				modelId: "claude-opus-4-8",
			},
		]);
		const rendered = panel.render(80).join("\n");
		ok(strip(rendered).includes("[model] anthropic/claude-opus-4-8"), "the model line replays its content");
		ok(rendered.includes(theme.fg("dim", "[model]")), "the [model] tag renders dim");
		ok(rendered.includes(theme.fg("muted", " anthropic/claude-opus-4-8")), "the [model] body renders muted");
	});

	it("styles a replayed [retry] tag in warning with a muted body", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "custom",
				customType: "retryStatus",
				turnId: "c1",
				parentTurnId: null,
				timestamp: ts,
				data: { phase: "waiting", attempt: 2, maxAttempts: 5, seconds: 3 },
			},
		]);
		const rendered = panel.render(80).join("\n");
		ok(strip(rendered).includes("[retry] attempt 2/5 in 3s"), "the retry line replays its content");
		ok(rendered.includes(theme.fg("warning", "[retry]")), "the [retry] tag renders warning, not dim");
		ok(rendered.includes(theme.fg("muted", " attempt 2/5 in 3s")), "the retry body renders muted");
	});

	// A cancelled turn is persisted `aborted` so the context estimator skips it
	// when looking for the last usage anchor. Marking it that way used to also
	// stamp a synthesized "request aborted" on it, so a resumed session showed a
	// red error line under the cancellation notice: the exact noise the live
	// cancel path suppresses. Built from the real persistence shaping rather than
	// a hand-written payload, so the round trip is what is under test.
	it("replays a cancelled turn as the notice alone, with no aborted error line", () => {
		const notice = noticeMessage("[Clio Coder] active response cancelled.");
		const payload = assistantSessionPayload(notice, terminalFailureFromAssistantMessage(notice));
		strictEqual(payload.stopReason, "aborted", "the cancelled turn stays aborted for context accounting");

		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{ kind: "message", role: "user", turnId: "u1", parentTurnId: null, timestamp: ts, payload: { text: "hi" } },
			{ kind: "message", role: "assistant", turnId: "a1", parentTurnId: "u1", timestamp: ts, payload },
		]);
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("[Clio Coder] active response cancelled."), "the notice replays");
		ok(!rendered.includes("[aborted]"), "the notice explains itself and carries no error line");
	});

	/**
	 * `promptRecompiled` is a diagnostics breadcrumb. The live transcript never
	 * showed it; replay dumped `custom:promptRecompiled` plus a JSON blob of
	 * hashes into the middle of a forked conversation, so /fork and /resume
	 * rendered a line the session itself never did.
	 */
	it("suppresses diagnostics custom entries the live transcript never rendered", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{ kind: "message", role: "user", turnId: "u1", parentTurnId: null, timestamp: ts, payload: { text: "hi" } },
			{
				kind: "custom",
				customType: "promptRecompiled",
				turnId: "c1",
				parentTurnId: "u1",
				timestamp: ts,
				data: { previousHash: null, hash: "9994f4add15203e9", tokenEstimate: 2366 },
			},
			{ kind: "message", role: "assistant", turnId: "a1", parentTurnId: "c1", timestamp: ts, payload: { text: "ok" } },
		]);
		const rendered = strip(panel.render(80).join("\n"));
		ok(!rendered.includes("promptRecompiled"), "the raw entry type must not reach the transcript");
		ok(!rendered.includes("tokenEstimate"), "nor its JSON payload");
		ok(rendered.includes("ok"), "the surrounding turns still replay");
	});

	it("still replays a custom entry a writer marked for display", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{
				kind: "custom",
				customType: "operatorNote",
				turnId: "c1",
				parentTurnId: null,
				timestamp: ts,
				display: true,
				data: { note: "visible" },
			},
		]);
		ok(strip(panel.render(80).join("\n")).includes("custom:operatorNote"), "an opted-in entry still renders");
	});

	it("keeps the aborted line on a mid-stream abort the provider reported", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, [
			{ kind: "message", role: "user", turnId: "u1", parentTurnId: null, timestamp: ts, payload: { text: "hi" } },
			{
				kind: "message",
				role: "assistant",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: ts,
				payload: { text: "partial answ", stopReason: "aborted", errorMessage: "Request was aborted." },
			},
		]);
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("[aborted] Request was aborted."), "a reported abort still says it was aborted");
	});
});

describe("contracts/resume replay transcript detail policy", () => {
	it("renders a replayed transcript from the policy alone: folded under default, open under verbose with no toggle", () => {
		const folded = createChatPanel({ getOutputVerbosity: () => "default" });
		rehydrateChatPanelFromTurns(folded, [...grepReplayTurns(), ...editReplayTurns()]);
		let rendered = folded.render(100).join("\n");
		ok(!strip(rendered).includes("many.txt:1:"), "default keeps the grep body closed");
		ok(strip(rendered).includes("editing a.ts"), strip(rendered));
		ok(strip(rendered).includes("+1 const new = two;"), "default keeps the edit diff on the folded row");
		ok(!rendered.includes(`${String.fromCharCode(27)}[7m`), "the replayed folded diff is plain");

		// /export builds exactly this panel: verbose policy, unbounded bodies, no toggles.
		const exported = createChatPanel({ getOutputVerbosity: () => "verbose", unboundedToolBodies: true });
		rehydrateChatPanelFromTurns(exported, [...grepReplayTurns(), ...editReplayTurns()], { unboundedToolBodies: true });
		rendered = exported.render(100).join("\n");
		ok(strip(rendered).includes("many.txt:1:"), "verbose opens the grep body");
		ok(strip(rendered).includes("many.txt:150:"), "unbounded keeps the middle rows");
		ok(!strip(rendered).includes("lines hidden"), "no terminal-only elision in the export");
		ok(strip(rendered).includes("change ·"), "the edit body is open");
		ok(!rendered.includes(`${String.fromCharCode(27)}[7m`), "nothing terminal-only leaks: replay diffs stay plain");

		// Clearing overrides after a session switch leaves the policy's view.
		folded.toggleAllToolsExpanded();
		ok(strip(folded.render(100).join("\n")).includes("many.txt:1:"));
		folded.clearFoldOverrides();
		ok(!strip(folded.render(100).join("\n")).includes("many.txt:1:"), "clear returns to the folded policy view");
	});

	it("applies policy and operator overrides to replayed local bash", () => {
		const folded = createChatPanel({ getOutputVerbosity: () => "default" });
		rehydrateChatPanelFromTurns(folded, [localBashReplayTurn("LOCAL-BASH-BODY")]);
		let rendered = strip(folded.render(100).join("\n"));
		ok(!rendered.includes("LOCAL-BASH-BODY"), rendered);
		ok(folded.toggleLastToolExpanded(), "Alt+O reaches the replayed local bash block");
		rendered = strip(folded.render(100).join("\n"));
		ok(rendered.includes("LOCAL-BASH-BODY"), rendered);

		const verbose = createChatPanel({ getOutputVerbosity: () => "verbose" });
		rehydrateChatPanelFromTurns(verbose, [localBashReplayTurn("LOCAL-BASH-BODY")]);
		ok(strip(verbose.render(100).join("\n")).includes("LOCAL-BASH-BODY"), "verbose policy opens replayed local bash");
	});

	it("keeps complete model-tool and local-bash bodies in unbounded export replay", () => {
		const modelLines = Array.from({ length: 700 }, (_, index) => `MODEL-EXPORT-${String(index + 1).padStart(4, "0")}`);
		const toolTurns = grepReplayTurns();
		const result = toolTurns.find(
			(entry): entry is Extract<SessionEntry, { kind: "message" }> =>
				entry.kind === "message" && entry.role === "tool_result",
		);
		ok(result);
		result.payload = {
			...(result.payload as Record<string, unknown>),
			result: { content: [{ type: "text", text: modelLines.join("\n") }] },
		};
		const localLines = Array.from({ length: 300 }, (_, index) => `LOCAL-EXPORT-${String(index + 1).padStart(4, "0")}`);
		const exported = createChatPanel({ getOutputVerbosity: () => "verbose", unboundedToolBodies: true });
		rehydrateChatPanelFromTurns(exported, [...toolTurns, localBashReplayTurn(localLines.join("\n"))], {
			unboundedToolBodies: true,
		});

		const rendered = strip(exported.render(100).join("\n"));
		ok(rendered.includes("MODEL-EXPORT-0700"), "the paired model-tool tail survives export replay");
		ok(rendered.includes("LOCAL-EXPORT-0300"), "the local-bash tail survives export replay");
		ok(!rendered.includes("truncated from replay context"), rendered);
		ok(!rendered.includes("lines hidden"), rendered);
	});
});
