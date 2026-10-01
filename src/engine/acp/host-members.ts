/**
 * The ACP host's members for the allowlisted commands that need more than a
 * reply: the worker runs `/share` picks from, the record `/oracle` briefs on,
 * and the tool calls `/council` makes on the operator's behalf.
 *
 * `/council` is a plan-scale dispatch, and supervised autonomy parks it for
 * approval. The ACP permission bridge binds an approval to a `tool_call` the
 * client has already been shown, so a dispatch the host starts is announced
 * through the same engine-shaped events the chat emits, under one call id, and
 * the registry is invoked under that id. Nothing here builds a request,
 * resolves a route, or touches the dispatch domain; the registry admits the
 * call exactly as it admits a model's.
 *
 * It also holds the interview channel: the host's `ask_user` handler is
 * installed at boot, before the transport exists, so it asks through a binding
 * the server attaches once it is serving.
 *
 * Only the composition root imports this module (a declared seam in
 * tests/boundaries/check-boundaries.ts), so the worker-stream and oracle
 * modules it reaches stay off the ACP CLI's own import graph.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import { proposeTaskBankPromotion, type TaskMemorySnapshot } from "../../domains/memory/index.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { DecisionBoardStore } from "../../domains/session/decision-board.js";
import { formatDecisionCorrectionTurn } from "../../interactive/overlays/decisions.js";
import type { CouncilDispatchOutcome } from "../../interactive/slash-commands.js";
import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { AcpBoardActions, AcpInterviewBinding, AcpInterviewChannel } from "./server.js";
import { ACP_INTERVIEW_CANCEL_METHOD, ACP_INTERVIEW_REQUEST_METHOD } from "./types.js";

export { draftsToJudge, judgeDraftsAtSite } from "../../interactive/drafts.js";
export { oracleBriefingFromEntries } from "../../interactive/oracle.js";
export { followWorkerRuns } from "../../interactive/worker-run-ledger.js";

export interface HostToolEvents {
	emit(event: Record<string, unknown>): void;
	onEvent(handler: (event: unknown) => void): () => void;
}

export function createHostToolEvents(): HostToolEvents {
	const handlers = new Set<(event: unknown) => void>();
	return {
		emit: (event) => {
			for (const handler of handlers) handler(event);
		},
		onEvent: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
}

/** One dispatch the operator asked for by command, announced, admitted and settled as a model's call is. */
export async function runHostDispatch(
	registry: Pick<ToolRegistry, "invoke">,
	events: HostToolEvents,
	args: Readonly<Record<string, unknown>>,
): Promise<CouncilDispatchOutcome> {
	const toolCallId = `host-${randomUUID()}`;
	events.emit({ type: "tool_execution_start", toolCallId, toolName: ToolNames.Dispatch, args: { ...args } });
	const verdict = await registry.invoke({ tool: ToolNames.Dispatch, args: { ...args } }, { toolCallId });
	const outcome: CouncilDispatchOutcome =
		verdict.kind === "blocked"
			? { status: "blocked", reason: verdict.reason }
			: verdict.kind === "not_visible"
				? { status: "error", message: verdict.reason }
				: verdict.result.kind === "error"
					? { status: "error", message: verdict.result.message }
					: { status: "ok" };
	const text =
		verdict.kind === "ok" && verdict.result.kind === "ok"
			? verdict.result.output
			: outcome.status === "blocked"
				? outcome.reason
				: outcome.status === "error"
					? outcome.message
					: "";
	events.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: ToolNames.Dispatch,
		result: { content: [{ type: "text", text }] },
		isError: outcome.status !== "ok",
	});
	return outcome;
}

/**
 * The board panel's writes with the terminal overlays' semantics. Superseding
 * a decision keeps it in the record, marked superseded; a correction also
 * yields the exact turn the terminal submits, for the client to send as a
 * visible prompt. A decision already superseded is left alone, so a retried
 * press writes nothing. A proposal goes through the same memory-domain
 * function the /memory overlay uses, whose derived ids make a retry find the
 * existing candidate.
 */
export function bindBoardActions(deps: {
	decisionBoard: Pick<DecisionBoardStore, "snapshot" | "supersede">;
	taskBank: () => TaskMemorySnapshot;
	currentSession: () => { id: string; cwd: string } | null | undefined;
	dataDir: string;
}): AcpBoardActions {
	return {
		supersedeDecision: (interviewId, key, correction) => {
			const decision = deps.decisionBoard
				.snapshot()
				.find((entry) => entry.interviewId === interviewId)
				?.decisions.find((row) => row.key === key);
			if (decision === undefined) throw new Error(`decision ${key} is not on the board`);
			if (decision.status !== "active") return { status: "already_superseded" };
			deps.decisionBoard.supersede(interviewId, key, correction);
			return {
				status: "superseded",
				...(correction === undefined
					? {}
					: {
							correctionTurn: formatDecisionCorrectionTurn(
								{ interviewId, key, label: decision.label ?? decision.key, value: decision.value },
								correction,
							),
						}),
			};
		},
		proposeMemory: async (entryId, scope) => {
			const session = deps.currentSession();
			if (!session) throw new Error("memory promotion requires an active session");
			const bank = deps.taskBank();
			const entry = [...bank.knowledge, ...bank.procedural].find((row) => row.id === entryId);
			if (entry === undefined) throw new Error(`task-bank entry ${entryId} is not in this session`);
			const result = await proposeTaskBankPromotion(deps.dataDir, { id: session.id, cwd: session.cwd }, entry, scope);
			return { created: result.created, recordId: result.record.id };
		},
	};
}

/**
 * `ask_user` and the harness cards (the merge card) for an ACP client that
 * advertised `clio-coder/interviews`. The host's handler is installed once at
 * boot, before the transport exists, so it asks through a binding the server
 * attaches when it starts serving. With no binding, or a client that did not
 * opt in, every round reads as the operator's cancel, which is what a surface
 * with nobody to ask has always answered.
 */
// The client's own request contract bounds a round; a longer string is cut
// rather than refused, because a refused round parks the model on a cancel.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 16;
const MAX_QUESTION_CHARS = 8192;
const MAX_HEADER_CHARS = 128;
const MAX_LABEL_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 2048;
const MAX_ANSWER_CHARS = 16 * 1024;

interface WireQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multi_select?: boolean;
}

function cancelled(): AskUserResult {
	return { answers: [], cancelled: true };
}

function cut(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/** The client's request shape. `defaultOption` is harness-only focus state the wire has no field for. */
function wireQuestion(question: AskUserQuestion): WireQuestion | null {
	const text = cut(sanitizeCallTargetText(question.question), MAX_QUESTION_CHARS);
	if (text.length === 0) return null;
	const options = (question.options ?? [])
		.map((option) => ({
			label: cut(sanitizeCallTargetText(option.label), MAX_LABEL_CHARS),
			description: option.description,
		}))
		.filter((option) => option.label.length > 0)
		.slice(0, MAX_OPTIONS)
		.map((option) => ({
			label: option.label,
			...(option.description !== undefined && option.description.length > 0
				? { description: cut(sanitizeCallTargetText(option.description), MAX_DESCRIPTION_CHARS) }
				: {}),
		}));
	const header = question.header !== undefined ? cut(sanitizeCallTargetText(question.header), MAX_HEADER_CHARS) : "";
	return {
		question: text,
		...(header.length > 0 ? { header } : {}),
		...(options.length > 0 ? { options } : {}),
		...(question.multi_select === true ? { multi_select: true } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The client's reply, or null when it does not carry the AskUserResult shape. */
function readResult(value: unknown, wire: WireQuestion[], original: AskUserQuestion[]): AskUserResult | null {
	if (!isRecord(value)) return null;
	if (value.cancelled === true) return cancelled();
	if (value.cancelled !== undefined && value.cancelled !== false) return null;
	if (!Array.isArray(value.answers) || value.answers.length !== wire.length) return null;
	const answers: AskUserResult["answers"] = [];
	for (const [index, raw] of value.answers.entries()) {
		const question = wire[index];
		const source = original[index];
		if (
			question === undefined ||
			source === undefined ||
			!isRecord(raw) ||
			raw.question !== question.question ||
			typeof raw.answer !== "string" ||
			raw.answer.trim().length === 0 ||
			raw.answer.length > MAX_ANSWER_CHARS ||
			(raw.value !== undefined && (typeof raw.value !== "string" || raw.value.length > MAX_ANSWER_CHARS))
		)
			return null;
		const offered = question.options ?? [];
		if (new Set(offered.map((option) => option.label)).size !== offered.length) return null;
		const canonical = (source.options ?? [])
			.filter((option) => sanitizeCallTargetText(option.label).length > 0)
			.slice(0, MAX_OPTIONS);
		let selected: string[] | undefined;
		if (raw.options !== undefined) {
			if (
				!Array.isArray(raw.options) ||
				raw.options.some((label) => typeof label !== "string") ||
				new Set(raw.options).size !== raw.options.length ||
				(question.multi_select !== true && raw.options.length > 1)
			)
				return null;
			const text = typeof raw.value === "string" ? raw.value.trim() : "";
			if (raw.options.length > 0 && raw.answer !== [...raw.options, ...(text ? [text] : [])].join("; ")) return null;
			selected = [];
			for (const label of raw.options) {
				const position = offered.findIndex((option) => option.label === label);
				const option = canonical[position];
				if (position < 0 || option === undefined) return null;
				selected.push(option.label);
			}
		}
		answers.push({
			question: source.question,
			answer: raw.answer,
			...(selected !== undefined && selected.length > 0 ? { options: selected } : {}),
			...(typeof raw.value === "string" ? { value: raw.value } : {}),
		});
	}
	return { answers };
}

export function createAcpInterviewChannel(): AcpInterviewChannel {
	let binding: AcpInterviewBinding | null = null;
	const pending = new Set<() => void>();
	const cancel = (): void => {
		for (const abort of pending) abort();
	};
	const ask: AskUserHandler = async (questions, options) => {
		const bound = binding;
		if (bound === null || !bound.enabled()) return cancelled();
		const sessionId = bound.sessionId();
		const shown = questions.slice(0, MAX_QUESTIONS).map(wireQuestion);
		const wire = shown.filter((question): question is WireQuestion => question !== null);
		if (sessionId === null || wire.length === 0 || wire.length !== shown.length) return cancelled();
		const signal = options?.signal;
		if (signal?.aborted === true) return cancelled();
		const interviewId = `interview-${randomUUID()}`;
		let onAbort: (() => void) | undefined;
		let wasCancelled = false;
		const aborted = new Promise<"aborted">((resolve) => {
			onAbort = () => {
				wasCancelled = true;
				resolve("aborted");
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			pending.add(onAbort);
		});
		try {
			const reply = Promise.resolve()
				.then(() =>
					bound.transport.request<unknown>(
						ACP_INTERVIEW_REQUEST_METHOD,
						{ sessionId, interviewId, questions: wire },
						bound.timeoutMs ?? DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
					),
				)
				.then(
					(value) => ({ kind: "reply" as const, value }),
					(err: unknown) => ({ kind: "failed" as const, err }),
				);
			const outcome = await Promise.race([reply, aborted]);
			if (outcome === "aborted" || wasCancelled) {
				// The parked request answers late into a promise nothing awaits; the
				// notification tells a client that supports it to drop the round.
				bound.transport.notify(ACP_INTERVIEW_CANCEL_METHOD, { sessionId, interviewId });
				return cancelled();
			}
			if (outcome.kind === "failed") {
				bound.transport.notify(ACP_INTERVIEW_CANCEL_METHOD, { sessionId, interviewId });
				// A client that refuses the round (no active turn, malformed) has not
				// answered it, so the caller sees the same cancel an Esc gives.
				bound.diagnostics?.(
					`interview request failed: ${outcome.err instanceof Error ? outcome.err.message : String(outcome.err)}`,
				);
				return cancelled();
			}
			const result = readResult(outcome.value, wire, questions.slice(0, MAX_QUESTIONS));
			if (result === null) {
				bound.diagnostics?.("interview reply did not match the answer contract");
				return cancelled();
			}
			return result;
		} finally {
			if (onAbort !== undefined) {
				signal?.removeEventListener("abort", onAbort);
				pending.delete(onAbort);
			}
		}
	};
	return {
		ask,
		cancel,
		attach(next) {
			cancel();
			binding = next;
			return () => {
				if (binding === next) {
					cancel();
					binding = null;
				}
			};
		},
	};
}
