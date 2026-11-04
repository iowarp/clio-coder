/**
 * What the composition root gives the safety judge: the operator's own words
 * from the session ledger, a one-shot completion on the judge's route, the
 * journal hook and the transcript note. The judge itself lives in the safety
 * domain (`src/domains/safety/safety-judge.ts`) and never sees the session,
 * the providers or the ledger directly.
 */

import type { ClioSettings } from "../core/config.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { modelEndpointKey, registerForegroundStream } from "../domains/providers/endpoint-capacity.js";
import type { OneShotPort } from "../domains/providers/one-shot.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import {
	createSafetyJudge,
	resolveSafetyJudgeConfig,
	type SafetyJudgeCompletion,
	type SafetyJudgeScreen,
	type SafetyJudgeSeat,
} from "../domains/safety/safety-judge.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { operatorTextOfUserPayload } from "../domains/session/history.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { EngineDestination, SystemOne } from "../domains/system-one/index.js";
import type { JudgeScreenResult } from "../domains/system-one/points/index.js";
import { JUDGE_SCREEN_POINT, judgeScreenResults } from "../domains/system-one/points/index.js";

/** Ledger entry type of a judge block or escalation; recorded, never shown or sent to a model. */
export const SAFETY_JUDGE_NOTE_CUSTOM_TYPE = "clio-coder.safety-judge";

/**
 * The operator's own messages on the session's active path, oldest first.
 * Only user turns count, and of those only what the operator typed: a
 * continuation nudge Clio synthesized is skipped, and injected reminders and
 * expansions are stripped by `operatorTextOfUserPayload`. Assistant messages,
 * thinking and tool results never reach the judge.
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
	let path = filterEntriesToActivePath(entries, leafTurnId);
	if (
		currentTurnId !== undefined &&
		!path.some((entry) => entry.turnId === currentTurnId) &&
		entries.some((entry) => entry.turnId === currentTurnId)
	) {
		path = filterEntriesToActivePath(entries, currentTurnId);
	}
	const texts: string[] = [];
	for (const entry of path) {
		if (entry.kind !== "message" || entry.role !== "user") continue;
		if ((entry.payload as { synthetic?: unknown } | null)?.synthetic === true) continue;
		const text = operatorTextOfUserPayload(entry.payload);
		if (text !== null && text.trim().length > 0) texts.push(text);
	}
	return texts;
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
				const verdict = await systemOne.ask(JUDGE_SCREEN_POINT, result, {
					signal: request.signal,
					avoid: (destination) => onJudgeDestination(deps.providers, judge, destination),
					...(flow !== null ? { flow } : {}),
					...(request.toolCallId !== undefined ? { ref: request.toolCallId } : {}),
				});
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
}): SafetyJudgeSeat {
	return createSafetyJudge({
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
				leaf = session.tree(meta.id).leafId ?? undefined;
			} catch {
				// An unreadable tree snapshot must not erase every operator message: the
				// newest ledger message stands in as the leaf, and the call's own turn
				// still pins the path below.
			}
			return operatorMessagesForJudge(session.readEntries(), leaf, turnId);
		},
		record: (input) => deps.safety?.decisions.recordSafetyJudge?.(input),
		note: (note) => {
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
}
