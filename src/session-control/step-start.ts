import type { ModelTier } from "../core/model-tier.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { stepCheckpointApplies } from "../domains/context/fold/contract.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	isStepChainData,
	type SessionEntry,
	STEP_CHAIN_CUSTOM_TYPE,
	type StepChainData,
} from "../domains/session/entries.js";
import { filterEntriesToActivePath, findLastEntry } from "../domains/session/tree/active-path.js";
import { effectiveToolCall, gatewayChainReceipts } from "../tools/surface.js";

/**
 * Compact start for step turns (WTF-P 0.8.3 C5). Under a template's
 * `turnPolicy: step`, each turn runs one step and ends on a state summary. On
 * a route whose model is small, or that does not cache prompts, resending the
 * whole conversation for every step costs the most and helps the least, so
 * each step turn after the first starts from a step-boundary checkpoint
 * instead: the previous step's final summary and the template body, with the
 * extension pinned blocks re-sent in the tail once the checkpoint drops their
 * earlier copy. Cached standard and frontier routes keep the full history.
 */

/** What the session route reports about itself, from its runtime resolution (WTF-P 0.8.3 C1). */
export interface StepStartRoute {
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

/** A small model, or a route that does not cache prompts, starts each later step turn from a compact state. */
export function compactStepStartDue(route: StepStartRoute): boolean {
	return stepCheckpointApplies(route);
}

/** Where the session stands: its id and the leaf turn of its active branch. */
export interface StepPosition {
	sessionId: string | null;
	leafTurnId: string | null;
}

interface StepChain {
	/** The session the chain began in; a step from another session never reads it. */
	sessionId: string | null;
	template: string;
	stepTool: string;
	/** The expanded template text of the operator turn that started the chain. */
	body: string;
	/** The user row of the operator turn whose text is `body`; set when that turn settles. */
	bodyTurnId?: string;
	/** The last settled step turn's final text; absent until one settles cleanly. */
	finalText?: string;
	/** The leaf the settled step turn left; the next step's lead requires the session to stand on it still. */
	settledLeaf?: string;
}

/**
 * Where the step chain is durable (`clio-coder.step-chain`, format 7). A record
 * hangs off a leaf, so the newest one on the active path is the chain's state
 * for whoever stands there: a reopen resumes it, and a clear written on the leaf
 * being left is what navigating away and back finds.
 */
export interface StepChainStore {
	/** The newest step-chain record on the active path through `leafTurnId`, or null. */
	read(leafTurnId: string): StepChainData | null;
	/** Append `data` under `parentTurnId` in the current session. */
	write(data: StepChainData, parentTurnId: string): void;
}

/** The step chain's store in the session ledger. */
export function sessionStepChainStore(
	session: Pick<SessionContract, "current" | "appendEntry" | "flushAppends"> | undefined,
	readEntries: (() => ReadonlyArray<SessionEntry>) | undefined,
): StepChainStore {
	return {
		read(leafTurnId) {
			const record = findLastEntry(
				filterEntriesToActivePath(readEntries?.() ?? [], leafTurnId),
				(entry) => entry.kind === "custom" && entry.customType === STEP_CHAIN_CUSTOM_TYPE,
			);
			return record?.kind === "custom" && isStepChainData(record.data) ? record.data : null;
		},
		write(data, parentTurnId) {
			// The record belongs to the session it names; a session that has already changed is a reopen.
			if (!session || session.current()?.id !== data.sessionId) return;
			try {
				session.appendEntry({ kind: "custom", customType: STEP_CHAIN_CUSTOM_TYPE, parentTurnId, data });
				session.flushAppends?.();
			} catch {
				// The chain is a cost optimization: an unwritten record leaves a reopen on the full history.
			}
		},
	};
}

export interface StepStartTracker {
	/**
	 * A step turn is starting. Returns the checkpoint lead when this turn
	 * follows a settled step turn of the same template and step tool, in the
	 * same session, whose leaf is still the session's leaf, and null otherwise.
	 * A continuation reuses the chain's template body; an operator turn's own
	 * text is the body, so its lead leaves the body out.
	 */
	begin(
		constraints: TurnConstraints | undefined,
		text: string,
		continuation: boolean,
		position: StepPosition,
	): string | null;
	/**
	 * The turn settled: keep its final text and leaf for the next step, or drop the chain when it ended badly.
	 * `turnId` is the settling turn's user row, which a chain's first turn records as its body's row.
	 */
	settle(
		constraints: TurnConstraints | undefined,
		finalText: string,
		clean: boolean,
		position: StepPosition,
		turnId?: string | null,
	): void;
	/**
	 * The session changed or navigated to `nextLeafTurnId`. `position` is where the session stood; a navigation within
	 * it to another leaf clears the chain on the leaf being left. A reopen, a session change or a reset in place holds
	 * the chain recorded on the leaf arrived at, as the live tracker held it there, so a session left by a switch
	 * resumes its chain on return exactly as a reopen of it does.
	 */
	reset(position?: StepPosition, nextLeafTurnId?: string | null): void;
}

/**
 * Without a store the chain lives only in memory. With one, every settled step
 * writes the chain's record and every dropped chain writes a clear, so `begin`
 * on an empty tracker reads back what the live tracker held at that leaf.
 */
export function createStepStartTracker(store?: StepChainStore): StepStartTracker {
	let chain: StepChain | null = null;
	/** The session of the position the tracker last stood at; a reset into another one is a session change. */
	let standing: string | null | undefined;
	/**
	 * The chain the live tracker holds between turns at `position`: this session's newest record on its path, settled
	 * on exactly this leaf. A reopen restores it eagerly, so leaving the leaf clears it as live use would.
	 */
	const load = (position: StepPosition): StepChain | null => {
		if (store === undefined || position.sessionId === null || position.leafTurnId === null) return null;
		const record = store.read(position.leafTurnId);
		if (
			record === null ||
			"cleared" in record ||
			record.sessionId !== position.sessionId ||
			record.settledLeaf !== position.leafTurnId
		)
			return null;
		return {
			sessionId: record.sessionId,
			template: record.template,
			stepTool: record.stepTool,
			body: record.body,
			bodyTurnId: record.bodyTurnId,
			finalText: record.finalText,
			settledLeaf: record.settledLeaf,
		};
	};
	/** Drop the live chain, writing a clear on each leaf where its state was readable. */
	const drop = (position: StepPosition): void => {
		const dropped = chain;
		chain = null;
		if (store === undefined || dropped === null || dropped.sessionId === null) return;
		if (dropped.sessionId !== position.sessionId) return;
		const anchors = new Set([position.leafTurnId, dropped.settledLeaf]);
		for (const anchor of anchors) {
			if (anchor === null || anchor === undefined) continue;
			store.write({ version: 1, sessionId: dropped.sessionId, cleared: true }, anchor);
		}
	};
	/** The durable chain at `position`, when it continues `template` and `stepTool` from exactly this leaf. */
	const restore = (position: StepPosition, template: string, stepTool: string): StepChain | null => {
		const loaded = load(position);
		return loaded !== null && loaded.template === template && loaded.stepTool === stepTool ? loaded : null;
	};
	return {
		begin(constraints, text, continuation, position) {
			const policy = constraints?.turnPolicy;
			if (policy === undefined) {
				standing = position.sessionId;
				drop(position);
				return null;
			}
			standing = position.sessionId;
			const template = policy.template ?? "";
			if (chain === null) chain = restore(position, template, policy.stepTool);
			const same =
				chain !== null &&
				chain.sessionId === position.sessionId &&
				chain.template === template &&
				chain.stepTool === policy.stepTool;
			const previous = same ? chain : null;
			if (!same) drop(position);
			const carried = continuation && previous !== null;
			const body = carried ? previous.body : text;
			chain = {
				sessionId: position.sessionId,
				template,
				stepTool: policy.stepTool,
				body,
				...(carried && previous.bodyTurnId !== undefined ? { bodyTurnId: previous.bodyTurnId } : {}),
			};
			if (previous?.finalText === undefined || previous.settledLeaf !== position.leafTurnId) return null;
			return stepCheckpointLead(template, policy.stepTool, previous.finalText, continuation ? body : null);
		},
		settle(constraints, finalText, clean, position, turnId) {
			const policy = constraints?.turnPolicy;
			// A new session is created at its first submit, after this turn began: the chain belongs to it.
			if (chain !== null && chain.sessionId === null && standing === null) chain.sessionId = position.sessionId;
			standing = position.sessionId;
			if (
				chain === null ||
				policy === undefined ||
				chain.stepTool !== policy.stepTool ||
				chain.sessionId !== position.sessionId
			) {
				drop(position);
				return;
			}
			const summary = finalText.trim();
			if (!clean || summary.length === 0 || position.leafTurnId === null) {
				drop(position);
				return;
			}
			chain.finalText = summary;
			chain.settledLeaf = position.leafTurnId;
			if (chain.bodyTurnId === undefined && turnId) chain.bodyTurnId = turnId;
			if (store !== undefined && chain.sessionId !== null && chain.bodyTurnId !== undefined)
				store.write(
					{
						version: 1,
						sessionId: chain.sessionId,
						template: chain.template,
						stepTool: chain.stepTool,
						body: chain.body,
						bodyTurnId: chain.bodyTurnId,
						finalText: chain.finalText,
						settledLeaf: chain.settledLeaf,
					},
					chain.settledLeaf,
				);
		},
		reset(position, nextLeafTurnId) {
			if (position === undefined) {
				chain = null;
				standing = undefined;
				return;
			}
			const arrived = { sessionId: position.sessionId, leafTurnId: nextLeafTurnId ?? null };
			if (position.sessionId === standing && nextLeafTurnId !== position.leafTurnId) {
				// A navigation within the session clears the chain on the leaf it leaves; it arrives with none.
				drop(position);
			} else {
				// A reopen, a session change or a reset in place stands where the session stands: the leaf's own chain.
				chain = load(arrived);
			}
			standing = position.sessionId;
		},
	};
}

/**
 * Whether a step turn ran its step: a call to `stepTool`, a gateway call to it
 * included, whose result came back without an error, or a gateway chain step
 * that called it and settled ok (bt-15). `pipelineDone` is the
 * terminal signal, `details.pipelineDone: true` on that result, which says the
 * pipeline has no step left. Null when the turn ran no step. `messages` are
 * the settled turn's own (bt-6).
 */
export function stepTurnOutcome(messages: ReadonlyArray<unknown>, stepTool: string): { pipelineDone: boolean } | null {
	let ran = false;
	let pipelineDone = false;
	for (const [index, message] of messages.entries()) {
		const assistant = message as { role?: unknown; content?: unknown };
		if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) continue;
		for (const block of assistant.content as ReadonlyArray<{
			type?: unknown;
			id?: unknown;
			name?: unknown;
			arguments?: unknown;
		}>) {
			if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
			const result = messages
				.slice(index + 1)
				.find(
					(entry) =>
						(entry as { role?: unknown; toolCallId?: unknown })?.role === "toolResult" &&
						(entry as { toolCallId?: unknown }).toolCallId === block.id,
				) as { isError?: unknown; details?: unknown } | undefined;
			if (result === undefined) continue;
			// A chain is credited by its own settled steps, whatever its siblings did.
			const chained = gatewayChainReceipts(block.name, result).filter(
				(step) => step.capability === stepTool && step.admission.outcome === "ok",
			);
			if (chained.length > 0) {
				ran = true;
				if (chained.some((step) => (step.result.details as { pipelineDone?: unknown }).pipelineDone === true))
					pipelineDone = true;
				continue;
			}
			if (result.isError === true) continue;
			if (effectiveToolCall(block.name, block.arguments, result.details).toolName !== stepTool) continue;
			const details = result.details as { pipelineDone?: unknown } | null | undefined;
			ran = true;
			if (details?.pipelineDone === true) pipelineDone = true;
		}
	}
	return ran ? { pipelineDone } : null;
}

/** What a settled step turn leaves the step chain; `carried` marks a turn that made no step call of an open pipeline. */
export interface StepRun {
	pipelineDone: boolean;
	carried?: true;
}

/**
 * The step pipeline a chain of step turns is running (bt-15). A step call opens
 * it, and it stays open until a step result says `pipelineDone`. A continuation
 * turn that does the step's work without a step call still belongs to the open
 * pipeline, so a yolo chain continues under its cap instead of ending with steps
 * left. An operator turn, or a turn without the policy, starts over.
 */
export function createStepPipeline(): {
	/** `turnId` is the settling turn's user row, kept as the pipeline's start when this turn opens it. */
	settle(
		stepTool: string | undefined,
		ran: { pipelineDone: boolean } | null,
		continuation: boolean,
		turnId?: string | null,
	): StepRun | null;
	/**
	 * What `settle` would return for a turn that has not settled yet, without changing the pipeline, and the user
	 * row of the earlier turn that opened the pipeline this turn continues (bt-12 #4).
	 */
	peek(
		stepTool: string | undefined,
		ran: { pipelineDone: boolean } | null,
		continuation: boolean,
	): { run: StepRun | null; startTurnId?: string };
} {
	let open: { stepTool: string; startTurnId: string | null } | null = null;
	const continued = (stepTool: string | undefined, continuation: boolean) =>
		stepTool !== undefined && continuation && open?.stepTool === stepTool ? open : null;
	const outcome = (ran: { pipelineDone: boolean } | null, prior: typeof open): StepRun | null =>
		ran !== null ? ran : prior === null ? null : { pipelineDone: false, carried: true };
	return {
		settle(stepTool, ran, continuation, turnId) {
			const prior = continued(stepTool, continuation);
			if (stepTool === undefined) {
				open = null;
				return null;
			}
			const run = outcome(ran, prior);
			open = run === null || run.pipelineDone ? null : (prior ?? { stepTool, startTurnId: turnId ?? null });
			return run;
		},
		peek(stepTool, ran, continuation) {
			const prior = continued(stepTool, continuation);
			const run = stepTool === undefined ? null : outcome(ran, prior);
			return prior === null || prior.startTurnId === null ? { run } : { run, startTurnId: prior.startTurnId };
		},
	};
}

/** The compact state a later step turn starts from, as the checkpoint summary's lead. */
function stepCheckpointLead(template: string, stepTool: string, finalText: string, body: string | null): string {
	const name = template.length > 0 ? `Prompt template "${template}"` : "This turn's template";
	return [
		`Step checkpoint. ${name} runs one ${stepTool} step per turn, and this turn starts the next step from this compact state. The earlier step turns' messages and tool results are kept in the session ledger, not in this context; recall one with context(scope="recall") when a step needs it.`,
		`Previous step's final summary:\n${finalText}`,
		...(body === null ? [] : [`Template instructions for this step (verbatim):\n${body}`]),
	].join("\n\n");
}
