/**
 * Auto-compaction trigger (Phase 12 slice 12d).
 *
 * Pure pressure classifier + in-flight-debounced runner used by the chat-loop
 * before every assistant request. `shouldCompact` returns the graduated stage
 * crossed by the current context pressure; `AutoCompactionTrigger` wraps the
 * actual task so two concurrent chat submissions cannot spawn overlapping
 * compaction runs on the same session.
 *
 * Ported from pi-coding-agent's runtime compaction gate. Kept deliberately
 * small so the chat-loop can call it on the hot path without new allocations
 * per turn. No I/O here. The caller injects the work via `fire(task)`.
 */

export const CONTEXT_COMPACTION_STAGES = [
	"warning",
	"mask_observations",
	"prune_observations",
	"mask_dialogue",
	"llm_summary",
] as const;

export type ContextCompactionStage = (typeof CONTEXT_COMPACTION_STAGES)[number];

export interface ContextCompactionThresholds {
	warning: number;
	maskObservations: number;
	pruneObservations: number;
	maskDialogue: number;
	llmSummary: number;
}

export interface ContextCompactionVerdict {
	stage: ContextCompactionStage | null;
	pressure: number | null;
	contextTokens: number;
	contextWindow: number;
	threshold: number | null;
}

export const DEFAULT_CONTEXT_COMPACTION_THRESHOLDS: ContextCompactionThresholds = {
	warning: 0.7,
	maskObservations: 0.8,
	pruneObservations: 0.85,
	maskDialogue: 0.9,
	llmSummary: 0.99,
};

function clampThreshold(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value <= 0) return 0;
	if (value > 1) return 1;
	return value;
}

export function normalizeContextCompactionThresholds(
	value: Partial<ContextCompactionThresholds> | undefined,
	legacyLlmSummaryThreshold?: number,
): ContextCompactionThresholds {
	const defaults = DEFAULT_CONTEXT_COMPACTION_THRESHOLDS;
	const llmFallback =
		typeof legacyLlmSummaryThreshold === "number" && Number.isFinite(legacyLlmSummaryThreshold)
			? legacyLlmSummaryThreshold
			: defaults.llmSummary;
	return {
		warning: clampThreshold(value?.warning, defaults.warning),
		maskObservations: clampThreshold(value?.maskObservations, defaults.maskObservations),
		pruneObservations: clampThreshold(value?.pruneObservations, defaults.pruneObservations),
		maskDialogue: clampThreshold(value?.maskDialogue, defaults.maskDialogue),
		llmSummary: clampThreshold(value?.llmSummary, llmFallback),
	};
}

function stageThreshold(
	thresholds: ContextCompactionThresholds,
	stage: ContextCompactionStage,
): number {
	switch (stage) {
		case "warning":
			return thresholds.warning;
		case "mask_observations":
			return thresholds.maskObservations;
		case "prune_observations":
			return thresholds.pruneObservations;
		case "mask_dialogue":
			return thresholds.maskDialogue;
		case "llm_summary":
			return thresholds.llmSummary;
	}
}

/**
 * Return the highest graduated stage crossed by `contextTokens / contextWindow`.
 * Defensive behavior mirrors pi-coding-agent's conservative trigger:
 *   - non-positive or NaN contextWindow returns a no-op verdict.
 *   - threshold values outside 0..1 are clamped by the normalizer.
 *   - zero thresholds are treated as disabled for that stage.
 */
export function shouldCompact(
	contextTokens: number,
	thresholds: ContextCompactionThresholds,
	contextWindow: number,
): ContextCompactionVerdict {
	const base: ContextCompactionVerdict = {
		stage: null,
		pressure: null,
		contextTokens,
		contextWindow,
		threshold: null,
	};
	if (!Number.isFinite(contextTokens) || contextTokens <= 0) return base;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return base;

	const pressure = contextTokens / contextWindow;
	let selected: ContextCompactionStage | null = null;
	let selectedThreshold: number | null = null;
	for (const stage of CONTEXT_COMPACTION_STAGES) {
		const threshold = stageThreshold(thresholds, stage);
		if (threshold <= 0) continue;
		if (pressure >= threshold) {
			selected = stage;
			selectedThreshold = threshold;
		}
	}
	return {
		stage: selected,
		pressure,
		contextTokens,
		contextWindow,
		threshold: selectedThreshold,
	};
}

/**
 * Coalesces concurrent `fire(task)` calls onto a single in-flight Promise.
 *
 * A chat session can race a threshold-driven trigger and an overflow-recovery
 * trigger inside the same tick. Both want to run compaction. The first fire
 * starts the task and stores the Promise; subsequent fires observe the same
 * Promise and await it instead of kicking off a second run. Once the task
 * settles (resolve or reject), the slot clears so the next fire starts a
 * fresh run.
 */
export class AutoCompactionTrigger<T> {
	private inFlight: Promise<T> | null = null;

	/** True while a task is in flight. Callers can short-circuit on this. */
	isBusy(): boolean {
		return this.inFlight !== null;
	}

	/**
	 * Run `task` unless one is already in flight. Returns the Promise the
	 * task is running under. Callers always get the eventual result of the
	 * first task, never a second call. Rejections clear the slot so a later
	 * fire can start fresh.
	 */
	fire(task: () => Promise<T>): Promise<T> {
		if (this.inFlight) return this.inFlight;
		const run = task().finally(() => {
			this.inFlight = null;
		});
		this.inFlight = run;
		return run;
	}
}
