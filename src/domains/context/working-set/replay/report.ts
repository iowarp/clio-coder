import type { WorkingSetSettings } from "../../../../core/defaults.js";
import type { ReplayLoadCascade } from "./load-clio.js";
import type { ReplayMetricAggregate, ReplayMetrics } from "./metrics.js";

export interface ReplayReportConfig {
	policies: ReadonlyArray<string>;
	budgets: ReadonlyArray<number>;
	threshold: number;
	target: number;
	seed: number;
	format: "clio" | "claude-code" | "auto";
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
		retentionAt10: metrics.retentionAt10,
		evictionPrecision: metrics.evictionPrecision,
		tokensEvicted: metrics.tokensEvicted,
		evictionEvents: metrics.evictionEvents,
		saturatedEvents: metrics.saturatedEvents,
		churn: metrics.churn,
		turnsToFirstSummary: metrics.turnsToFirstSummary,
		turnsToFirstSummaryCount,
	};
}

export function renderReplayJson(input: ReplayReportInput): string {
	const filtered = Object.fromEntries(Object.entries(input.cascade.filtered).sort(([a], [b]) => a.localeCompare(b)));
	const artifact = {
		schema: "clio-context-replay-v1",
		config: {
			policies: [...input.config.policies],
			budgets: [...input.config.budgets],
			threshold: input.config.threshold,
			target: input.config.target,
			seed: input.config.seed,
			format: input.config.format,
			filter: input.config.filter,
			settings: {
				enabled: input.config.settings.enabled,
				policy: input.config.settings.policy,
				target: input.config.settings.target,
				protectLastTurns: input.config.settings.protectLastTurns,
				minEvictableTokens: input.config.settings.minEvictableTokens,
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
				pooledRetentionAt10: result.metrics.pooledRetentionAt10,
			},
		})),
	};
	return `${JSON.stringify(artifact, null, 2)}\n`;
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
		lines.push(
			"",
			`## Budget ${budget}`,
			"",
			"| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |",
			"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		);
		for (const policy of input.config.policies) {
			const result = input.results.find((entry) => entry.budgetTokens === budget && entry.policyId === policy);
			if (result === undefined) continue;
			const metrics = result.metrics.mean;
			lines.push(
				`| ${policy} | ${metrics.traces} | ${ratio(metrics.retention)} | ${ratio(result.metrics.pooledRetention)} | ${ratio(metrics.retentionAt10)} | ${ratio(metrics.evictionPrecision)} | ${quantity(metrics.tokensEvicted)} | ${quantity(metrics.evictionEvents)} | ${ratio(metrics.saturatedEvents)} | ${ratio(metrics.churn)} | ${metrics.turnsToFirstSummary === null ? "—" : quantity(metrics.turnsToFirstSummary)} (n=${result.metrics.turnsToFirstSummaryCount}) |`,
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}
