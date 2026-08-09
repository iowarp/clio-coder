import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { SessionEntry, SessionMeta } from "../../src/domains/session/index.js";
import type { ChatLoop } from "../../src/interactive/chat-loop.js";
import { createSessionTranscript } from "../../src/interactive/session-transcript.js";

const messageEntry = (turnId: string, parentTurnId: string | null, text: string): SessionEntry => ({
	kind: "message",
	turnId,
	parentTurnId,
	timestamp: "2026-08-09T00:00:00.000Z",
	role: "user",
	payload: { text },
});

const sessionMeta = (id: string, messageCount: number): SessionMeta => ({ id, messageCount }) as SessionMeta;

describe("contracts/interactive session transcript", () => {
	it("projects submitted turns until session metadata catches up and resets on a session switch", () => {
		let current: SessionMeta | null = null;
		const transcript = createSessionTranscript({
			session: {
				current: () => current,
				create: () => {
					throw new Error("not expected");
				},
			},
			chat: { resetForSession: () => {} } as Pick<ChatLoop, "resetForSession">,
			refreshStatus: () => {},
		});

		strictEqual(transcript.liveSessionTurns(), null);
		transcript.recordSubmittedTurn();
		transcript.recordSubmittedTurn();
		strictEqual(transcript.liveSessionTurns(), 2);

		current = sessionMeta("session-one", 0);
		strictEqual(transcript.liveSessionTurns(), 2);
		current = sessionMeta("session-one", 1);
		strictEqual(transcript.liveSessionTurns(), 2);
		transcript.recordSubmittedTurn();
		strictEqual(transcript.liveSessionTurns(), 3);

		current = sessionMeta("session-two", 5);
		strictEqual(transcript.liveSessionTurns(), 5);
	});

	it("creates a session for a local entry with the active routing facts", () => {
		const creates: Array<{ cwd?: string; target?: string; model?: string }> = [];
		let current: SessionMeta | null = null;
		const transcript = createSessionTranscript({
			session: {
				current: () => current,
				create: (input) => {
					creates.push(input ?? {});
					current = sessionMeta("created", 0);
					return current;
				},
			},
			getSettings: () =>
				({ orchestrator: { target: "local", model: "coder" } }) as Readonly<Pick<ClioSettings, "orchestrator">>,
			getCwd: () => "/work/project",
			chat: { resetForSession: () => {} } as Pick<ChatLoop, "resetForSession">,
			refreshStatus: () => {},
		});

		transcript.ensureSessionForLocalEntry();
		transcript.ensureSessionForLocalEntry();
		deepStrictEqual(creates, [{ cwd: "/work/project", target: "local", model: "coder" }]);
	});

	it("omits absent routing fields when creating a local-entry session", () => {
		let created: { cwd?: string; target?: string; model?: string } | undefined;
		const transcript = createSessionTranscript({
			session: {
				current: () => null,
				create: (input) => {
					created = input;
					return sessionMeta("created", 0);
				},
			},
			getSettings: () => ({ orchestrator: {} }) as Readonly<Pick<ClioSettings, "orchestrator">>,
			getCwd: () => "/work/project",
			chat: { resetForSession: () => {} } as Pick<ChatLoop, "resetForSession">,
			refreshStatus: () => {},
		});

		transcript.ensureSessionForLocalEntry();
		deepStrictEqual(created, { cwd: "/work/project" });
	});

	it("uses the injected structured reader without touching the filesystem", () => {
		const entries = [messageEntry("turn-one", null, "hello")];
		const requested: string[] = [];
		const transcript = createSessionTranscript({
			chat: { resetForSession: () => {} } as Pick<ChatLoop, "resetForSession">,
			refreshStatus: () => {},
			readStructuredEntries: (sessionId) => {
				requested.push(sessionId);
				return entries;
			},
		});

		strictEqual(transcript.readStructuredEntries("session-one"), entries);
		deepStrictEqual(requested, ["session-one"]);
	});

	it("rebuilds chat context from current entries before refreshing status", () => {
		const entries = [messageEntry("turn-one", null, "hello")];
		const calls: string[] = [];
		let resetLeafTurnId: string | null | undefined;
		let resetMessageCount: number | undefined;
		const transcript = createSessionTranscript({
			readSessionEntries: () => entries,
			chat: {
				resetForSession: (leafTurnId, messages) => {
					calls.push("reset");
					resetLeafTurnId = leafTurnId;
					resetMessageCount = messages?.length ?? 0;
				},
			},
			refreshStatus: () => calls.push("refresh"),
		});

		transcript.refreshChatContextFromSession("turn-one");
		deepStrictEqual(calls, ["reset", "refresh"]);
		strictEqual(resetLeafTurnId, "turn-one");
		strictEqual(resetMessageCount, 1);
	});

	it("does nothing when no current-entry reader is wired", () => {
		let resets = 0;
		let refreshes = 0;
		const transcript = createSessionTranscript({
			chat: { resetForSession: () => resets++ },
			refreshStatus: () => refreshes++,
		});

		transcript.refreshChatContextFromSession(null);
		strictEqual(resets, 0);
		strictEqual(refreshes, 0);
	});
});
