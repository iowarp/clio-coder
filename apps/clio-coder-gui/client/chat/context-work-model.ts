import type { ContextActivityPayload, ContextOperation, ContextOperationFact } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";

/** Presentation values only; the ACP projection supplies the operation's actual evidence. */
export interface ContextWorkView {
	id: string;
	title: string;
	label: string;
	tone: StatusTone;
	live: boolean;
	message: string;
	detail: string | null;
	origin: string;
	timing: string | null;
	phases: readonly { key: string; label: string; current: boolean }[];
	progress: { current: number; total: number } | null;
	facts: readonly { label: string; count: string | null; unit: string; paths: readonly string[] }[];
	warnings: readonly string[];
	tokens: string | null;
}

export const CONTEXT_PHASE_LABELS: Readonly<Record<string, string>> = {
	scan: "Read repository",
	codewiki: "Index source",
	generate: "Draft context",
	"clio-md": "Project instructions",
	state: "Record state",
	compact: "Prepare compaction",
	summarize: "Summarize history",
	done: "Result",
};

const TITLES: Readonly<Record<ContextOperation["kind"], string>> = {
	"context-init": "Project context",
	"context-clear": "Context reset",
	"context-refresh": "Context refresh",
	"context-recall": "Context recall",
	"context-recover": "Context recovery",
	compaction: "Context compaction",
};
const OUTCOMES: Readonly<Record<NonNullable<ContextOperation["outcome"]>, { label: string; tone: StatusTone }>> = {
	completed: { label: "Complete", tone: "success" },
	previewed: { label: "Preview", tone: "neutral" },
	unchanged: { label: "Unchanged", tone: "neutral" },
	cancelled: { label: "Stopped", tone: "neutral" },
	failed: { label: "Failed", tone: "fail" },
};

// Preview changes are prospective; reads, summaries and recalls report work already performed.
const FACT_VERBS: Readonly<Record<ContextOperationFact["kind"], readonly [string, string]>> = {
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

const FACT_UNITS: Readonly<Record<ContextOperationFact["unit"], string>> = {
	paths: "paths",
	"source-files": "source files",
	rules: "rules",
	messages: "messages",
	entries: "entries",
	observations: "observations",
};

function duration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Elapsed during live work is a clock estimate; a completed span comes from the owning runtime. */
export function contextWorkView(
	operation: ContextOperation,
	activity?: ContextActivityPayload,
	nowMs = 0,
	available = true,
): ContextWorkView {
	const live = operation.outcome === undefined && available;
	const result = operation.outcome ? OUTCOMES[operation.outcome] : null;
	const warnings = operation.warnings ?? [];
	const elapsed = operation.elapsedMs ?? (live && nowMs > 0 ? nowMs - Date.parse(operation.startedAt) : null);
	const stage = activity?.phase;
	return {
		id: operation.id,
		title: TITLES[operation.kind],
		label: result?.label ?? (live ? "Running" : "Status unavailable"),
		tone: result
			? result.tone === "success" && warnings.length > 0
				? "warn"
				: result.tone
			: live
				? "running"
				: "unverified",
		live,
		message:
			activity?.message ??
			(result
				? `${TITLES[operation.kind]} ${operation.outcome}.`
				: live
					? "Working on context…"
					: "The operation's final result was not reported."),
		detail: activity?.detail ?? null,
		origin: [operation.origin === "automatic" ? "Automatic" : "Operator", operation.reason].filter(Boolean).join(" · "),
		timing:
			elapsed !== null && Number.isFinite(elapsed) && elapsed >= 1000
				? `${operation.elapsedMs === undefined ? "~" : ""}${duration(elapsed)} elapsed`
				: null,
		phases: (activity?.stages ?? (stage && stage !== "done" ? [stage] : [])).map((key) => ({
			key,
			label: CONTEXT_PHASE_LABELS[key] ?? key,
			current: key === stage,
		})),
		progress:
			live &&
			activity?.current !== undefined &&
			activity.total !== undefined &&
			activity.total > 0 &&
			activity.current >= 0 &&
			activity.current <= activity.total
				? { current: activity.current, total: activity.total }
				: null,
		facts: (operation.facts ?? []).map((fact) => ({
			label: FACT_VERBS[fact.kind][operation.outcome === "previewed" ? 1 : 0],
			count: fact.count === undefined ? null : fact.count.toLocaleString("en-US"),
			unit: FACT_UNITS[fact.unit],
			paths: fact.paths ?? [],
		})),
		warnings,
		tokens: operation.tokens
			? `Estimated tokens: ${operation.tokens.before.toLocaleString("en-US")} → ${operation.tokens.after.toLocaleString("en-US")}. Runtime accounting; provider usage is not measured here.`
			: null,
	};
}
