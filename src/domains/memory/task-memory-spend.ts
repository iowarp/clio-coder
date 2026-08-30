/**
 * Lifetime spend and hit rate of the proactive-memory llm tier, folded from the
 * telemetry ledger the sink already writes.
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
	/** Steps that reached the background model. Rules-tier steps cost nothing and are excluded. */
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
	};
}

/** Fold parsed telemetry rows. Exported for callers that already hold the rows. */
export function foldTaskMemorySpend(lines: ReadonlyArray<string>): TaskMemorySpendSummary {
	const summary = emptyTaskMemorySpendSummary();
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			// A truncated tail line is the normal shape of a file being appended to.
			continue;
		}
		const record = parseTaskMemoryTelemetryRecord(parsed);
		if (record === null) continue;
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
		summary.modelMs += record.latencyMs;
		summary.slowestStepMs = Math.max(summary.slowestStepMs, record.latencyMs);
	}
	summary.hitRate = summary.llmSteps === 0 ? 0 : summary.injections / summary.llmSteps;
	return summary;
}

interface SpendCacheEntry {
	mtimeMs: number;
	size: number;
	summary: TaskMemorySpendSummary;
}

const spendCache = new Map<string, SpendCacheEntry>();

/**
 * Read the ledger and fold it, reusing the previous fold while the file has not
 * moved. `/memory` repaints once a second and the ledger is capped at a
 * megabyte, so an idle second costs one `stat` rather than a megabyte of JSON.
 * A missing file is an empty summary: a machine where the llm tier never ran
 * has nothing to report, which is different from a ledger that failed to open.
 */
export function readTaskMemorySpendSummary(stateDir: string = clioStateDir()): TaskMemorySpendSummary {
	const path = taskMemoryStepsPath(stateDir);
	try {
		const info = statSync(path);
		const cached = spendCache.get(path);
		if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;
		const summary = foldTaskMemorySpend(readFileSync(path, "utf8").split("\n"));
		spendCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, summary });
		return summary;
	} catch {
		return emptyTaskMemorySpendSummary();
	}
}

/** Compact operator wording. Empty when the llm tier has never run. */
export function formatTaskMemorySpend(summary: TaskMemorySpendSummary): string {
	if (summary.llmSteps === 0) return "";
	const tokens =
		summary.totalTokens >= 1_000 ? `${(summary.totalTokens / 1_000).toFixed(1)}k tok` : `${summary.totalTokens} tok`;
	const seconds = summary.modelMs / 1_000;
	const time = seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
	const rate = `${Math.round(summary.hitRate * 100)}%`;
	return `spend ${summary.llmSteps} steps · ${tokens} · ${time} · hit ${summary.injections}/${summary.llmSteps} (${rate})`;
}
