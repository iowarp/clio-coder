import type { ExitSummaryStyle } from "../core/defaults.js";
import type { CostRow } from "../domains/observability/cost-rows.js";
import { formatCostAggregate } from "../domains/observability/index.js";
import type { CostAggregate } from "../domains/observability/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";
import { brandMark, clioTheme, formatCompactMs, frame, innerDivider } from "./theme/index.js";

function costLabel(cost: CostAggregate): string {
	if (cost.allKnownFree) return "$0.00 (free)";
	const amount = formatCostAggregate(cost);
	if (cost.hasUnknown) return amount ? `${amount} (unknown pricing in total)` : "unknown";
	if (amount === null) return "unknown (not measured)";
	return cost.hasEstimated ? amount : `${amount} (known)`;
}

const count = (value: number): string => value.toLocaleString("en-US");

function tokens(rows: ReadonlyArray<CostRow>): string {
	const total = rows.reduce(
		(sum, row) => ({
			input: sum.input + row.input,
			output: sum.output + row.output,
			cacheRead: sum.cacheRead + row.cacheRead,
			cacheWrite: sum.cacheWrite + row.cacheWrite,
			reasoning: sum.reasoning + row.reasoningTokens,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	);
	return `${count(total.input)} in · ${count(total.output)} out · ${count(total.cacheRead)} cache read · ${count(total.cacheWrite)} cache write · ${count(total.reasoning)} reasoning`;
}

/** Pure formatting: no ledger readers, filesystem work, or provider calls on exit. */
export function renderExitSummary(
	snapshot: ExitSummarySnapshot | null,
	style: ExitSummaryStyle,
	width: number,
	tty: boolean,
): string[] {
	if (snapshot === null) return [];
	const resume = `To resume: clio-coder, then /resume ${sanitizeCallTargetText(snapshot.sessionId)}`;
	if (style === "off") return [resume];
	const theme = tty ? clioTheme() : null;
	const room = Math.max(1, Math.floor(width) - 4);
	const lines: string[] = [];
	const add = (key: string, value: string): void => {
		const label = theme ? theme.fg("fieldName", `${key}:`) : `${key}:`;
		const content = sanitizeCallTargetText(value);
		const text = `${label} ${theme ? theme.fg("body", content) : content}`;
		lines.push(...(tty ? wrapTextWithAnsi(text, room) : [text]));
	};
	const divide = (): void => {
		if (theme) lines.push(innerDivider(theme, room));
	};
	if (!tty) lines.push("Clio Coder · Session summary · this visit");
	add("Session", snapshot.sessionName ?? snapshot.sessionId);
	if (style === "full") {
		add("Wall time", formatCompactMs(snapshot.wallMs));
		add(
			"Model active",
			snapshot.modelTimeIncomplete
				? `${formatCompactMs(snapshot.modelMs)} observed; some calls unmeasured`
				: formatCompactMs(snapshot.modelMs),
		);
		add("Turns", count(snapshot.turns));
	}
	divide();
	const models = new Map<string, { target: string; model: string }>();
	for (const row of snapshot.usage) {
		models.set(`${row.providerId}\0${row.attributedModelId}`, { target: row.providerId, model: row.attributedModelId });
	}
	for (const model of snapshot.models) {
		const attributed = snapshot.usage.some(
			(row) =>
				row.providerId === model.target &&
				(row.attributedModelId === model.model || row.requestedModelIds.includes(model.model)),
		);
		if (!attributed) models.set(`${model.target}\0${model.model}`, model);
	}
	for (const { target, model } of models.values()) {
		add("Model", `${target} / ${model}`);
		if (style === "full") {
			const row = snapshot.usage.find((row) => row.providerId === target && row.attributedModelId === model);
			if (row) {
				const requested = row.requestedModelIds.filter((id) => id !== model);
				if (requested.length > 0) add("Requested", requested.join(", "));
				add("Tokens", tokens([row]));
				add("Cost", costLabel(row.cost));
			} else {
				add("Usage", "not reported; cost unknown");
			}
		}
	}
	add("Total tokens", tokens(snapshot.usage));
	add("Total cost", costLabel(snapshot.cost));
	if (style === "full") {
		divide();
		add(
			"Tool calls",
			snapshot.tools.length > 0 ? snapshot.tools.map(({ tool, count: n }) => `${tool} ${count(n)}`).join(" · ") : "0",
		);
		add("Files changed (observed)", count(snapshot.files.length));
		for (const path of snapshot.files) add("File", path);
		add("Workers dispatched", count(snapshot.workers.length));
		for (const worker of snapshot.workers) add("Worker", `${worker.agent} · ${worker.outcome} · ${worker.runId}`);
		add("Compactions", count(snapshot.compactions));
	}
	divide();
	lines.push(...(tty ? wrapTextWithAnsi(theme?.fg("commandHint", resume) ?? resume, room) : [resume]));
	return theme
		? frame(
				theme,
				`${brandMark(theme)} ${theme.style("wordmark", "Clio Coder", { bold: true })} ${theme.fg("brandCopper", "· Session summary")}`,
				lines,
				Math.max(4, Math.floor(width)),
				{ rightMeta: "this visit" },
			)
		: lines;
}
