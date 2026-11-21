/**
 * A dispatched run's phase (DESIGN 4.5, fleet M8): `work`, then `handback`, then `sealed`. One state holds what four
 * flags held apart: whether work tools are off for the next round, whether that round must call the internal result
 * tool, the round after which the run ends, and why the run sealed without a result. Pure: no I/O, no clock.
 */

export type RunPhaseName = "work" | "handback" | "sealed";

/**
 * What moved the run out of `work`, journaled as the handback's bound kind. `time` is the run's wall clock;
 * `synthesis` an explicit exploration end the dispatching caller set; `result` a helper result's terminal or repair
 * round; `refusals` the execute refusal limit; `tools` the tool budget or ceiling; `context` the role's share of the
 * usable window.
 */
export type HandbackTrigger = "context" | "time" | "synthesis" | "tools" | "refusals" | "result";

export interface RunPhase {
	readonly name: RunPhaseName;
	/** The bound that first moved the run into handback; null while it works. */
	readonly trigger: HandbackTrigger | null;
	/** The next round carries no work tools. */
	readonly toolsLocked: boolean;
	/** The next round must call the internal result tool. */
	readonly resultForced: boolean;
	/** The model round after which the run ends; null when no round limit applies. */
	readonly lastRound: number | null;
	/** Why the run sealed without a result; null until it does. */
	readonly sealedBy: string | null;
	/** Turn work tools off for the next round; the first trigger is the one kept. */
	lockTools(trigger: HandbackTrigger): void;
	/** A granted revision returns the run to work. */
	unlockTools(): void;
	forceResult(trigger: HandbackTrigger): void;
	releaseResult(): void;
	endAfterRound(round: number): void;
	/** Seal with this reason unless the run already sealed. */
	seal(reason: string): void;
	/** Seal with this reason, replacing an earlier one. */
	sealOver(reason: string): void;
}

export function createRunPhase(): RunPhase {
	let trigger: HandbackTrigger | null = null;
	let toolsLocked = false;
	let resultForced = false;
	let lastRound: number | null = null;
	let sealedBy: string | null = null;
	const enter = (kind: HandbackTrigger): void => {
		trigger ??= kind;
	};
	const settleTrigger = (): void => {
		if (!toolsLocked && !resultForced && lastRound === null) trigger = null;
	};
	return {
		get name(): RunPhaseName {
			if (sealedBy !== null) return "sealed";
			return toolsLocked || resultForced || lastRound !== null ? "handback" : "work";
		},
		get trigger() {
			return trigger;
		},
		get toolsLocked() {
			return toolsLocked;
		},
		get resultForced() {
			return resultForced;
		},
		get lastRound() {
			return lastRound;
		},
		get sealedBy() {
			return sealedBy;
		},
		lockTools(kind) {
			enter(kind);
			toolsLocked = true;
		},
		unlockTools() {
			toolsLocked = false;
			settleTrigger();
		},
		forceResult(kind) {
			enter(kind);
			resultForced = true;
		},
		releaseResult() {
			resultForced = false;
			settleTrigger();
		},
		endAfterRound(round) {
			enter("refusals");
			lastRound = round;
		},
		seal(reason) {
			sealedBy ??= reason;
		},
		sealOver(reason) {
			sealedBy = reason;
		},
	};
}
