import type { ModelTier } from "../core/model-tier.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
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
	return route.modelTier === "small" || route.promptCaching === false;
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
	/** The last settled step turn's final text; absent until one settles cleanly. */
	finalText?: string;
	/** The leaf the settled step turn left; the next step's lead requires the session to stand on it still. */
	settledLeaf?: string;
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
	/** The turn settled: keep its final text and leaf for the next step, or drop the chain when it ended badly. */
	settle(constraints: TurnConstraints | undefined, finalText: string, clean: boolean, position: StepPosition): void;
	/** The session changed or navigated: no later step continues this chain. */
	reset(): void;
}

export function createStepStartTracker(): StepStartTracker {
	let chain: StepChain | null = null;
	return {
		begin(constraints, text, continuation, position) {
			const policy = constraints?.turnPolicy;
			if (policy === undefined) {
				chain = null;
				return null;
			}
			const template = policy.template ?? "";
			const same =
				chain !== null &&
				chain.sessionId === position.sessionId &&
				chain.template === template &&
				chain.stepTool === policy.stepTool;
			const previous = same ? chain : null;
			const body = continuation && previous !== null ? previous.body : text;
			chain = { sessionId: position.sessionId, template, stepTool: policy.stepTool, body };
			if (previous?.finalText === undefined || previous.settledLeaf !== position.leafTurnId) return null;
			return stepCheckpointLead(template, policy.stepTool, previous.finalText, continuation ? body : null);
		},
		settle(constraints, finalText, clean, position) {
			const policy = constraints?.turnPolicy;
			if (
				chain === null ||
				policy === undefined ||
				chain.stepTool !== policy.stepTool ||
				chain.sessionId !== position.sessionId
			) {
				chain = null;
				return;
			}
			const summary = finalText.trim();
			if (!clean || summary.length === 0 || position.leafTurnId === null) {
				chain = null;
				return;
			}
			chain.finalText = summary;
			chain.settledLeaf = position.leafTurnId;
		},
		reset() {
			chain = null;
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
