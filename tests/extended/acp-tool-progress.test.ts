import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AcpServerChat, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import {
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
} from "../../src/engine/acp/types.js";
import { fakeTransport } from "../harness/acp-fake-transport.js";

interface TurnScript {
	emit(event: unknown): void;
	/** Moves the injected clock forward; the interval floor measures against it. */
	advance(ms: number): void;
}

function scriptedChat(script: (turn: TurnScript) => void, advance: (ms: number) => void): AcpServerChat {
	let emit: (event: unknown) => void = () => {};
	return {
		submit: async () => {
			script({ emit: (event) => emit(event), advance });
		},
		cancel: () => {},
		onEvent: (handler) => {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		isStreaming: () => false,
		getSessionId: () => null,
	};
}

const TOOL_START = {
	type: "tool_execution_start",
	toolCallId: "call-1",
	toolName: "bash",
	args: { command: "make -j" },
};

const TOOL_END = {
	type: "tool_execution_end",
	toolCallId: "call-1",
	toolName: "bash",
	result: { output: "build ok" },
	isError: false,
};

function progressEvent(output: string, toolCallId = "call-1"): Record<string, unknown> {
	return { type: "tool_execution_update", toolCallId, toolName: "bash", partialResult: { output } };
}

async function runTurn(input: { optIn: boolean | { capability: unknown }; script: (turn: TurnScript) => void }) {
	const peer = fakeTransport();
	let clock = 1_000_000;
	const served = serveClioAcpAgent({
		transport: peer.transport,
		chat: scriptedChat(input.script, (ms) => {
			clock += ms;
		}),
		cwd: process.cwd(),
		now: () => clock,
	});
	// `true` is the documented opt-in; an object carries a deliberately wrong one,
	// and `false` sends no client capabilities at all.
	const capability = input.optIn === true ? { version: 1 } : input.optIn === false ? null : input.optIn.capability;
	const init = (await peer.call("initialize", {
		protocolVersion: 1,
		...(capability === null ? {} : { clientCapabilities: { _meta: { "clio-coder/toolProgress": capability } } }),
	})) as { agentCapabilities: { _meta: Record<string, unknown> } };
	const session = (await peer.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await peer.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "build" }] });
	peer.transport.close();
	strictEqual(await served, 0);
	const updates = peer.notifications
		.filter((entry) => entry.method === "session/update")
		.map((entry) => (entry.params as { update: Record<string, unknown> }).update);
	return {
		init,
		updates,
		progress: updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "in_progress"),
		terminal: updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed"),
	};
}

/** The text of one `toolCallContent` payload. */
function progressText(update: Record<string, unknown>): string {
	const content = update.content as Array<{ content: { text: string } }>;
	return content[0]?.content.text ?? "";
}

describe("contracts/acp streams a running tool's cumulative output only to a client that opted in", () => {
	it("keeps URL credentials out of a tool's terminal content and leaves other output alone (#446)", async () => {
		const turn = await runTurn({
			optIn: false,
			script: ({ emit }) => {
				emit(TOOL_START);
				emit({
					...TOOL_END,
					result: { output: "cloned https://user:hunter2@host/x; BASE_TOKENS=100 at http://h:8080/health" },
				});
			},
		});
		strictEqual(
			progressText(turn.terminal[0] ?? {}),
			"cloned https://user:[redacted]@host/x; BASE_TOKENS=100 at http://h:8080/health",
		);
	});

	it("keeps URL credentials out of progress frames, and an open URL back until it resolves (#446)", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (const snapshot of [
					"clone https://user:hunter2",
					"clone https://user:hunter2@host/x done",
					"see http://h:8080/health\n",
				]) {
					advance(1000);
					emit(progressEvent(snapshot));
				}
				emit(TOOL_END);
			},
		});
		strictEqual(
			turn.progress.map(progressText).join("|"),
			"clone https://user:|clone https://user:[redacted]@host/x done|see http://h:8080/health\n",
		);
	});

	it("sends no in-progress frames to a client that did not opt in, and still sends the terminal update", async () => {
		const turn = await runTurn({
			optIn: false,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (const snapshot of ["a", "ab", "abc"]) {
					advance(1000);
					emit(progressEvent(snapshot));
				}
				emit(TOOL_END);
			},
		});
		strictEqual(turn.progress.length, 0);
		strictEqual(turn.terminal.length, 1);
	});

	// A near-miss opt-in is the dangerous case: a client that sent one believes it
	// asked for nothing, so honouring it would leak an unrequested stream to a
	// strict client. Only the exact `{version: 1}` record turns the stream on.
	it("sends no in-progress frames when the opt-in is a near miss", async () => {
		for (const [label, capability] of [
			["a version this build does not speak", { version: 2 }],
			["a version that is a string", { version: "1" }],
			["a record with no version at all", {}],
			["a bare true", true],
			["an array", [{ version: 1 }]],
			["an explicit null", null],
		] as Array<[string, unknown]>) {
			const turn = await runTurn({
				optIn: { capability },
				script: ({ emit, advance }) => {
					emit(TOOL_START);
					for (const snapshot of ["a", "ab", "abc"]) {
						advance(1000);
						emit(progressEvent(snapshot));
					}
					emit(TOOL_END);
				},
			});
			const name = `sends no in-progress frames when the opt-in is ${label}`;
			strictEqual(turn.progress.length, 0, name);
			strictEqual(turn.terminal.length, 1, name);
		}
	});

	it("announces its bounds and forwards each distinct snapshot as a non-terminal tool_call_update", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (const snapshot of ["a", "ab", "abc"]) {
					advance(1000);
					emit(progressEvent(snapshot));
				}
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.init.agentCapabilities._meta["clio-coder/toolProgress"], {
			version: 1,
			minIntervalMs: ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
			maxFramesPerCall: ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
			maxContentBytes: ACP_MAX_CHUNK_BYTES,
		});
		deepStrictEqual(turn.progress.map(progressText), ["a", "ab", "abc"]);
		for (const frame of turn.progress) strictEqual(frame.toolCallId, "call-1");
		// The terminal update is unaffected: it still arrives exactly once, after
		// every progress frame, and it is the last word on the call.
		strictEqual(turn.terminal.length, 1);
		strictEqual(turn.updates.indexOf(turn.terminal[0] as Record<string, unknown>), turn.updates.length - 1);
	});

	it("stops at the per-call frame ceiling instead of streaming a long-running tool without end", async () => {
		const total = ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL + 6;
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				for (let index = 0; index < total; index += 1) {
					advance(1000);
					emit(progressEvent(`line ${index}`));
				}
				emit(TOOL_END);
			},
		});
		strictEqual(turn.progress.length, ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL);
		strictEqual(progressText(turn.progress[0] as Record<string, unknown>), "line 0");
		strictEqual(
			progressText(turn.progress[ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL - 1] as Record<string, unknown>),
			`line ${ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL - 1}`,
		);
		strictEqual(turn.terminal.length, 1);
	});

	it("holds the interval floor, so a burst under it collapses to the snapshot that crosses it", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				emit(progressEvent("first"));
				advance(ACP_MIN_TOOL_PROGRESS_INTERVAL_MS - 1);
				emit(progressEvent("second"));
				advance(1);
				emit(progressEvent("third"));
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.progress.map(progressText), ["first", "third"]);
	});

	it("does not re-send a cumulative snapshot the client already has", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				emit(TOOL_START);
				emit(progressEvent("same"));
				advance(1000);
				emit(progressEvent("same"));
				advance(1000);
				emit(progressEvent("changed"));
				emit(TOOL_END);
			},
		});
		deepStrictEqual(turn.progress.map(progressText), ["same", "changed"]);
	});

	it("drops a frame that names no open call rather than inventing one", async () => {
		const turn = await runTurn({
			optIn: true,
			script: ({ emit, advance }) => {
				// Before the call opens, for a call that never opened, and after the
				// call has already reached its terminal update.
				emit(progressEvent("early"));
				emit(TOOL_START);
				advance(1000);
				emit(progressEvent("other", "call-9"));
				emit(TOOL_END);
				advance(1000);
				emit(progressEvent("late"));
			},
		});
		strictEqual(turn.progress.length, 0);
		strictEqual(turn.terminal.length, 1);
		ok(turn.updates.every((update) => update.toolCallId === undefined || update.toolCallId === "call-1"));
	});
});

it("keeps compaction failure lines in the reply, where context status does not go (c2b-3)", async () => {
	// The failure lines as the compaction paths word them, at the levels they emit.
	const failures: ReadonlyArray<{ level: "info" | "warning" | "error"; text: string }> = [
		{
			level: "warning",
			text:
				"[Clio Coder] auto-compaction failed; context at 28.6K tokens. 401 invalid api key. This turn goes on without it; /context compact tries again; /model picks another route to summarize on.",
		},
		{
			level: "info",
			text: "[Clio Coder] automatic compaction failed: the summary came back empty. This turn goes on without it.",
		},
		{ level: "info", text: "[Clio Coder] compact-on-overflow failed: compaction stream failed: 429" },
		{
			level: "error",
			text:
				"[/context compact] failed; context unchanged at 30.1K tokens. 401 invalid api key. /context compact tries again; /model picks another route to summarize on.",
		},
		{ level: "info", text: "Portable compaction failed; continuing from the original session history." },
		// Only an info status line leaves the reply: a context engine line raised to a warning stays visible.
		{ level: "warning", text: "[context engine] compaction failed: summary stream aborted" },
	];
	const turn = await runTurn({
		optIn: false,
		script: ({ emit }) => {
			for (const notice of failures) emit({ type: "notice", surface: "transcript", ...notice });
			emit({ type: "notice", surface: "transcript", level: "info", text: "Clio compacted 36.2K → 28.6K tokens" });
		},
	});
	deepStrictEqual(
		turn.updates
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => (update.content as { text: string }).text),
		failures.map((notice) => `${notice.text}\n`),
	);
	strictEqual(turn.updates.filter((update) => update.sessionUpdate === "session_info_update").length, 1);
});

it("projects transcript notices for plain ACP clients while keeping footer state and context status off the reply", async () => {
	const status = [
		"[context engine] working set: nothing evictable, all 1 turn are inside the protected window; llm_summary runs instead",
		"compaction would not reduce context; checkpoint discarded (usage recorded)",
		"Clio compacted 36.2K → 28.6K tokens: 42 earlier messages now read as one summary",
	];
	const turn = await runTurn({
		optIn: false,
		script: ({ emit }) => {
			emit({ type: "notice", surface: "footer", level: "info", text: "cold cache" });
			emit({ type: "notice", surface: "transcript", level: "info", text: "project instructions: all 42 lines loaded" });
			for (const text of status) emit({ type: "notice", surface: "transcript", level: "info", text });
			emit({ type: "text_delta", delta: "Done." });
		},
	});
	const texts = turn.updates
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map((update) => (update.content as { text: string }).text);
	deepStrictEqual(texts, ["project instructions: all 42 lines loaded\n", "Done."]);
	// bt-47: context engine status crosses as session metadata, the startup notices' channel.
	const notices = turn.updates
		.filter((update) => update.sessionUpdate === "session_info_update")
		.map((update) => (update._meta as Record<string, unknown>)["clio-coder/notice"]);
	deepStrictEqual(
		notices,
		status.map((text) => ({ level: "info", text })),
	);
});
