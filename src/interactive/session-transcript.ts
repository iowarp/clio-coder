import type { ClioSettings } from "../core/config.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import { openSession, sessionPaths } from "../engine/session.js";
import type { ChatLoop } from "./chat-loop.js";
import { buildModelReplayAgentMessagesFromTurns } from "./model-session-replay.js";

type SessionOwner = Pick<SessionContract, "create" | "current">;
type SessionChat = Pick<ChatLoop, "resetForSession">;
type RoutingSettings = Pick<ClioSettings, "orchestrator">;

export interface SessionTranscriptDeps {
	session?: SessionOwner;
	getSessionId?: () => string | null;
	getSettings?: () => Readonly<RoutingSettings>;
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	chat: SessionChat;
	refreshStatus: () => void;
	getCwd?: () => string;
	readStructuredEntries?: (sessionId: string) => SessionEntry[];
}

export interface SessionTranscript {
	ensureSessionForLocalEntry(): void;
	readStructuredEntries(sessionId: string): SessionEntry[];
	refreshChatContextFromSession(leafTurnId: string | null): void;
	recordSubmittedTurn(): void;
	liveSessionTurns(): number | null;
	syncSessionCounter(): void;
}

function readStructuredEntriesFromDisk(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

/**
 * Owns the active session's projected turn count and transcript replay bridge.
 * The optional readers keep construction independent of a session directory;
 * disk access occurs only when a caller explicitly asks to read an id.
 */
export function createSessionTranscript(deps: SessionTranscriptDeps): SessionTranscript {
	let sessionCounter = {
		id: deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
		baseTurns: deps.session?.current()?.messageCount ?? 0,
		submittedTurns: 0,
	};

	const syncSessionCounter = (): void => {
		const meta = deps.session?.current();
		const id = meta?.id ?? deps.getSessionId?.() ?? null;
		if (id === sessionCounter.id) return;
		const baseTurns = meta?.messageCount ?? 0;
		const previousProjected = sessionCounter.baseTurns + sessionCounter.submittedTurns;
		const carryPending = sessionCounter.id === null ? Math.max(0, previousProjected - baseTurns) : 0;
		sessionCounter = { id, baseTurns, submittedTurns: carryPending };
	};

	const recordSubmittedTurn = (): void => {
		syncSessionCounter();
		sessionCounter = { ...sessionCounter, submittedTurns: sessionCounter.submittedTurns + 1 };
	};

	const liveSessionTurns = (): number | null => {
		syncSessionCounter();
		const metaTurns = deps.session?.current()?.messageCount;
		const projected = sessionCounter.baseTurns + sessionCounter.submittedTurns;
		return typeof metaTurns === "number" ? Math.max(metaTurns, projected) : projected > 0 ? projected : null;
	};

	const ensureSessionForLocalEntry = (): void => {
		if (!deps.session || deps.session.current()) return;
		const settings = deps.getSettings?.();
		const input: { cwd: string; target?: string; model?: string } = {
			cwd: deps.getCwd?.() ?? process.cwd(),
		};
		if (settings?.orchestrator.target) input.target = settings.orchestrator.target;
		if (settings?.orchestrator.model) input.model = settings.orchestrator.model;
		deps.session.create(input);
	};

	const readStructuredEntries = (sessionId: string): SessionEntry[] =>
		(deps.readStructuredEntries ?? readStructuredEntriesFromDisk)(sessionId);

	const refreshChatContextFromSession = (leafTurnId: string | null): void => {
		if (!deps.readSessionEntries) return;
		const turns = deps.readSessionEntries();
		deps.chat.resetForSession(
			leafTurnId,
			buildModelReplayAgentMessagesFromTurns(turns, {
				...(leafTurnId ? { activeLeafTurnId: leafTurnId } : {}),
			}),
		);
		deps.refreshStatus();
	};

	return {
		ensureSessionForLocalEntry,
		readStructuredEntries,
		refreshChatContextFromSession,
		recordSubmittedTurn,
		liveSessionTurns,
		syncSessionCounter,
	};
}
