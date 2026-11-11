import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readBuildProvenance, runningBuildId } from "../core/build-info.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import type { Quantity } from "../core/telemetry/dto.js";
import type { PermissionRequestedPayload } from "../core/telemetry/live-events.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import type { ChatLoopEvent } from "../session-control/chat-loop.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";

/** How the session ended: `/quit`, ctrl+c or a terminating signal, or anything else that ended the process. */
export type SessionFileOutcome = "quit" | "interrupted" | "crashed";

/** One usage figure as the telemetry read model reports it: its words and its fact, never re-added here. */
export interface SessionFileQuantity {
	display: string;
	fact: Quantity["fact"];
}

/** The `--session-file` exit record. Version 1; a consumer should reject a version it does not know. */
export interface SessionFileRecord {
	version: 1;
	/** Null when the session never reached a model turn, so no session was created. */
	sessionId: string | null;
	sessionName: string | null;
	outcome: SessionFileOutcome;
	exitCode: number | null;
	usage: { tokens: SessionFileQuantity; cost: SessionFileQuantity } | null;
	/** The last model the session used, or null when it used none. */
	model: { target: string; model: string } | null;
	models: ReadonlyArray<{ target: string; model: string }>;
	turns: number;
	cwd: string;
	endedAt: string;
	state: "ended";
}

/** Where the session's lane stands: in a turn, between turns, parked on the operator, or over. */
export type SessionLaneState = "working" | "idle" | "awaiting-approval" | "awaiting-answer" | "ended";

/** How the last finished turn ended. */
export interface SessionFileLastTurn {
	endedAt: string;
	stopReason: string | null;
	toolCalls: number;
	failedToolCalls: number;
}

/** The live `--session-file` record, rewritten at every turn boundary and wait transition until the exit record replaces it. */
export interface SessionFileLiveRecord {
	version: 1;
	sessionId: string | null;
	sessionName: string | null;
	state: Exclude<SessionLaneState, "ended">;
	/** ISO time of the last state transition. */
	since: string;
	turns: number;
	lastTurn: SessionFileLastTurn | null;
	/** Awaiting states only: the tool and the first 200 characters of its command or question, redacted. */
	waitingOn?: { tool: string; text: string };
	build: { id: string | null; commit: string | null };
	cwd: string;
}

const SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([129, 130, 143]);

/** The outcome a process exit code stands for when no clean exit recorded one first. */
export function sessionFileOutcomeForExitCode(code: number): SessionFileOutcome {
	if (code === 0) return "quit";
	return SIGNAL_EXIT_CODES.has(code) ? "interrupted" : "crashed";
}

function sessionFileRecord(input: {
	snapshot: ExitSummarySnapshot | null;
	outcome: SessionFileOutcome;
	exitCode: number | null;
	cwd: string;
	endedAt: Date;
}): SessionFileRecord {
	const { snapshot } = input;
	const spend = snapshot?.spend;
	const models = snapshot?.models ?? [];
	return {
		version: 1,
		sessionId: snapshot?.sessionId ?? null,
		sessionName: snapshot?.sessionName ?? null,
		outcome: input.outcome,
		exitCode: input.exitCode,
		usage:
			spend?.kind === "ready"
				? {
						tokens: { display: spend.totals.tokens.display, fact: spend.totals.tokens.fact },
						cost: { display: spend.totals.usd.display, fact: spend.totals.usd.fact },
					}
				: null,
		model: models.at(-1) ?? null,
		models: [...models],
		turns: snapshot?.turns ?? 0,
		cwd: input.cwd,
		endedAt: input.endedAt.toISOString(),
		state: "ended",
	};
}

/**
 * Write the record through a temp file renamed into place, so a polling reader sees a whole record or the previous one.
 * The path is the caller's; only its missing parent directories are created.
 */
function writeSessionFile(path: string, record: SessionFileRecord | SessionFileLiveRecord): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	safeResourceWrite(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

const WAITING_TEXT_LIMIT = 200;
const ASK_USER_TOOL = "ask_user";

/** The question, command or first string argument a parked call shows the operator, redacted and cut to 200 characters. */
function waitingText(args: unknown): string {
	let text = "";
	if (typeof args === "string") text = args;
	else if (args && typeof args === "object") {
		const fields = args as Record<string, unknown>;
		if (Array.isArray(fields.questions) && fields.questions.length > 0) {
			const first = fields.questions[0] as { question?: unknown } | string;
			text = typeof first === "string" ? first : typeof first?.question === "string" ? first.question : "";
		}
		for (const key of ["command", "question", "prompt", "path", "url"]) {
			if (text) break;
			const value = fields[key];
			if (typeof value === "string") text = value;
		}
		if (!text) text = Object.values(fields).find((value): value is string => typeof value === "string") ?? "";
	}
	return redactSecretString(text).slice(0, WAITING_TEXT_LIMIT);
}

export interface SessionFileRecorder {
	/** Write the exit record once; later calls do nothing. False when this call did not write it. */
	record(outcome: SessionFileOutcome, exitCode: number | null): boolean;
	/** Follow a chat event: turn start and end, and an ask_user question opening and closing. */
	observeChat(event: ChatLoopEvent): void;
	/** Follow a permission card opening for the operator. */
	observeApprovalRequested(payload: PermissionRequestedPayload): void;
	/** Follow a permission card closing. */
	observeApprovalResolved(): void;
}

type Waiting = { tool: string; text: string };

/**
 * The exit paths race (clean exit, signal drain, process exit), so the first to arrive writes and the rest are no-ops.
 * Until then each turn boundary and each wait transition rewrites the live record.
 */
export function createSessionFileRecorder(deps: {
	path: string;
	snapshot: () => ExitSummarySnapshot | null;
	cwd: string;
	now?: () => Date;
	warn?: (line: string) => void;
}): SessionFileRecorder {
	let done = false;
	let warned = false;
	let inTurn = false;
	let state: SessionFileLiveRecord["state"] = "idle";
	let since = "";
	let turns = 0;
	let lastTurn: SessionFileLastTurn | null = null;
	let waitingOn: Waiting | undefined;
	let approvalWaiting: Waiting | undefined;
	let askWaiting: Waiting | undefined;
	let stopReason: string | null = null;
	let toolCalls = 0;
	let failedToolCalls = 0;
	const pending = new Map<string, { tool: string; args: unknown }>();
	const now = (): Date => deps.now?.() ?? new Date();
	const warn = (error: unknown): void => {
		(deps.warn ?? ((line) => process.stderr.write(`${line}\n`)))(
			`Clio Coder: could not write the session record to ${deps.path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	};
	const readSnapshot = (): ExitSummarySnapshot | null => {
		try {
			return deps.snapshot();
		} catch {
			// A session that cannot be read still gets its state and outcome on record.
			return null;
		}
	};
	const writeLive = (): void => {
		const snapshot = readSnapshot();
		const provenance = readBuildProvenance();
		const record: SessionFileLiveRecord = {
			version: 1,
			sessionId: snapshot?.sessionId ?? null,
			sessionName: snapshot?.sessionName ?? null,
			state,
			since,
			turns,
			lastTurn,
			...(waitingOn ? { waitingOn } : {}),
			build: {
				id: runningBuildId,
				commit: provenance ? `${provenance.commit}${provenance.dirty ? "-dirty" : ""}` : null,
			},
			cwd: deps.cwd,
		};
		try {
			writeSessionFile(deps.path, record);
		} catch (error) {
			// One warning per session: the live record retries at every transition.
			if (!warned) warn(error);
			warned = true;
		}
	};
	/** Settle the state the waits and the turn add up to; a change rewrites the record, a turn boundary always does. */
	const settle = (boundary = false): void => {
		const next: SessionFileLiveRecord["state"] = approvalWaiting
			? "awaiting-approval"
			: askWaiting
				? "awaiting-answer"
				: inTurn
					? "working"
					: "idle";
		const nextWaiting = approvalWaiting ?? askWaiting;
		if (!boundary && next === state && since !== "" && nextWaiting === waitingOn) return;
		if (next !== state || since === "") since = now().toISOString();
		state = next;
		waitingOn = nextWaiting;
		writeLive();
	};
	return {
		record(outcome, exitCode) {
			if (done) return false;
			done = true;
			try {
				const snapshot = readSnapshot();
				writeSessionFile(deps.path, sessionFileRecord({ snapshot, outcome, exitCode, cwd: deps.cwd, endedAt: now() }));
				return true;
			} catch (error) {
				warn(error);
				return false;
			}
		},
		observeChat(event) {
			if (done) return;
			if (event.type === "agent_start") {
				if (!inTurn) {
					stopReason = null;
					toolCalls = 0;
					failedToolCalls = 0;
				}
				inTurn = true;
				settle();
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const reason = (event.message as { stopReason?: unknown }).stopReason;
				stopReason = typeof reason === "string" ? reason : null;
			} else if (event.type === "tool_execution_start") {
				toolCalls += 1;
				pending.set(event.toolCallId, { tool: event.toolName, args: event.args });
				if (event.toolName === ASK_USER_TOOL) {
					askWaiting = { tool: event.toolName, text: waitingText(event.args) };
					settle();
				}
			} else if (event.type === "tool_execution_end") {
				if (event.isError) failedToolCalls += 1;
				pending.delete(event.toolCallId);
				if (event.toolName === ASK_USER_TOOL && askWaiting) {
					askWaiting = undefined;
					settle();
				}
			} else if (event.type === "agent_end" && !event.retryPending) {
				// An attempt that recovery will retry ends no turn.
				inTurn = false;
				askWaiting = undefined;
				pending.clear();
				turns += 1;
				lastTurn = { endedAt: now().toISOString(), stopReason, toolCalls, failedToolCalls };
				settle(true);
			}
		},
		observeApprovalRequested(payload) {
			// A worker ask with the safety judge or the main agent is not waiting on the person yet.
			if (done || payload.escalation === false) return;
			let args: unknown;
			for (const call of pending.values()) if (call.tool === payload.tool) args = call.args;
			approvalWaiting = { tool: payload.tool, text: waitingText(args) };
			settle();
		},
		observeApprovalResolved() {
			if (done || !approvalWaiting) return;
			approvalWaiting = undefined;
			settle();
		},
	};
}
