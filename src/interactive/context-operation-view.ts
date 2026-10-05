/**
 * Presentation model for context operations. The rail above the composer and
 * the transcript result card both read it, so a running state and its result
 * name the same operation the same way. It formats facts the harness measured
 * and never derives new ones.
 */
import type { ContextActivityKind } from "../core/bus-events.js";
import type { ContextOperation, ContextOperationFact, ContextOperationOutcome } from "../core/context-operation.js";
import { stripTerminalSequences } from "../engine/tui.js";
import { footerTokens } from "../session-control/compaction-lines.js";
import type { TurnPreparationPhase } from "../session-control/turn-state.js";

export const CONTEXT_KIND_TITLES: Record<ContextActivityKind, string> = {
	"context-init": "Context init",
	"context-clear": "Context reset",
	"context-refresh": "Context refresh",
	"context-recall": "Context recall",
	"context-recover": "Context recover",
	compaction: "Context compact",
};

/** Progress text and paths can carry file names and provider errors; neither may carry terminal controls. */
export function plain(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: progress includes untrusted filenames and provider error text.
	const cleaned = stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return cleaned.replace(/\s+/g, " ").trim();
}

export function outcomeWord(outcome: ContextOperationOutcome): string {
	switch (outcome) {
		case "completed":
			return "complete";
		case "previewed":
			return "preview ready";
		case "unchanged":
			return "no change";
		case "cancelled":
			return "cancelled";
		case "failed":
			return "failed";
	}
}

export type OutcomeTone = "success" | "warning" | "error" | "annotation";

export function outcomeTone(outcome: ContextOperationOutcome): OutcomeTone {
	if (outcome === "failed") return "error";
	if (outcome === "cancelled") return "warning";
	if (outcome === "unchanged") return "annotation";
	return "success";
}

/**
 * Whether an outcome earns a transcript card. A compaction that failed,
 * cancelled or found nothing to cut already leaves an error or explanatory
 * notice from the chat loop, and a second block would repeat it. Routine
 * automatic maintenance stays quiet unless it fails.
 */
export function showsContextResult(operation: ContextOperation): boolean {
	if (operation.outcome === undefined) return false;
	if (operation.kind === "compaction") return operation.outcome === "completed";
	if (operation.origin === "automatic") return operation.outcome === "failed";
	return true;
}

const UNIT_NAMES: Record<ContextOperationFact["unit"], readonly [string, string]> = {
	paths: ["path", "paths"],
	"source-files": ["source file", "source files"],
	rules: ["rule", "rules"],
	messages: ["message", "messages"],
	entries: ["entry", "entries"],
	observations: ["observation", "observations"],
};

const FACT_VERBS: Record<ContextOperationFact["kind"], readonly [string, string]> = {
	created: ["Created", "Would create"],
	updated: ["Updated", "Would update"],
	indexed: ["Indexed", "Would index"],
	ingested: ["Ingested", "Would ingest"],
	preserved: ["Preserved", "Would preserve"],
	omitted: ["Omitted", "Would omit"],
	removed: ["Removed", "Would remove"],
	read: ["Read", "Read"],
	summarized: ["Summarized", "Summarized"],
	recalled: ["Recalled", "Recalled"],
};

const PATHS_SHOWN = 3;

export interface FactRow {
	/** The measured statement. */
	head: string;
	/** Paths the statement names, shown dim after it. */
	tail: string;
}

export function factRow(fact: ContextOperationFact, outcome: ContextOperationOutcome | undefined): FactRow {
	const [singular, plural] = UNIT_NAMES[fact.unit];
	const verbs = FACT_VERBS[fact.kind];
	const verb = outcome === "previewed" ? verbs[1] : verbs[0];
	const paths = (fact.paths ?? []).map(plain).filter((path) => path.length > 0);
	const count = fact.count;
	if (fact.kind === "removed" && count === 0) return { head: "Nothing removed", tail: "" };
	const shown = paths.slice(0, PATHS_SHOWN).join(", ");
	const more = paths.length > PATHS_SHOWN ? ` (+${paths.length - PATHS_SHOWN})` : "";
	if (count === undefined) {
		// A fact without a count names its paths, so a short list reads as the
		// statement itself ("Created CLIO-CODER.md") and a long one as a total.
		if (paths.length === 0) return { head: verb, tail: "" };
		if (paths.length <= PATHS_SHOWN) return { head: `${verb} ${shown}`, tail: "" };
		return { head: `${verb} ${paths.length} ${plural}`, tail: `: ${shown}${more}` };
	}
	const head = `${verb} ${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
	return { head, tail: paths.length > 0 ? `: ${shown}${more}` : "" };
}

/** Runtime estimates on both sides of one accounting; the basis stays visible. */
export function tokenRow(operation: ContextOperation): string | null {
	const tokens = operation.tokens;
	if (!tokens) return null;
	const change = tokens.before > 0 ? Math.round(((tokens.after - tokens.before) / tokens.before) * 100) : undefined;
	const delta = change === undefined || change === 0 ? "" : ` · ${change < 0 ? "−" : "+"}${Math.abs(change)}%`;
	return `${footerTokens(tokens.before)} → ${footerTokens(tokens.after)} tokens${delta} · estimate`;
}

const WARNINGS_SHOWN = 6;

/**
 * A failed or cancelled operation appends its own conclusion to `warnings`
 * (`createContextOperation().finish`), so that last entry is the cause and the
 * ones before it are warnings gathered while it ran.
 */
export function splitWarnings(operation: ContextOperation): { cause: string | null; warnings: string[] } {
	const all = (operation.warnings ?? []).map(plain).filter((text) => text.length > 0);
	const ended = operation.outcome === "failed" || operation.outcome === "cancelled";
	const cause = ended ? (all.at(-1) ?? null) : null;
	const rest = [...new Set(ended ? all.slice(0, -1) : all)];
	const hidden = rest.length - WARNINGS_SHOWN;
	return {
		cause,
		warnings: hidden > 0 ? [...rest.slice(0, WARNINGS_SHOWN), `${hidden} more warnings omitted`] : rest,
	};
}

/**
 * What Enter does with a message typed while a compaction runs, read from the
 * chat loop's own state. A streaming run takes it as a queued steer; a consumed
 * prompt still being prepared holds it behind the admission gate. Operations
 * that do not gate chat say nothing.
 */
export function admissionHint(
	activity: { kind: ContextActivityKind; completedAtMs: number | null },
	chat: { streaming: boolean; preparation: TurnPreparationPhase },
): string | null {
	if (activity.kind !== "compaction" || activity.completedAtMs !== null) return null;
	if (chat.streaming) return "typed messages queue";
	if (chat.preparation !== "idle") return "Enter holds your message";
	return null;
}
