/**
 * Retained spend and hit rate of the proactive-memory llm tier, folded from the
 * retained step decisions and their referenced call-journal facts (#434).
 *
 * The ledger recorded every step's tokens and latency from the day the tier
 * shipped, and nothing ever read it back: the operator's own file held 60
 * llm-tier steps, 137,205 tokens, and 1,666 seconds of model time for 6
 * injections, and no surface said so (#229). `/memory` reads this, so the
 * question "is the background plane earning its cost" is answered by the
 * measurement rather than by an impression.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { readCallJournalSync } from "../observability/call-journal.js";
import type { FoldedAttempt } from "../observability/folds.js";
import { foldCallJournal, foldCalls } from "../observability/folds.js";
import type { TaskMemoryCallReference } from "./task-memory-policy.js";
import { parseTaskMemoryTelemetryRecord, TASK_MEMORY_TELEMETRY_FILE } from "./task-memory-telemetry.js";

export interface TaskMemorySpendSummary {
	/** Referenced attempts whose journal facts are missing or still incomplete (#434). */
	unresolvedCalls?: number;
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
export function foldTaskMemorySpend(
	lines: ReadonlyArray<string>,
	resolveCall?: (ref: TaskMemoryCallReference) => FoldedAttempt | undefined,
): TaskMemorySpendSummary {
	const seenCalls = new Set<string>();
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
		if (record.calls?.length) {
			const attempts: FoldedAttempt[] = [];
			for (const reference of record.calls) {
				const key = `${reference.repoIdentity}/${reference.sessionId}/${reference.attemptId}`;
				if (seenCalls.has(key)) continue;
				seenCalls.add(key);
				const attempt = resolveCall?.(reference);
				if (attempt) attempts.push(attempt);
				if (!attempt || attempt.settled === null) summary.unresolvedCalls = (summary.unresolvedCalls ?? 0) + 1;
			}
			const totals = foldCalls(attempts);
			summary.inputTokens += totals.usage.input.measured + totals.usage.input.estimated;
			summary.outputTokens += totals.usage.output.measured + totals.usage.output.estimated;
			summary.totalTokens += totals.totalTokens.measured + totals.totalTokens.estimated;
			summary.missingTokenCalls += foldCalls(
				attempts.filter((attempt) => attempt.settled !== null),
			).totalTokens.unknownCount;
		} else {
			summary.inputTokens += record.tokenCost.input;
			summary.outputTokens += record.tokenCost.output;
			summary.totalTokens += record.tokenCost.total;
			summary.missingTokenCalls += record.missingTokenCalls ?? 0;
			if (record.missingTokenCalls === undefined) summary.unreportedUsageSteps += 1;
		}
		summary.modelMs += record.latencyMs;
		summary.slowestStepMs = Math.max(summary.slowestStepMs, record.latencyMs);
	}
	summary.hitRate = summary.llmSteps === 0 ? 0 : summary.injections / summary.llmSteps;
	return summary;
}

interface SpendCacheEntry {
	references: TaskMemoryCallReference[];
	journalFingerprint: string;
	fingerprint: string;
	summary: TaskMemorySpendSummary;
}

const spendCache = new Map<string, SpendCacheEntry>();

/**
 * Reuse the fold while step files and referenced journal segments are unchanged.
 * A late call settlement invalidates the cache even when the step timed out earlier (#434).
 * Missing generations contribute no rows; missing call facts retain explicit coverage.
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
	if (
		unreadableFiles === 0 &&
		cached?.fingerprint === fingerprint &&
		journalFingerprint(stateDir, cached.references) === cached.journalFingerprint
	)
		return cached.summary;
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
	const references = lines.flatMap((line) => {
		try {
			return parseTaskMemoryTelemetryRecord(JSON.parse(line))?.calls ?? [];
		} catch {
			return [];
		} // Invalid lines are counted by the fold below (#434).
	});
	const before = journalFingerprint(stateDir, references);
	const journals = new Map<string, Map<string, FoldedAttempt>>();
	let journalIssues = 0;
	const summary = foldTaskMemorySpend(lines, (reference) => {
		const directory = join(stateDir, "sessions", reference.repoIdentity, reference.sessionId);
		let attempts = journals.get(directory);
		if (!attempts) {
			attempts = new Map();
			journals.set(directory, attempts);
			try {
				const read = readCallJournalSync(directory);
				journalIssues += read.skipped + read.damaged;
				for (const attempt of foldCallJournal(read.records.map(({ record }) => record)).attempts)
					attempts.set(attempt.started.attemptId, attempt);
			} catch {
				unreadableFiles += 1;
			}
		}
		const attempt = attempts.get(reference.attemptId);
		return attempt?.started.callId === reference.callId ? attempt : undefined;
	});
	summary.invalidRows += journalIssues;
	summary.readableFiles = readableFiles;
	summary.unreadableFiles = unreadableFiles;
	// A late settlement can arrive during this read; never cache old facts under its newer fingerprint (#434).
	if (unreadableFiles === 0 && before !== null && before === journalFingerprint(stateDir, references)) {
		spendCache.set(path, { fingerprint, journalFingerprint: before, references, summary });
	} else spendCache.delete(path);
	return summary;
}

/** Compact operator wording, with incomplete-history warnings before any known totals. */
export function formatTaskMemorySpend(summary: TaskMemorySpendSummary): string {
	const missing = [
		...((summary.unresolvedCalls ?? 0) > 0 ? [`${summary.unresolvedCalls} call records unresolved`] : []),
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

function journalFingerprint(stateDir: string, references: readonly TaskMemoryCallReference[]): string | null {
	const directories = [
		...new Set(references.map((ref) => join(stateDir, "sessions", ref.repoIdentity, ref.sessionId))),
	].sort();
	const parts: string[] = [];
	for (const directory of directories) {
		try {
			const names = readdirSync(directory)
				.filter((name) => name === "calls.jsonl" || /^calls\.rec_.*\.jsonl$/.test(name))
				.sort();
			parts.push(directory);
			for (const name of names) {
				const stat = statSync(join(directory, name));
				parts.push(`${name}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			parts.push(`${directory}:missing`);
		}
	}
	return parts.join("|");
}
