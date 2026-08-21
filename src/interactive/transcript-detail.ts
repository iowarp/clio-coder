/**
 * Transcript detail policy: the one place `/output minimal|default|verbose`
 * becomes a decision about how much of each foldable transcript block is open
 * before the operator touches it.
 *
 * The chat panel used to consult the verbosity string in four places, each
 * spelling the rule a little differently, and nothing else (running rows, live
 * tool output, worker cards in replay) consulted it at all. The panel now reads
 * this policy once per frame and threads it down; the verbosity string never
 * reaches a renderer.
 *
 * Operator toggles (`Alt+O`, `Alt+R`, expand-all, collapse-all) are overrides
 * layered on top of this policy, not fights with it: the effective state of a
 * block is `override ?? policy`, and `resolveFold` is that one rule.
 *
 * Pure module: no I/O, no UI imports.
 */

import type { OutputVerbosity } from "../core/defaults.js";
import type { ToolFoldDefault, ToolPresentationPolicy } from "../tools/presentation.js";

/** A block's fold state. The same vocabulary serves tools, workers, thinking, and local bash. */
export type Fold = ToolFoldDefault;

/** An operator's explicit choice for one block, or none. */
export type FoldOverride = Fold | undefined;

export interface TranscriptDetailPolicy {
	/** Finished tool call body: folded subline, the tool's own default, or open. */
	toolBody: "folded" | "per-tool" | "expanded";
	/** In-flight tool call: one-line row with elapsed, or the header plus streaming body. */
	runningTool: "row" | "body";
	/** Reasoning stretch: bare marker, folded marker with live progress, or the open rail. */
	thinking: "marker" | "folded" | "rail";
	/** Worker block: folded card, the origin default, or open. */
	worker: "folded" | "origin" | "expanded";
	/** Settled turn receipt: none, `turn · in N · out M`, or the full receipt. */
	receipt: "none" | "compact" | "full";
	/** Failed tool under its folded row: the bounded excerpt, or the full body. */
	errors: "excerpt" | "body";
}

const MINIMAL: TranscriptDetailPolicy = {
	toolBody: "folded",
	runningTool: "row",
	thinking: "marker",
	worker: "folded",
	receipt: "none",
	errors: "excerpt",
};

const DEFAULT: TranscriptDetailPolicy = {
	toolBody: "per-tool",
	runningTool: "row",
	thinking: "folded",
	worker: "origin",
	receipt: "compact",
	errors: "excerpt",
};

const VERBOSE: TranscriptDetailPolicy = {
	toolBody: "expanded",
	runningTool: "body",
	thinking: "rail",
	worker: "expanded",
	receipt: "full",
	errors: "body",
};

/**
 * Map a verbosity to the full policy table. An absent verbosity (a panel built
 * without settings) is the balanced default, so the literal never has to be
 * spelled by the caller.
 */
export function transcriptDetail(verbosity: OutputVerbosity | undefined): TranscriptDetailPolicy {
	switch (verbosity) {
		case "minimal":
			return MINIMAL;
		case "verbose":
			return VERBOSE;
		default:
			return DEFAULT;
	}
}

/** Effective state of one block: the operator's override when set, else the policy's answer. */
export function resolveFold(override: FoldOverride, policyFold: Fold): Fold {
	return override ?? policyFold;
}

/** The fold the policy gives a finished tool call, through the tool's own presentation when asked to. */
export function policyToolFold(detail: TranscriptDetailPolicy, presentation: ToolPresentationPolicy): Fold {
	if (detail.toolBody === "per-tool") return presentation.foldDefault;
	return detail.toolBody;
}

/** The fold the policy gives an in-flight tool call. */
export function policyRunningToolFold(detail: TranscriptDetailPolicy): Fold {
	return detail.runningTool === "body" ? "expanded" : "folded";
}

/** The fold the policy gives a reasoning stretch. */
export function policyThinkingFold(detail: TranscriptDetailPolicy): Fold {
	return detail.thinking === "rail" ? "expanded" : "folded";
}

/**
 * The fold the policy gives a worker block. `askedByModel` is the origin rule
 * the caller already knows: a run the model asked for folds, the operator's own
 * run opens.
 */
export function policyWorkerFold(detail: TranscriptDetailPolicy, askedByModel: boolean): Fold {
	if (detail.worker === "origin") return askedByModel ? "folded" : "expanded";
	return detail.worker;
}

/** The override that flips a block away from its current effective state. */
export function toggledFold(effective: Fold): Fold {
	return effective === "expanded" ? "folded" : "expanded";
}
