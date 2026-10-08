/**
 * Retained spend and hit rate of the proactive-memory llm tier, folded from the
 * current telemetry ledger and the one rotated generation the sink preserves.
 *
 * The ledger recorded every step's tokens and latency from the day the tier
 * shipped, and nothing ever read it back: the operator's own file held 60
 * llm-tier steps, 137,205 tokens, and 1,666 seconds of model time for 6
 * injections, and no surface said so (#229). `/memory` reads this, so the
 * question "is the background plane earning its cost" is answered by the
 * measurement rather than by an impression.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { parseTaskMemoryTelemetryRecord, TASK_MEMORY_TELEMETRY_FILE } from "./task-memory-telemetry.js";

export interface TaskMemorySpendSummary {
	/** Retained llm-tier boundaries, including skipped attempts. Rules-tier rows are excluded. */
	llmSteps: number;
	/** Llm-tier steps whose reminder reached the visible channel. */
	injections: number;
	/** Injections over llm steps, 0 when no llm step has run. */
	hitRate: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** Cumulative llm-tier step latency. */
	modelMs: number;
	/** Slowest single llm-tier step, which is what a deadline has to answer for. */
	slowestStepMs: number;
	/** Llm-tier steps that spent their whole budget and answered nothing. */
	timeouts: number;
	/** Boundaries skipped because the chat endpoint was serving a turn. */
	endpointBusySkips: number;
	/** Oldest and newest row in the ledger, so a rate is read against a window. */
	firstAt: string | null;
	lastAt: string | null;
	readableFiles: number;
	unreadableFiles: number;
	/** Nonblank rows that could not be parsed as supported telemetry. */
	invalidRows: number;
	/** Calls explicitly recorded as missing provider usage; historical zeros alone cannot establish this. */
	missingTokenCalls: number;
	/** Llm-tier rows predating usage-coverage reporting, or otherwise lacking that observation. */
	unreportedUsageSteps: number;
}

export function taskMemoryStepsPath(stateDir: string = clioStateDir()): string {
	return join(stateDir, "memory", TASK_MEMORY_TELEMETRY_FILE);
}

export function emptyTaskMemorySpendSummary(): TaskMemorySpendSummary {
	return {
		llmSteps: 0,
		injections: 0,
		hitRate: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		modelMs: 0,
		slowestStepMs: 0,
		timeouts: 0,
		endpointBusySkips: 0,
		firstAt: null,
		lastAt: null,
		readableFiles: 0,
		unreadableFiles: 0,
		invalidRows: 0,
		missingTokenCalls: 0,
		unreportedUsageSteps: 0,
	};
}

/** Fold parsed telemetry rows. Exported for callers that already hold the rows. */
export function foldTaskMemorySpend(lines: ReadonlyArray<string>): TaskMemorySpendSummary {
	const summary = emptyTaskMemorySpendSummary();
	summary.readableFiles = 1;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			// An in-progress append can leave a truncated tail; its unknown spend stays visible.
			summary.invalidRows += 1;
			continue;
		}
		const record = parseTaskMemoryTelemetryRecord(parsed);
		if (record === null) {
			summary.invalidRows += 1;
			continue;
		}
		if (summary.firstAt === null || record.at < summary.firstAt) summary.firstAt = record.at;
		if (summary.lastAt === null || record.at > summary.lastAt) summary.lastAt = record.at;
		if (record.reason === "endpoint_busy") summary.endpointBusySkips += 1;
		if (record.tier !== "llm") continue;
		summary.llmSteps += 1;
		if (record.decision === "injected") summary.injections += 1;
		if (record.decision === "timeout") summary.timeouts += 1;
		summary.inputTokens += record.tokenCost.input;
		summary.outputTokens += record.tokenCost.output;
		summary.totalTokens += record.tokenCost.total;
		summary.missingTokenCalls += record.missingTokenCalls ?? 0;
		if (record.missingTokenCalls === undefined) summary.unreportedUsageSteps += 1;
		summary.modelMs += record.latencyMs;
		summary.slowestStepMs = Math.max(summary.slowestStepMs, record.latencyMs);
	}
	summary.hitRate = summary.llmSteps === 0 ? 0 : summary.injections / summary.llmSteps;
	return summary;
}

interface SpendCacheEntry {
	fingerprint: string;
	summary: TaskMemorySpendSummary;
}

const spendCache = new Map<string, SpendCacheEntry>();

/**
 * Read retained ledgers and fold them, reusing the previous fold while neither has
 * moved. `/memory` repaints once a second and the ledger is capped at a
 * megabyte per generation, so an idle second costs two stats rather than parsing JSON.
 * Missing generations contribute no rows; other failures must remain visible.
 */
export function readTaskMemorySpendSummary(stateDir: string = clioStateDir()): TaskMemorySpendSummary {
	const path = taskMemoryStepsPath(stateDir);
	let unreadableFiles = 0;
	const files = [`${path}.1`, path].map((file) => {
		try {
			return { path: file, info: statSync(file, { throwIfNoEntry: false }) };
		} catch {
			// Preserve the other generation's subtotal without claiming the failed one is empty.
			unreadableFiles += 1;
			return { path: file, info: undefined };
		}
	});
	const fingerprint = files
		.map(({ info }) =>
			info === undefined ? "missing" : `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}`,
		)
		.join("|");
	const cached = spendCache.get(path);
	if (unreadableFiles === 0 && cached?.fingerprint === fingerprint) return cached.summary;
	let readableFiles = 0;
	const lines = files.flatMap((file) => {
		if (file.info === undefined) return [];
		try {
			const rows = readFileSync(file.path, "utf8").split("\n");
			readableFiles += 1;
			return rows;
		} catch {
			// A transient read failure must be retried, including when metadata has not changed.
			unreadableFiles += 1;
			return [];
		}
	});
	const summary = foldTaskMemorySpend(lines);
	summary.readableFiles = readableFiles;
	summary.unreadableFiles = unreadableFiles;
	if (unreadableFiles === 0) spendCache.set(path, { fingerprint, summary });
	else spendCache.delete(path);
	return summary;
}

/** Compact operator wording, with incomplete-history warnings before any known totals. */
export function formatTaskMemorySpend(summary: TaskMemorySpendSummary): string {
	const missing = [
		...(summary.unreadableFiles > 0 ? [`${summary.unreadableFiles} unreadable files`] : []),
		...(summary.invalidRows > 0 ? [`${summary.invalidRows} invalid rows`] : []),
		...(summary.missingTokenCalls > 0 ? [`${summary.missingTokenCalls} calls missing usage`] : []),
		...(summary.unreportedUsageSteps > 0 ? [`usage coverage unreported for ${summary.unreportedUsageSteps} steps`] : []),
	];
	const scope = missing.length > 0 ? `partial retained spend (${missing.join(", ")})` : "retained spend";
	if (summary.llmSteps === 0) {
		if (summary.unreadableFiles > 0 && summary.readableFiles === 0) return `${scope} · unavailable`;
		if (missing.length > 0) return `${scope} · no readable LLM steps`;
		return `${scope} · ${summary.readableFiles === 0 ? "no history" : "no LLM steps"}`;
	}
	const tokens =
		summary.totalTokens >= 1_000 ? `${(summary.totalTokens / 1_000).toFixed(1)}k tok` : `${summary.totalTokens} tok`;
	const seconds = summary.modelMs / 1_000;
	const time = seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
	const rate = `${Math.round(summary.hitRate * 100)}%`;
	return `${scope} ${summary.llmSteps} steps · known ${tokens} · ${time} · hit ${summary.injections}/${summary.llmSteps} (${rate})`;
}
