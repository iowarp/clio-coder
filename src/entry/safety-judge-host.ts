/**
 * What the composition root gives the safety judge: the operator's own words
 * from the session ledger, a one-shot completion on the judge's route, the
 * journal hook and the transcript note. The judge itself lives in the safety
 * domain (`src/domains/safety/safety-judge.ts`) and never sees the session,
 * the providers or the ledger directly.
 */

import type { ClioSettings } from "../core/config.js";
import { ToolNames } from "../core/tool-names.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { modelEndpointKey, registerForegroundStream } from "../domains/providers/endpoint-capacity.js";
import type { OneShotPort } from "../domains/providers/one-shot.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import {
	createSafetyJudge,
	resolveSafetyJudgeConfig,
	type SafetyJudgeCompletion,
	type SafetyJudgeNote,
	type SafetyJudgeScreen,
	type SafetyJudgeSeat,
} from "../domains/safety/safety-judge.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { isOperatorTypedUserPayload, operatorTextOfUserPayload } from "../domains/session/history.js";
import { activePath, extendsSnapshot, findLastEntry } from "../domains/session/tree/active-path.js";
import type { EngineDestination, SystemOne } from "../domains/system-one/index.js";
import type { JudgeScreenResult } from "../domains/system-one/points/index.js";
import { JUDGE_SCREEN_POINT, judgeScreenResults } from "../domains/system-one/points/index.js";
import { effectiveToolCall, expandChainMessages } from "../tools/surface.js";
import { capturedJudgeCallId, withJudgeCallCapture, withSidePurpose } from "./side-request-admission.js";

/** Ledger entry type of a judge block or escalation; recorded, never shown or sent to a model. */
export const SAFETY_JUDGE_NOTE_CUSTOM_TYPE = "clio-coder.safety-judge";

/**
 * The operator's own words on the session's active path, oldest first, so the
 * last one is truly the newest thing the operator said. Two kinds count, in
 * ledger order. What the operator typed in a user turn
 * (`isOperatorTypedUserPayload`): a continuation nudge Clio synthesized, a job's
 * prompt, follow-up and observation, and a yolo continuation are skipped, and
 * injected reminders and expansions are stripped by `operatorTextOfUserPayload`.
 * And what the operator answered on an ask_user round, a gateway call or chain
 * step included (`operatorAnswersOfToolResult`). Assistant messages, thinking and
 * every other tool result never reach the judge.
 *
 * `currentTurnId` is the turn the judged call serves, from the chat loop's
 * live turn state. The path runs through it whenever the session leaf's path
 * does not hold it, so a leaf that has not caught up with the turn in flight
 * never cuts the request that turn carries, while a branch the operator left
 * with /tree stays out because the path still walks parent links.
 */
export function operatorMessagesForJudge(
	entries: ReadonlyArray<SessionEntry>,
	leafTurnId?: string,
	currentTurnId?: string,
): string[] {
	let path = activePath(entries, leafTurnId);
	const holds = (rows: ReadonlyArray<SessionEntry>) =>
		findLastEntry(rows, (entry) => entry.turnId === currentTurnId) !== undefined;
	if (currentTurnId !== undefined && !holds(path) && holds(entries)) path = activePath(entries, currentTurnId);
	if (!Object.isFrozen(entries)) return operatorTextsOf(path);
	const prior = judgeFold;
	let texts: string[];
	if (prior?.path === path) texts = prior.texts;
	else if (prior !== null && extendsSnapshot(prior.path, path))
		texts = prior.texts.concat(operatorTextsOf(path.slice(prior.path.length)));
	else texts = operatorTextsOf(path);
	judgeFold = { path, texts };
	return [...texts];
}

/**
 * The last fold, so a judged call on a path that only grew reads just the
 * appended entries. Each entry contributes on its own, so the fold of a path
 * is the fold of its prefix followed by the fold of the rest.
 */
let judgeFold: { path: ReadonlyArray<SessionEntry>; texts: string[] } | null = null;

function operatorTextsOf(path: ReadonlyArray<SessionEntry>): string[] {
	const texts: string[] = [];
	for (const entry of expandChainMessages(path)) {
		if (entry.kind !== "message") continue;
		if (entry.role === "tool_result") {
			texts.push(...operatorAnswersOfToolResult(entry.payload));
			continue;
		}
		if (entry.role !== "user" || !isOperatorTypedUserPayload(entry.payload)) continue;
		const text = operatorTextOfUserPayload(entry.payload);
		if (text !== null && text.trim().length > 0) texts.push(text);
	}
	return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the operator answered in one recorded ask_user result. A round Clio
 * answered for an absent operator (#421), a cancelled round and an answer Clio
 * picked (`auto`) are no operator's word, as the registry's own reading holds.
 */
function operatorAnswersOfToolResult(payload: unknown): string[] {
	if (!isRecord(payload) || typeof payload.toolName !== "string" || payload.isError === true) return [];
	const details = isRecord(payload.result) && isRecord(payload.result.details) ? payload.result.details : undefined;
	if (details === undefined || effectiveToolCall(payload.toolName, undefined, details).toolName !== ToolNames.AskUser)
		return [];
	if (details.unattended !== undefined || details.cancelled === true || !Array.isArray(details.answers)) return [];
	return details.answers.flatMap((raw: unknown) => {
		if (!isRecord(raw) || raw.auto === true) return [];
		const { question, answer } = raw;
		if (typeof question !== "string" || typeof answer !== "string" || answer.trim().length === 0) return [];
		return [`Asked "${question}", the operator answered: ${answer}`];
	});
}

/**
 * The judge's completion on its route. The operator is waiting on the call,
 * so the round holds a foreground slot on the route's endpoint (keyed per
 * model behind a gateway), which also preempts optional background memory on
 * a one-slot server instead of queueing behind it. The session's restricted
 * context is judged against the judge's destination before a byte leaves.
 */
export function createSafetyJudgeCompletion(deps: {
	providers: Pick<ProvidersContract, "getTarget">;
	oneShot: () => OneShotPort;
	flowRefusal: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
}): SafetyJudgeCompletion {
	return async (request) => {
		const target = deps.providers.getTarget(request.targetId);
		if (target === null) throw new Error(`target '${request.targetId}' is not configured`);
		const wireModelId = request.model ?? target.defaultModel ?? null;
		if (wireModelId === null) throw new Error(`target '${request.targetId}' names no model to ask`);
		const refusal = deps.flowRefusal({ targetId: target.id, runtimeId: target.runtime, wireModelId });
		if (refusal !== null) throw new Error(refusal);
		const endpointKey = modelEndpointKey(target, wireModelId);
		const release = endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
		try {
			const answer = await deps.oneShot()({
				targetId: request.targetId,
				model: wireModelId,
				system: request.system,
				user: request.user,
				schema: request.schema,
				maxTokens: request.maxTokens,
				signal: request.signal,
			});
			return { text: answer.text };
		} finally {
			release();
		}
	};
}

/**
 * Whether an engine shares the judge's destination, which would make the judge queue
 * behind a reading nobody waits on. The same target always does; two targets do when
 * they resolve to one slot key.
 */
export function onJudgeDestination(
	providers: Pick<ProvidersContract, "getTarget">,
	judge: { targetId: string; model: string | null },
	destination: EngineDestination,
): boolean {
	if (destination.targetId === judge.targetId) return true;
	const judgeTarget = providers.getTarget(judge.targetId);
	const engineTarget = providers.getTarget(destination.targetId);
	if (judgeTarget === null || engineTarget === null) return false;
	const key = modelEndpointKey(judgeTarget, judge.model ?? judgeTarget.defaultModel ?? null);
	return key !== null && key === modelEndpointKey(engineTarget, destination.wireModelId);
}

/**
 * The tool result reading beside the judge: the newest third-party results since the
 * operator last spoke, one ask each, newest first, until one reads as directing an agent.
 * One at a time, so a one-slot engine is never contended by this reading and four hung
 * requests cannot trip a breaker together.
 *
 * Evidence is read off the live messages, so no tool hook passes it through a flow gate.
 * The session's restrictions go on each ask for the runner's flow check to judge, and a
 * ledger that cannot vouch for provenance sends nothing.
 *
 * A result's reading does not change, and every reviewed ask in a turn sees the same
 * results, so a finished reading is remembered by call id until the operator speaks
 * again. Ten judged asks after one web_fetch would otherwise cost forty paid requests.
 * Only a finished reading is kept: an aborted or failed one is read again next time.
 */
export function createJudgeScreen(deps: {
	systemOne: () => Pick<SystemOne, "bound" | "ask">;
	providers: Pick<ProvidersContract, "getTarget">;
	/** The live agent messages and when the operator last spoke, epoch milliseconds. */
	liveWindow: () => { messages: ReadonlyArray<unknown>; since: number } | null;
	flow: { current(): unknown; refusal(): string | null };
}): SafetyJudgeScreen {
	const remembered = new Map<string, boolean>();
	let rememberedSince: number | null = null;
	return (request) => {
		const systemOne = deps.systemOne();
		if (!systemOne.bound() || deps.flow.refusal() !== null) return null;
		const window = deps.liveWindow();
		if (window === null) return null;
		if (rememberedSince !== window.since) {
			remembered.clear();
			rememberedSince = window.since;
		}
		const results = judgeScreenResults(window.messages, window.since);
		if (results.length === 0) return null;
		const known = (result: JudgeScreenResult): boolean | undefined =>
			result.callId === undefined ? undefined : remembered.get(result.callId);
		// Fires before any request, even when a newer result has not been read yet.
		const directing = results.find((result) => known(result) === true);
		if (directing !== undefined) return Promise.resolve({ source: directing.source });
		const unread = results.filter((result) => known(result) === undefined);
		if (unread.length === 0) return null;
		const flow = deps.flow.current();
		const judge = { targetId: request.targetId, model: request.model };
		const read = async (): Promise<{ source: string } | null> => {
			for (const result of unread) {
				if (request.signal.aborted) return null;
				const verdict = await withSidePurpose("judge.screen", () =>
					systemOne.ask(JUDGE_SCREEN_POINT, result, {
						signal: request.signal,
						avoid: (destination) => onJudgeDestination(deps.providers, judge, destination),
						...(flow !== null ? { flow } : {}),
						...(request.toolCallId !== undefined ? { ref: request.toolCallId } : {}),
					}),
				);
				if (verdict === null) continue;
				if (result.callId !== undefined) remembered.set(result.callId, verdict.value.directing);
				if (verdict.value.directing) return { source: result.source };
			}
			return null;
		};
		return read();
	};
}

export function createSafetyJudgeHost(deps: {
	settings: () => Readonly<ClioSettings>;
	complete: SafetyJudgeCompletion;
	session: () => SessionContract | undefined;
	safety: Pick<SafetyContract, "decisions"> | undefined;
	screen?: SafetyJudgeScreen;
	/** Either escalation threshold was reached; contained yolo ends its run on it (ob-yolo D4). */
	onEscalation?: (note: SafetyJudgeNote) => void;
}): SafetyJudgeSeat {
	const seat = createSafetyJudge({
		config: () => resolveSafetyJudgeConfig(deps.settings()),
		complete: deps.complete,
		...(deps.screen !== undefined ? { screen: deps.screen } : {}),
		session: () => deps.session()?.current()?.id ?? null,
		operatorMessages: ({ turnId }) => {
			const session = deps.session();
			const meta = session?.current();
			if (session === undefined || !meta) return [];
			let leaf: string | undefined;
			try {
				leaf = session.leafId(meta.id) ?? undefined;
			} catch {
				// An unreadable tree snapshot must not erase every operator message: the
				// newest ledger message stands in as the leaf, and the call's own turn
				// still pins the path below.
			}
			return operatorMessagesForJudge(session.readEntries(), leaf, turnId);
		},
		record: (input) => {
			// The judge's own call, beside the parent the row's context names (memory design 4.5).
			const judgeCallId = capturedJudgeCallId();
			deps.safety?.decisions.recordSafetyJudge?.(judgeCallId === undefined ? input : { ...input, judgeCallId });
		},
		note: (note) => {
			if (note.kind === "escalation") deps.onEscalation?.(note);
			const session = deps.session();
			if (session === undefined || !session.current()) return;
			session.appendEntry({
				kind: "custom",
				customType: SAFETY_JUDGE_NOTE_CUSTOM_TYPE,
				parentTurnId: note.turnId ?? null,
				display: false,
				data: note,
			});
		},
	});
	return {
		review: (subject) => withJudgeCallCapture(() => seat.review(subject)),
		operatorApproved: () => seat.operatorApproved(),
	};
}
