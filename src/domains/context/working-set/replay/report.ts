import type { WorkingSetSettings } from "../../../../core/defaults.js";
import type { ReplayLoadCascade } from "./load-clio.js";
import type { ReplayMetricAggregate, ReplayMetrics } from "./metrics.js";

export interface ReplayReportConfig {
	policies: ReadonlyArray<string>;
	budgets: ReadonlyArray<number>;
	threshold: number;
	target: number;
	seed: number;
	/** Synthetic corpus ids replayed, if any; ledgers from --sessions are "ledgers". */
	corpus: ReadonlyArray<string>;
	filter: "default" | "none";
	settings: WorkingSetSettings;
}

export interface ReplayPolicyResult {
	budgetTokens: number;
	policyId: string;
	metrics: ReplayMetricAggregate;
}

export interface ReplayReportInput {
	config: ReplayReportConfig;
	cascade: ReplayLoadCascade;
	results: ReadonlyArray<ReplayPolicyResult>;
	gitSha: string | null;
	commandLine: ReadonlyArray<string>;
}

function metricObject(metrics: ReplayMetrics, turnsToFirstSummaryCount: number): Record<string, number | null> {
	return {
		traces: metrics.traces,
		retention: metrics.retention,
		retentionCovered: metrics.retentionCovered,
		retentionAt10: metrics.retentionAt10,
		evictionPrecision: metrics.evictionPrecision,
		tokensEvicted: metrics.tokensEvicted,
		recallTokens: metrics.recallTokens,
		coldPrefixTokens: metrics.coldPrefixTokens,
		summaryColdPrefixTokens: metrics.summaryColdPrefixTokens,
		cacheMissTokens: metrics.cacheMissTokens,
		cacheMissPerEvent: metrics.cacheMissPerEvent,
		evictionEvents: metrics.evictionEvents,
		checkpoints: metrics.checkpoints,
		overflowReductions: metrics.overflowReductions,
		saturatedEvents: metrics.saturatedEvents,
		turnsToFirstSummary: metrics.turnsToFirstSummary,
		turnsToFirstSummaryCount,
		summaries: metrics.summaries,
	};
}

function reasonObject(result: ReplayPolicyResult): Record<string, { items: number; tokens: number }> {
	return Object.fromEntries([...result.metrics.byReason].map(([reason, tally]) => [reason, { ...tally }]));
}

export function renderReplayJson(input: ReplayReportInput): string {
	const filtered = Object.fromEntries(Object.entries(input.cascade.filtered).sort(([a], [b]) => a.localeCompare(b)));
	const artifact = {
		schema: "clio-coder-context-replay-v3",
		config: {
			policies: [...input.config.policies],
			budgets: [...input.config.budgets],
			threshold: input.config.threshold,
			target: input.config.target,
			seed: input.config.seed,
			corpus: [...input.config.corpus],
			filter: input.config.filter,
			settings: {
				enabled: input.config.settings.enabled,
				policy: input.config.settings.policy,
				profile: input.config.settings.profile,
				target: input.config.settings.target,
				protectLastTurns: input.config.settings.protectLastTurns,
				protectLastSteps: input.config.settings.protectLastSteps,
				minEvictableTokens: input.config.settings.minEvictableTokens,
				rearmFraction: input.config.settings.rearmFraction,
			},
		},
		provenance: {
			gitSha: input.gitSha,
			commandLine: [...input.commandLine],
		},
		cascade: {
			found: input.cascade.found,
			unreadable: input.cascade.unreadable,
			filtered,
			kept: input.cascade.kept,
		},
		results: input.results.map((result) => ({
			budgetTokens: result.budgetTokens,
			policyId: result.policyId,
			metrics: {
				mean: metricObject(result.metrics.mean, result.metrics.turnsToFirstSummaryCount),
				pooledRetention: result.metrics.pooledRetention,
				pooledRetentionCovered: result.metrics.pooledRetentionCovered,
				pooledRetentionAt10: result.metrics.pooledRetentionAt10,
			},
			byReason: reasonObject(result),
		})),
	};
	return `${JSON.stringify(artifact, null, "\t")}\n`;
}

function ratio(value: number): string {
	return value.toFixed(3);
}

function quantity(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function cascadeRows(cascade: ReplayLoadCascade): string[] {
	return [
		`| found | ${cascade.found} |`,
		`| unreadable | ${cascade.unreadable} |`,
		...Object.entries(cascade.filtered).map(([stage, count]) => `| ${stage} | ${count} |`),
		`| kept | ${cascade.kept} |`,
	];
}

const METRIC_HEADER =
	"| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | cache miss per event (mean) | cache miss incl. summaries (mean) | eviction events (mean) | checkpoints (mean) | overflow reductions (mean) | saturated events | turns to first summary (mean) | summaries (mean) |";
const METRIC_RULE =
	"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

function metricRow(policy: string, result: ReplayPolicyResult): string {
	const metrics = result.metrics.mean;
	const firstSummary =
		metrics.turnsToFirstSummary === null
			? "—"
			: `${quantity(metrics.turnsToFirstSummary)} (n=${result.metrics.turnsToFirstSummaryCount})`;
	return [
		policy,
		String(metrics.traces),
		ratio(metrics.retention),
		ratio(result.metrics.pooledRetention),
		ratio(metrics.retentionCovered),
		ratio(result.metrics.pooledRetentionCovered),
		ratio(metrics.retentionAt10),
		ratio(metrics.evictionPrecision),
		quantity(metrics.tokensEvicted),
		quantity(metrics.recallTokens),
		quantity(metrics.coldPrefixTokens),
		quantity(metrics.cacheMissPerEvent),
		quantity(metrics.cacheMissTokens),
		quantity(metrics.evictionEvents),
		quantity(metrics.checkpoints),
		quantity(metrics.overflowReductions),
		ratio(metrics.saturatedEvents),
		firstSummary,
		quantity(metrics.summaries),
	]
		.map((cell) => `| ${cell} `)
		.join("")
		.concat("|");
}

/**
 * Per reason: how many items each rung took and what they were worth, totals
 * over the corpus and per trace. Rows keep `EVICTION_REASONS` order and a
 * reason that never fired is omitted, so a run that adds one rung adds one
 * row and the diff between two runs reads as the rung that changed.
 */
function reasonRows(policy: string, result: ReplayPolicyResult): string[] {
	const traces = Math.max(1, result.metrics.mean.traces);
	return [...result.metrics.byReason].map(
		([reason, tally]) =>
			`| ${policy} | ${reason} | ${tally.items} | ${tally.tokens} | ${quantity(tally.items / traces)} | ${quantity(tally.tokens / traces)} |`,
	);
}

export function renderReplayMarkdown(input: ReplayReportInput): string {
	const lines = [
		"# Clio working-set replay",
		"",
		"## Inclusion cascade",
		"",
		"| stage | traces |",
		"| --- | ---: |",
		...cascadeRows(input.cascade),
	];
	for (const budget of input.config.budgets) {
		const results = input.config.policies
			.map((policy) => ({
				policy,
				result: input.results.find((entry) => entry.budgetTokens === budget && entry.policyId === policy),
			}))
			.filter((entry): entry is { policy: string; result: ReplayPolicyResult } => entry.result !== undefined);
		lines.push("", `## Budget ${budget}`, "", METRIC_HEADER, METRIC_RULE);
		for (const { policy, result } of results) lines.push(metricRow(policy, result));
		const reasons = results.flatMap(({ policy, result }) => reasonRows(policy, result));
		if (reasons.length > 0) {
			lines.push(
				"",
				`### Reasons at ${budget}`,
				"",
				"| policy | reason | items | tokens | items/trace | tokens/trace |",
				"| --- | --- | ---: | ---: | ---: | ---: |",
				...reasons,
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}
