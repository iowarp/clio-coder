import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type ContextRecalledPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionEntryInput } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";

let clock = 0;
function stamp(): string {
	clock += 1;
	return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

function user(turnId: string, parentTurnId: string | null): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: stamp(), role: "user", payload: { text: turnId } };
}

function toolResult(
	turnId: string,
	parentTurnId: string,
	text: string,
	details?: Record<string, unknown>,
): MessageEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		role: "tool_result",
		payload: {
			toolCallId: `call-${turnId}`,
			toolName: "read",
			result: {
				content: [{ type: "text", text }],
				details: { resultSize: { bytes: text.length, truncated: false }, ...(details ?? {}) },
			},
			isError: false,
		},
	};
}

function eviction(turnId: string, parentTurnId: string, refs: string[]): SessionEntry {
	return {
		kind: "contextEviction",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		policyId: "structural-v1",
		trigger: "pressure",
		evicted: refs.map((entry) => ({
			ref: { entry },
			reason: "superseded_read" as const,
			tokensFreed: 700,
			marker: `[evicted ref=${entry}]`,
			by: "t9",
		})),
		tokensBefore: 3_000,
		tokensAfter: 2_300,
		pressureBefore: 0.85,
		snapshotIdBefore: null,
	};
}

/** Multi-line and non-ASCII, so a lossy transcript path is visible in the output. */
const BODY = "line one\n\tline two  \nüñîçødé — 日本語\nend";

function fixture(): SessionEntry[] {
	return [
		user("u1", null),
		toolResult("t1", "u1", BODY),
		toolResult("t2", "t1", "still in context"),
		user("u2", "t2"),
		eviction("e1", "u2", ["t1"]),
	];
}

function createHarness(entries: SessionEntry[] = fixture()) {
	const notices: Array<{ level: string; text: string }> = [];
	const stdout: string[] = [];
	const submitted: string[] = [];
	const recalled: ContextRecalledPayload[] = [];
	const appended: SessionEntry[] = [];
	const bus = createSafeEventBus();
	bus.on(BusChannels.ContextRecalled, (payload) => {
		recalled.push(payload);
	});
	const deps: InteractiveSlashRuntimeDeps = {
		io: {
			stdout: (text) => stdout.push(text),
			stderr: (text) => stdout.push(`stderr:${text}`),
		},
		bus,
		dispatch: {} as DispatchContract,
		providers: {} as ProvidersContract,
		chat: {
			getSessionId: () => "session-recall",
			isStreaming: () => false,
			submit: async (text) => {
				submitted.push(text);
			},
		},
		chatPanel: {
			// The notice sink renders through appendReplayBlock; render wide enough
			// that no assertion here is really testing the wrap point.
			appendReplayBlock: (renderBlock) => {
				notices.push({ level: "block", text: renderBlock(400, transcriptDetail("verbose")).join("\n") });
			},
			appendUser: (text) => submitted.push(`user:${text}`),
			clearFoldOverrides: () => undefined,
		},
		session: {
			current: () => ({ id: "session-recall" }) as never,
			tree: () => ({ leafId: "e1" }) as never,
			appendEntry: (input: SessionEntryInput) => {
				const entry = { ...input, turnId: input.turnId ?? `gen-${entries.length}`, timestamp: stamp() } as SessionEntry;
				entries.push(entry);
				appended.push(entry);
				return entry;
			},
		},
		stateDir: "/tmp/clio-context-recall-test",
		shutdown: () => undefined,
		requestRender: () => undefined,
		refreshFooter: () => undefined,
		dismissContextBootstrapNotices: () => undefined,
		recordSubmittedTurn: () => submitted.push("record-turn"),
		readStructuredEntries: () => entries,
		expandSubmit: async (text) => ({ text, images: [], workingContextPaths: [], pendingSkillRequests: [] }),
		openAskUser: async () => ({ answers: [], cancelled: true }),
		openSkillsHub: () => undefined,
		openCost: () => undefined,
		openContextView: () => undefined,
		openTasks: () => undefined,
		openDecisions: () => undefined,
		openMemory: () => undefined,
		openView: () => undefined,
		openModel: () => undefined,
		openSettings: () => undefined,
		openResume: () => undefined,
		startNewSession: () => undefined,
		openTree: () => undefined,
		openMessagePicker: () => undefined,
		openHelp: () => undefined,
		openAgents: () => undefined,
		openPrompts: () => undefined,
		openExtensions: () => undefined,
		openContextReset: () => undefined,
		setEditorText: () => undefined,
	};
	const ESC = String.fromCharCode(27);
	const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
	return {
		runtime: createInteractiveSlashRuntime(deps),
		entries,
		appended,
		recalled,
		submitted,
		transcript: () => [...notices.map((notice) => notice.text), ...stdout].map(strip).join("\n"),
	};
}

describe("contracts//context recall", () => {
	it("parses one required ref and refuses a bare or over-long invocation", () => {
		deepStrictEqual(parseSlashCommand("/context recall t1"), { kind: "context-recall", ref: "t1" });
		const bare = parseSlashCommand("/context recall");
		strictEqual(bare.kind, "usage-error");
		ok(bare.kind === "usage-error" && bare.reason.includes("ref"), bare.kind === "usage-error" ? bare.reason : "");
		const extra = parseSlashCommand("/context recall t1 t2");
		strictEqual(extra.kind, "usage-error");
		// A bare `/context` still opens the overlay: adding a subcommand must not
		// change what the no-argument spelling does.
		deepStrictEqual(parseSlashCommand("/context"), { kind: "context-view" });
	});

	it("prints the body to the transcript, records the recall as operator, and publishes the event", () => {
		const h = createHarness();

		h.runtime.dispatchCommand("/context recall t1");

		const transcript = h.transcript();
		ok(transcript.includes("[/context recall] t1"), transcript);
		ok(transcript.includes("evicted: superseded_read by t9"), transcript);
		ok(transcript.includes("tokens"), transcript);
		// Byte-exact body, still on its own lines.
		ok(transcript.includes("üñîçødé — 日本語"), transcript);
		ok(transcript.includes("\tline two"), transcript);

		strictEqual(h.appended.length, 1);
		const record = h.appended[0];
		strictEqual(record?.kind, "contextRecall");
		if (record?.kind === "contextRecall") {
			strictEqual(record.trigger, "operator");
			strictEqual(record.ref.entry, "t1");
			strictEqual(record.toolCallId, undefined, "an operator recall has no tool call to attribute");
			strictEqual(record.parentTurnId, "u2", "the record anchors onto the newest message on the active path");
			ok(record.tokensReadmitted > 0);
		}

		deepStrictEqual(
			h.recalled.map((payload) => ({ ref: payload.ref, trigger: payload.trigger })),
			[{ ref: "t1", trigger: "operator" }],
		);

		// An operator recall answers the person, so nothing reaches the model.
		deepStrictEqual(h.submitted, []);
	});

	it("names the offload pointer instead of promising an inlined file", () => {
		const entries = fixture();
		entries[1] = toolResult("t1", "u1", BODY, {
			observation: { offloadPath: "/tmp/clio/offload/t1.txt" },
		});
		const h = createHarness(entries);

		h.runtime.dispatchCommand("/context recall t1");

		ok(h.transcript().includes("offload: /tmp/clio/offload/t1.txt"), h.transcript());
	});

	it("reports recall failures with the shared message and records nothing", () => {
		const h = createHarness();

		h.runtime.dispatchCommand("/context recall t2");
		ok(h.transcript().includes("is not evicted; its content is already in context"), h.transcript());

		h.runtime.dispatchCommand("/context recall zzz");
		const transcript = h.transcript();
		ok(transcript.includes("is not on the active path"), transcript);
		ok(transcript.includes("Recallable refs on the active path: t1 (read)."), transcript);

		deepStrictEqual(h.appended, []);
		deepStrictEqual(h.recalled, []);
	});
});
