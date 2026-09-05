import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunReceipt } from "../../dispatch/types.js";
import { listSessionLedgerRefs, parseSessionEntries } from "../../session/archive-readers.js";
import { extractReasoningTokens } from "../../session/context-accounting.js";
import type { SessionEntry } from "../../session/entries.js";
import { evalHarnessMetricsFromReceipt } from "../harness-metrics.js";
import type {
	EvalMetricSource,
	EvalSourcedNullableNumber,
	EvalSourcedNumber,
	EvalTrackedMetricsV1,
} from "../schema/verdict.js";

export interface EvalLedgerSnapshot {
	entries: SessionEntry[];
	compiledPromptHashes: string[];
	promptManifests: EvalPromptManifestObservation[];
	contextSnapshots: EvalContextSnapshotObservation[];
}

export interface EvalPromptManifestObservation {
	systemPromptHash: string;
	thinkingLevel: string | null;
	projectPreload: {
		mode: "full" | "synopsis" | "none";
		chars: number;
		lines: number;
		reason: string | null;
		nearLimit: boolean;
		label: string;
	} | null;
	fragments: Array<{ id: string; contentHash: string }>;
}

export interface EvalContextSnapshotObservation {
	runtimeId: string | null;
	modelId: string | null;
	promptHash: string | null;
	toolSignature: string | null;
}

export interface BuildEvalTrackedMetricsInput {
	ledgerEntries: ReadonlyArray<SessionEntry>;
	receipt: RunReceipt | null;
	fallbackWallClockMs: number;
}

interface AssistantCall {
	timestamp: string | null;
	payload: Record<string, unknown>;
	promptCache: Record<string, unknown> | null;
	backend: Record<string, unknown> | null;
	timing: Record<string, unknown> | null;
	usage: Record<string, unknown> | null;
}

interface NumericReading {
	value: number;
	source: EvalMetricSource;
}

/**
 * The session ledger and stdout fold observe the same assistant calls on the
 * native runner. Prefer the durable calls (including their richer timing and
 * cache facts), with stdout as a fallback only when no durable calls exist.
 * Keep non-call entries in either case: compaction is billed but not streamed.
 * Counts are observations, NOT identities or evidence of matching coverage;
 * partial/mixed ledgers cannot be unioned without a shared call identity.
 */
export function selectEvalLedgerEntries(
	durable: ReadonlyArray<SessionEntry>,
	stream: ReadonlyArray<SessionEntry>,
): { entries: ReadonlyArray<SessionEntry>; source: "session" | "stream"; sessionCalls: number; streamCalls: number } {
	const sessionCalls = assistantCalls(durable).length;
	const streamCalls = assistantCalls(stream).length;
	return {
		entries: sessionCalls > 0 ? durable : [...durable, ...stream],
		source: sessionCalls > 0 ? "session" : "stream",
		sessionCalls,
		streamCalls,
	};
}

/** Read every isolated session ledger and its prompt manifest before cleanup. */
export async function readEvalLedgerSnapshot(stateDir: string): Promise<EvalLedgerSnapshot> {
	const refs = await listSessionLedgerRefs(stateDir);
	const entries: SessionEntry[] = [];
	const compiledPromptHashes: string[] = [];
	const promptManifests: EvalPromptManifestObservation[] = [];
	const contextSnapshots: EvalContextSnapshotObservation[] = [];
	for (const ref of refs) {
		try {
			const raw = await readFile(ref.path, "utf8");
			entries.push(...parseSessionEntries(raw, ref.path).entries);
		} catch {
			// An unreadable ledger contributes no invented measurements.
		}
		try {
			const manifest = await readFile(join(dirname(ref.path), "prompt-manifest.jsonl"), "utf8");
			for (const line of manifest.split(/\r?\n/u)) {
				const record = parseJsonRecord(line);
				if (record === null) continue;
				const hash = record?.systemPromptHash;
				if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) continue;
				compiledPromptHashes.push(hash);
				const observation = promptManifestObservation(record);
				if (observation !== null) promptManifests.push(observation);
			}
		} catch {
			// A missing manifest leaves compiled prompt provenance unresolved.
		}
		try {
			const snapshots = await readFile(join(dirname(ref.path), "context-snapshots.jsonl"), "utf8");
			for (const line of snapshots.split(/\r?\n/u)) {
				const record = parseJsonRecord(line);
				if (record === null) continue;
				contextSnapshots.push({
					runtimeId: nullableString(record.runtimeId),
					modelId: nullableString(record.modelId),
					promptHash: nullableDigest(record.promptHash),
					toolSignature: nullableDigest(record.toolSignature),
				});
			}
		} catch {
			// A missing context snapshot leaves runtime and tool-surface provenance unresolved.
		}
	}
	return { entries, compiledPromptHashes: [...new Set(compiledPromptHashes)], promptManifests, contextSnapshots };
}

/** Fold structured ledger calls and a sealed receipt into verdict metrics. */
export function buildEvalTrackedMetrics(input: BuildEvalTrackedMetricsInput): EvalTrackedMetricsV1 {
	const calls = assistantCalls(input.ledgerEntries);
	const compactionEntries = input.ledgerEntries.filter((entry) => entry.kind === "compactionSummary");
	const compactionUsage = compactionEntries.flatMap((entry) => {
		if (entry.kind !== "compactionSummary" || !isRecord(entry.usage)) return [];
		return [entry.usage];
	});

	const modelCallReadings: NumericReading[] = calls.map(() => ledgerReading(1));
	for (const entry of compactionEntries) {
		if (entry.kind !== "compactionSummary") continue;
		const apiCalls = isRecord(entry.usage) ? nonNegativeNumber(entry.usage.apiCalls) : null;
		modelCallReadings.push(apiCalls === null ? estimatedReading(1) : ledgerReading(apiCalls));
	}

	const uncachedReadings = calls.map(uncachedPrefillForCall);
	const cacheReadings = calls.map(cacheReadForCall);
	const generatedReadings = calls.map(generatedForCall);
	for (const usage of compactionUsage) {
		uncachedReadings.push(readingFromUsage(usage, "input"));
		cacheReadings.push(readingFromUsage(usage, "cacheRead"));
		generatedReadings.push(readingFromUsage(usage, "output"));
	}

	const reasoning = reasoningMetric(input.receipt, calls, compactionUsage);
	const receiptToolMetrics = input.receipt === null ? null : evalHarnessMetricsFromReceipt(input.receipt);
	const ledgerToolCalls = input.ledgerEntries.filter(
		(entry) => entry.kind === "message" && entry.role === "tool_call",
	).length;
	const ledgerToolErrors = input.ledgerEntries.filter((entry) => {
		if (entry.kind !== "message" || entry.role !== "tool_result" || !isRecord(entry.payload)) return false;
		return entry.payload.isError === true || entry.payload.outcome === "error";
	}).length;
	const receiptToolErrors = input.receipt?.toolStats.reduce((sum, stat) => sum + finiteNonNegative(stat.errors), 0);
	const expectedColdReasons = expectedColdReasonMetrics(calls);

	return {
		modelCalls: sumReadings(modelCallReadings, "ledger"),
		uncachedPrefillTokens: sumReadings(uncachedReadings, "estimated"),
		cacheReadTokens: sumReadings(cacheReadings, "estimated"),
		generatedTokens: sumReadings(generatedReadings, "estimated"),
		reasoningTokens: reasoning,
		toolCalls:
			receiptToolMetrics === null
				? { value: ledgerToolCalls, source: "ledger" }
				: { value: receiptToolMetrics.toolCalls, source: "receipt" },
		toolErrors:
			receiptToolErrors === undefined
				? { value: ledgerToolErrors, source: "ledger" }
				: { value: receiptToolErrors, source: "receipt" },
		ttftMsFirstCall: firstCallTtft(calls),
		wallClockMs: wallClockMetric(input.receipt, input.fallbackWallClockMs),
		contextTokensAtEnd: contextTokensAtEnd(calls, compactionEntries),
		compactions: { value: compactionEntries.length, source: "ledger" },
		expectedColdReasons,
	};
}

export function emptyEvalTrackedMetrics(source: EvalMetricSource = "estimated"): EvalTrackedMetricsV1 {
	const zero = (): EvalSourcedNumber => ({ value: 0, source });
	return {
		modelCalls: zero(),
		uncachedPrefillTokens: zero(),
		cacheReadTokens: zero(),
		generatedTokens: zero(),
		reasoningTokens: { value: null, source },
		toolCalls: zero(),
		toolErrors: zero(),
		ttftMsFirstCall: { value: null, source: "estimated" },
		wallClockMs: zero(),
		contextTokensAtEnd: zero(),
		compactions: zero(),
		expectedColdReasons: {},
	};
}

function assistantCalls(entries: ReadonlyArray<SessionEntry>): AssistantCall[] {
	return entries.flatMap((entry) => {
		if (entry.kind !== "message" || entry.role !== "assistant" || !isRecord(entry.payload)) return [];
		const promptCache = recordField(entry.payload, "promptCache");
		const timing = recordField(entry.payload, "timing");
		const usage = recordField(entry.payload, "usage");
		if (promptCache === null && timing === null && usage === null) return [];
		return [
			{
				timestamp: entry.payload.timestampEstimated === true ? null : entry.timestamp,
				payload: entry.payload,
				promptCache,
				backend: promptCache === null ? null : recordField(promptCache, "backend"),
				timing,
				usage,
			},
		];
	});
}

function uncachedPrefillForCall(call: AssistantCall): NumericReading {
	const promptTokens = call.backend === null ? null : nonNegativeNumber(call.backend.promptTokens);
	const cachedTokens = call.backend === null ? null : nonNegativeNumber(call.backend.cachedTokens);
	if (promptTokens !== null && cachedTokens !== null && cachedTokens <= promptTokens) {
		return ledgerReading(promptTokens - cachedTokens);
	}
	const piInput = call.promptCache === null ? null : nonNegativeNumber(call.promptCache.input);
	if (piInput !== null) return ledgerReading(piInput);
	const legacyInput = call.usage === null ? null : nonNegativeNumber(call.usage.input);
	return legacyInput === null ? estimatedReading(0) : estimatedReading(legacyInput);
}

function cacheReadForCall(call: AssistantCall): NumericReading {
	const cachedTokens = call.backend === null ? null : nonNegativeNumber(call.backend.cachedTokens);
	if (cachedTokens !== null) return ledgerReading(cachedTokens);
	const piCacheRead = call.promptCache === null ? null : nonNegativeNumber(call.promptCache.cacheRead);
	if (piCacheRead !== null) return ledgerReading(piCacheRead);
	const legacyCacheRead = call.usage === null ? null : nonNegativeNumber(call.usage.cacheRead);
	return legacyCacheRead === null ? estimatedReading(0) : estimatedReading(legacyCacheRead);
}

function generatedForCall(call: AssistantCall): NumericReading {
	const predictedTokens = call.backend === null ? null : nonNegativeNumber(call.backend.predictedTokens);
	if (predictedTokens !== null) return ledgerReading(predictedTokens);
	const output = call.usage === null ? null : nonNegativeNumber(call.usage.output);
	return output === null ? estimatedReading(0) : ledgerReading(output);
}

function readingFromUsage(usage: Record<string, unknown>, field: string): NumericReading {
	const value = nonNegativeNumber(usage[field]);
	return value === null ? estimatedReading(0) : ledgerReading(value);
}

function reasoningMetric(
	receipt: RunReceipt | null,
	calls: ReadonlyArray<AssistantCall>,
	compactionUsage: ReadonlyArray<Record<string, unknown>>,
): EvalSourcedNullableNumber {
	if (receipt !== null && typeof receipt.reasoningTokenCount === "number") {
		return { value: finiteNonNegative(receipt.reasoningTokenCount), source: "receipt" };
	}
	let total = 0;
	let measured = false;
	for (const call of calls) {
		const value = extractReasoningTokens(call.usage);
		if (value === null) continue;
		measured = true;
		total += finiteNonNegative(value);
	}
	for (const usage of compactionUsage) {
		const value = nonNegativeNumber(usage.reasoning);
		if (value === null) continue;
		measured = true;
		total += value;
	}
	return measured ? { value: total, source: "ledger" } : { value: null, source: "estimated" };
}

function firstCallTtft(calls: ReadonlyArray<AssistantCall>): EvalSourcedNullableNumber {
	// Session directories are read by name, not by call time. Select without
	// reordering the evidence or borrowing a later call's available timing.
	let first: AssistantCall | undefined;
	let firstAt = Number.POSITIVE_INFINITY;
	for (const call of calls) {
		if (call.timestamp === null) return { value: null, source: "estimated" };
		const at = Date.parse(call.timestamp);
		if (!Number.isFinite(at)) return { value: null, source: "estimated" };
		if (at < firstAt) {
			first = call;
			firstAt = at;
		}
	}
	const value = first?.timing === null || first?.timing === undefined ? null : nonNegativeNumber(first.timing.ttftMs);
	return value === null ? { value: null, source: "estimated" } : { value, source: "ledger" };
}

function wallClockMetric(receipt: RunReceipt | null, fallback: number): EvalSourcedNumber {
	if (receipt !== null) {
		const started = Date.parse(receipt.startedAt);
		const ended = Date.parse(receipt.endedAt);
		if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
			return { value: ended - started, source: "receipt" };
		}
	}
	return { value: finiteNonNegative(fallback), source: "estimated" };
}

function contextTokensAtEnd(
	calls: ReadonlyArray<AssistantCall>,
	compactions: ReadonlyArray<SessionEntry>,
): EvalSourcedNumber {
	const lastCall = calls.at(-1);
	if (lastCall !== undefined) {
		const lastReading = contextForCall(lastCall);
		if (lastReading !== null && lastReading > 0) return { value: lastReading, source: "ledger" };
		if (lastReading === 0) {
			for (const call of [...calls.slice(0, -1)].reverse()) {
				const reading = contextForCall(call);
				if (reading !== null && reading > 0) return { value: reading, source: "ledger" };
			}
		}
	}
	const lastCompaction = compactions.at(-1);
	if (lastCompaction?.kind === "compactionSummary") {
		const tokensAfter = nonNegativeNumber(lastCompaction.tokensAfter);
		if (tokensAfter !== null) return { value: tokensAfter, source: "ledger" };
	}
	return { value: 0, source: "estimated" };
}

function contextForCall(call: AssistantCall): number | null {
	const promptTokens = call.backend === null ? null : nonNegativeNumber(call.backend.promptTokens);
	const predictedTokens = call.backend === null ? null : nonNegativeNumber(call.backend.predictedTokens);
	if (promptTokens !== null && predictedTokens !== null) return promptTokens + predictedTokens;
	const input = call.promptCache === null ? null : nonNegativeNumber(call.promptCache.input);
	const cacheRead = call.promptCache === null ? null : nonNegativeNumber(call.promptCache.cacheRead);
	const output = call.usage === null ? null : nonNegativeNumber(call.usage.output);
	return input === null || cacheRead === null || output === null ? null : input + cacheRead + output;
}

function expectedColdReasonMetrics(calls: ReadonlyArray<AssistantCall>): Record<string, EvalSourcedNumber> {
	const counts = new Map<string, number>();
	for (const call of calls) {
		const reasons = call.promptCache?.expectedColdReasons;
		if (!Array.isArray(reasons)) continue;
		const unique = new Set(reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0));
		for (const reason of unique) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return Object.fromEntries(
		[...counts.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([reason, value]) => [reason, { value, source: "ledger" as const }]),
	);
}

function sumReadings(readings: ReadonlyArray<NumericReading>, emptySource: EvalMetricSource): EvalSourcedNumber {
	if (readings.length === 0) return { value: 0, source: emptySource };
	return {
		value: readings.reduce((sum, reading) => sum + reading.value, 0),
		source: readings.some((reading) => reading.source === "estimated") ? "estimated" : "ledger",
	};
}

function ledgerReading(value: number): NumericReading {
	return { value: finiteNonNegative(value), source: "ledger" };
}

function estimatedReading(value: number): NumericReading {
	return { value: finiteNonNegative(value), source: "estimated" };
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> | null {
	return isRecord(record[field]) ? record[field] : null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
	if (line.trim().length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function promptManifestObservation(record: Record<string, unknown>): EvalPromptManifestObservation | null {
	const systemPromptHash = nullableDigest(record.systemPromptHash);
	if (systemPromptHash === null || !Array.isArray(record.fragments)) return null;
	const fragments = record.fragments.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.id !== "string") return [];
		const contentHash = nullableDigest(entry.contentHash);
		return contentHash === null ? [] : [{ id: entry.id, contentHash }];
	});
	const preload = record.projectPreload;
	const projectPreload: EvalPromptManifestObservation["projectPreload"] =
		preload === null
			? null
			: isRecord(preload) &&
					(preload.mode === "full" || preload.mode === "synopsis" || preload.mode === "none") &&
					typeof preload.chars === "number" &&
					Number.isInteger(preload.chars) &&
					typeof preload.lines === "number" &&
					Number.isInteger(preload.lines) &&
					typeof preload.nearLimit === "boolean" &&
					typeof preload.label === "string"
				? {
						mode: preload.mode as "full" | "synopsis" | "none",
						chars: preload.chars,
						lines: preload.lines,
						reason: nullableString(preload.reason),
						nearLimit: preload.nearLimit,
						label: preload.label,
					}
				: null;
	return {
		systemPromptHash,
		thinkingLevel: nullableString(record.thinkingLevel),
		projectPreload,
		fragments,
	};
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableDigest(value: unknown): string | null {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
