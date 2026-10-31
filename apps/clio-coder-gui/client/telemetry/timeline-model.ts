// What a session's timeline says, before any of it is drawn (#434 §11.3): one row per journal entry, in the read
// model's order, with its kind word, a title from the closed vocabularies the journal records, and the server's
// displays beside it. Nothing here formats, rounds or sums a number; a stage bar's geometry is the only arithmetic.

import type { CacheReportV1, TimelineEntry } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";
import { type StageBar, stageBars } from "../pages/traces/trace-model.js";
import { type Explainable, explainable } from "./quantity-model.js";

export interface TimelineDetail extends Explainable {
	readonly label: string;
}

export interface TimelineRow {
	readonly key: string;
	readonly at: string;
	/** The kind's word, which the filter offers and the row's mark reads. */
	readonly kind: string;
	readonly title: string;
	readonly tone: StatusTone;
	readonly details: readonly TimelineDetail[];
	/** A call's recorded stages as parts of its own bar; empty for every other kind. */
	readonly stages: readonly StageBar[];
}

export const TIMELINE_KINDS: Readonly<Record<TimelineEntry["kind"], string>> = {
	call: "Model call",
	turn: "Turn",
	run: "Worker run",
	compaction: "Compaction",
	session: "Session",
	gap: "Journal gap",
	config: "Settings",
	budget: "Budget",
	quota: "Quota",
	tool: "Tool",
	middleware: "Middleware",
	auth: "Sign-in",
	prompt: "Prompt",
	context: "Context",
	"system-one": "System One",
	"worker-channel": "Worker channel",
};

const words = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
const shown = (label: string, value: { readonly display: string } | null): TimelineDetail[] =>
	value ? [{ label, value: value.display, factRef: null }] : [];
const said = (label: string, value: string | null | undefined): TimelineDetail[] =>
	value ? [{ label, value, factRef: null }] : [];

type Described = Pick<TimelineRow, "title" | "tone" | "details">;
export type CacheBreak = CacheReportV1["breaks"][number];

/** A call's cache break as the cache report bills it: what was read again, at what price, and where it diverged. */
const breakDetails = (cacheBreak: CacheBreak | undefined): TimelineDetail[] =>
	cacheBreak
		? [
				{ label: "Re-prefilled", ...explainable(cacheBreak.rePrefilled) },
				{ label: "Break cost", ...explainable(cacheBreak.breakUsd) },
				...said("Diverged at", cacheBreak.firstDivergentSection.display),
				...said("Expected cold", cacheBreak.expectedColdReasons.map(words).join(", ")),
			]
		: [];

/** One entry's title, tone and displays; a call names its cache break when the cache report lists one. */
function describe(entry: TimelineEntry, breaks: ReadonlyMap<string, CacheBreak>): Described {
	switch (entry.kind) {
		case "call": {
			const cacheBreak = breaks.get(entry.attemptId);
			return {
				title: `${entry.agent.role} call · ${words(entry.disposition)}${entry.failure ? ` (${words(entry.failure)})` : ""}${cacheBreak ? " · cache break" : ""}`,
				tone: entry.failure || entry.disposition === "settled_no_usage" ? "fail" : cacheBreak ? "warn" : "neutral",
				details: [
					{ label: "Tokens", ...explainable(entry.tokens) },
					{ label: "Cost", ...explainable(entry.usd) },
					{ label: "First token", ...explainable(entry.timing.ttft) },
					{ label: "Model time", ...explainable(entry.timing.modelTime) },
					{ label: "Cache", value: words(entry.cacheVerdict), factRef: null },
					...breakDetails(cacheBreak),
				],
			};
		}
		case "turn":
			return {
				title: `Turn ended: ${words(entry.stopReason)}${entry.cause ? ` (${words(entry.cause)})` : ""}`,
				tone: entry.cause ? "fail" : "neutral",
				details: [...said("Last stage", entry.stage), ...shown("Retries", entry.retriesShown)],
			};
		case "run":
			return {
				title: `Worker run ${entry.event}${entry.terminalReason ? `: ${words(entry.terminalReason)}` : ""}`,
				tone: entry.terminalReason === "completed" ? "success" : entry.terminalReason ? "fail" : "neutral",
				details: said("Run", entry.runId),
			};
		case "compaction":
			return {
				title: `Compaction ${entry.outcome}`,
				tone: entry.outcome === "committed" ? "success" : entry.outcome === "failed" ? "fail" : "neutral",
				details: [],
			};
		case "session":
			return {
				title:
					entry.event === "forked_from"
						? `Session forked from ${entry.detail ?? "another session"}`
						: `Session ${entry.event}${entry.detail ? `: ${words(entry.detail)}` : ""}`,
				tone: entry.event === "closed" && entry.detail === "error" ? "fail" : "neutral",
				details: [],
			};
		case "gap":
			return {
				title: `Journal gap: ${words(entry.reason)} in ${entry.sink}`,
				tone: "warn",
				details: shown("Records lost", entry.countShown),
			};
		case "config":
			return {
				title:
					entry.event === "snapshot"
						? "Settings recorded"
						: `Settings changed${entry.source ? ` by ${words(entry.source)}` : ""}`,
				tone: "neutral",
				details: entry.paths
					? [
							...said("Applied now", entry.paths.hotReload.join(", ")),
							...said("Next turn", entry.paths.nextTurn.join(", ")),
							...said("After restart", entry.paths.restartRequired.join(", ")),
						]
					: [],
			};
		case "budget":
			return {
				title:
					entry.event === "crossing"
						? `Budget ${entry.level === "over" ? "exceeded" : "reached"}`
						: `Paid request held at the budget${entry.outcome ? `: ${entry.outcome}` : ""}`,
				tone: entry.level === "over" || entry.outcome === "refused" || entry.outcome === "aborted" ? "fail" : "warn",
				details: [
					...shown("Spend", entry.spend),
					...shown("Pending", entry.projected),
					...shown("Ceiling", entry.ceiling),
					...shown("Context", entry.contextTokens),
					...shown("Waited", entry.waited),
					...shown("Raised to", entry.raisedTo),
					...said("Raised by", entry.raisedBy && words(entry.raisedBy)),
				],
			};
		case "quota":
			return {
				title: `Quota reading for ${entry.provider}${entry.limitReached ? ": limit reached" : ""}`,
				tone: entry.limitReached ? "fail" : "neutral",
				details: [
					...entry.windows.map((window) => ({ label: words(window.key), value: window.usedPct.display, factRef: null })),
					...said("Read from", words(entry.source)),
				],
			};
		case "tool":
			return {
				title: `${entry.tool}: ${entry.outcome}${entry.blocked ? ` (${words(entry.blocked)})` : ""}`,
				tone: entry.outcome === "ok" ? "neutral" : "fail",
				details: [
					...shown("Duration", entry.duration),
					...shown("Waited for approval", entry.parked),
					...shown("Result bytes", entry.resultBytes),
				],
			};
		case "middleware":
			return {
				title: `Rule ${entry.ruleId} at ${words(entry.hook)}`,
				tone: entry.severity === "hard-block" ? "fail" : entry.severity === "warn" ? "warn" : "neutral",
				details: [
					...said("Effects", entry.effects.map(words).join(", ")),
					...said("Severity", entry.severity && words(entry.severity)),
					...said("Tool", entry.tool),
					...said("Evidence", entry.evidence),
				],
			};
		case "auth":
			return {
				title: `Credential refresh for ${entry.provider}: ${entry.outcome}`,
				tone: entry.outcome === "failed" ? "fail" : "neutral",
				details: [
					...said("Trigger", entry.trigger),
					...said("Written by", entry.wroteCredential ? "this session" : "another process"),
					...shown("Duration", entry.duration),
				],
			};
		case "prompt":
			return {
				title: "Prompt structure compiled",
				tone: "neutral",
				details: [...shown("Tokens", entry.tokens), ...shown("Sections", entry.sectionsShown)],
			};
		case "context":
			return {
				title: `Context snapshot, ${entry.source}`,
				tone: "neutral",
				details: [
					{ label: "Window", value: entry.window.display.effective, factRef: null },
					...(entry.window.desired !== entry.window.effective
						? [{ label: "Window asked for", value: entry.window.display.desired, factRef: null }]
						: []),
					...said("Window from", words(entry.window.source)),
					...shown("Estimated", entry.estimated),
					...shown("Provider count", entry.reconciled),
				],
			};
		case "system-one":
			return {
				title: `System One at ${words(entry.site)}: ${words(entry.outcome)}`,
				tone: entry.outcome === "failed" || entry.outcome === "timeout" ? "warn" : "neutral",
				details: [
					...shown("Latency", entry.latency),
					...shown("Deadline", entry.deadline),
					...entry.routes.map((route) => ({
						label: `${route.engine} (${words(route.kind)})`,
						value: `${words(route.outcome)}${route.roundTrip ? ` in ${route.roundTrip.display}` : ""}${route.breaker ? `, breaker ${route.breaker}` : ""}`,
						factRef: null,
					})),
				],
			};
		case "worker-channel":
			return {
				title: `Worker ${entry.lane} ${words(entry.failure)}${entry.afterExit ? " after exit" : ""}`,
				tone: "fail",
				details: [...said("Run", entry.runId), ...said("Frame", entry.frameType), ...said("Error", entry.errno)],
			};
	}
}

/**
 * The timeline as rows, each call joined to its break in the session's cache report by attempt. A call keys by its
 * attempt; any other entry by its kind and time, numbered when two of a kind share an instant, so a re-read that
 * appends entries keeps every earlier row's key.
 */
export function timelineRows(entries: readonly TimelineEntry[], breaks: readonly CacheBreak[] = []): TimelineRow[] {
	const byAttempt = new Map(breaks.map((cacheBreak) => [cacheBreak.attemptId as string, cacheBreak]));
	const seen = new Map<string, number>();
	return entries.map((entry) => {
		const base = entry.kind === "call" ? entry.attemptId : `${entry.kind}:${entry.at}`;
		const repeat = seen.get(base) ?? 0;
		seen.set(base, repeat + 1);
		return {
			key: repeat === 0 ? base : `${base}:${repeat}`,
			at: entry.at,
			kind: TIMELINE_KINDS[entry.kind],
			...describe(entry, byAttempt),
			stages: entry.kind === "call" ? stageBars(entry) : [],
		};
	});
}

/** The kinds the timeline holds, in the vocabulary's order, for a filter. */
export function timelineKinds(rows: readonly TimelineRow[]): string[] {
	const present = new Set(rows.map((row) => row.kind));
	return Object.values(TIMELINE_KINDS).filter((kind) => present.has(kind));
}

/** How many rows the pane draws at a time; earlier ones come a page at a time. */
export const TIMELINE_PAGE = 100;

/** The rows of one kind, or all, newest first and cut at `limit`, with how many earlier rows the cut left out. */
export function timelinePage(
	rows: readonly TimelineRow[],
	kind: string,
	limit: number,
): { rows: TimelineRow[]; earlier: number } {
	const matching = kind ? rows.filter((row) => row.kind === kind) : rows;
	const newest = matching.slice(Math.max(0, matching.length - limit)).reverse();
	return { rows: newest, earlier: matching.length - newest.length };
}
