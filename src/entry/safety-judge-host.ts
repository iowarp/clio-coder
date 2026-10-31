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
import type { SafetyContract } from "../domains/safety/contract.js";
import {
	createSafetyJudge,
	resolveSafetyJudgeConfig,
	type SafetyJudgeCompletion,
	type SafetyJudgeSeat,
} from "../domains/safety/safety-judge.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { operatorTextOfUserPayload } from "../domains/session/history.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { OneShotPort } from "../domains/system-one/index.js";

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

export function createSafetyJudgeHost(deps: {
	settings: () => Readonly<ClioSettings>;
	complete: SafetyJudgeCompletion;
	session: () => SessionContract | undefined;
	safety: Pick<SafetyContract, "audit"> | undefined;
}): SafetyJudgeSeat {
	return createSafetyJudge({
		config: () => resolveSafetyJudgeConfig(deps.settings()),
		complete: deps.complete,
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
		record: (input) => deps.safety?.audit.recordSafetyJudge?.(input),
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
