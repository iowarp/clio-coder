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
	fingerprint: string;
	/** Journal directories the retained steps reference, with the stamp their facts were folded under (#434). */
	directories: string[];
	stamp: string;
	summary: TaskMemorySpendSummary;
}

interface JournalCacheEntry {
	fingerprint: string;
	/** Only referenced attempts are retained; a journal's other calls never enter this fold (#434). */
	referenced: Set<string>;
	attempts: Map<string, FoldedAttempt>;
	issues: number;
	/** Settled facts are immutable: once every referenced attempt has settled, the directory needs no more stats (#434). */
	frozen: boolean;
}

const spendCache = new Map<string, SpendCacheEntry>();
const journalCache = new Map<string, JournalCacheEntry>();

/**
 * Reuse the fold while the step files and the journals still awaiting a settlement are unchanged.
 * The footer reads this on every refresh, so an idle refresh costs two stats plus one readdir per
 * directory that still has an unsettled reference; a late settlement is picked up on the next read (#434).
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
	if (unreadableFiles === 0 && cached?.fingerprint === fingerprint) {
		if (refreshJournals(cached.directories, new Map()) && journalStamp(cached.directories) === cached.stamp)
			return cached.summary;
	}
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
	const referenced = new Map<string, Set<string>>();
	for (const line of lines) {
		let calls: readonly TaskMemoryCallReference[] | undefined;
		try {
			calls = parseTaskMemoryTelemetryRecord(JSON.parse(line))?.calls;
		} catch {
			continue; // Invalid lines are counted by the fold below (#434).
		}
		for (const reference of calls ?? []) {
			const directory = join(stateDir, "sessions", reference.repoIdentity, reference.sessionId);
			const attempts = referenced.get(directory) ?? new Set<string>();
			attempts.add(reference.attemptId);
			referenced.set(directory, attempts);
		}
	}
	const directories = [...referenced.keys()].sort();
	const readable = refreshJournals(directories, referenced);
	const summary = foldTaskMemorySpend(lines, (reference) => {
		const directory = join(stateDir, "sessions", reference.repoIdentity, reference.sessionId);
		const attempt = journalCache.get(directory)?.attempts.get(reference.attemptId);
		return attempt?.started.callId === reference.callId ? attempt : undefined;
	});
	for (const directory of directories) {
		const entry = journalCache.get(directory);
		if (!entry) {
			unreadableFiles += 1;
			continue;
		}
		summary.invalidRows += entry.issues;
		entry.frozen = [...entry.referenced].every((attemptId) => {
			const attempt = entry.attempts.get(attemptId);
			return attempt !== undefined && attempt.settled !== null;
		});
	}
	summary.readableFiles = readableFiles;
	summary.unreadableFiles = unreadableFiles;
	if (unreadableFiles === 0 && readable)
		spendCache.set(path, { fingerprint, directories, stamp: journalStamp(directories), summary });
	else spendCache.delete(path);
	return summary;
}

/**
 * Bring the cached folds of these directories up to date; false when a journal could not be read.
 * A directory is stat'ed before it is read, so a settlement that lands between the two is re-read
 * on the next call rather than cached under its newer fingerprint (#434).
 */
function refreshJournals(
	directories: readonly string[],
	referenced: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
	let readable = true;
	for (const directory of directories) {
		const entry = journalCache.get(directory);
		const wanted = referenced.get(directory) ?? entry?.referenced ?? new Set<string>();
		const covered = entry !== undefined && [...wanted].every((attemptId) => entry.referenced.has(attemptId));
		if (entry?.frozen && covered) continue;
		const current = journalFingerprint(directory);
		if (current === null) {
			journalCache.delete(directory);
			readable = false;
			continue;
		}
		if (entry?.fingerprint === current && covered) continue;
		try {
			const read = readCallJournalSync(directory);
			const attempts = new Map<string, FoldedAttempt>();
			for (const attempt of foldCallJournal(read.records.map(({ record }) => record)).attempts) {
				if (wanted.has(attempt.started.attemptId)) attempts.set(attempt.started.attemptId, attempt);
			}
			journalCache.set(directory, {
				fingerprint: current,
				referenced: new Set(wanted),
				attempts,
				issues: read.skipped + read.damaged,
				frozen: false,
			});
		} catch {
			journalCache.delete(directory);
			readable = false;
		}
	}
	return readable;
}

/** The state a summary was folded under: frozen directories need no fingerprint, the others carry theirs (#434). */
function journalStamp(directories: readonly string[]): string {
	return directories
		.map((directory) => {
			const entry = journalCache.get(directory);
			return entry === undefined
				? `${directory}:unread`
				: entry.frozen
					? `${directory}:frozen`
					: `${directory}:${entry.fingerprint}`;
		})
		.join("|");
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

/** One directory's journal segment identities; null when it exists but cannot be listed (#434). */
function journalFingerprint(directory: string): string | null {
	try {
		const names = readdirSync(directory)
			.filter((name) => name === "calls.jsonl" || /^calls\.rec_.*\.jsonl$/.test(name))
			.sort();
		return names
			.map((name) => {
				const stat = statSync(join(directory, name));
				return `${name}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
			})
			.join(",");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null;
	}
}
