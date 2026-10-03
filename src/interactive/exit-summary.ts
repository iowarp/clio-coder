import type { ExitSummaryStyle, OutputStyle } from "../core/defaults.js";
import { resolveExitSummaryStyle } from "../core/defaults.js";
import type { CostRow } from "../domains/observability/cost-rows.js";
import type { CostAggregate } from "../domains/observability/index.js";
import { formatCostAggregate } from "../domains/observability/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";
import { brandMark, clioTheme, formatCompactMs, frame, innerDivider } from "./theme/index.js";

function costLabel(cost: CostAggregate): string {
	if (cost.allKnownFree) return "$0.00 (free)";
	const amount = formatCostAggregate(cost);
	if (cost.hasUnknown)
		return amount ? `${amount} (${cost.hasEstimated ? "estimated; " : ""}partly unknown)` : "unknown pricing";
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

function modelList(snapshot: ExitSummarySnapshot): Array<{ target: string; model: string; usage?: CostRow }> {
	const models = snapshot.usage.map((usage) => ({ target: usage.providerId, model: usage.attributedModelId, usage }));
	const unreported = snapshot.models.filter(
		(model) =>
			!snapshot.usage.some(
				(row) =>
					row.providerId === model.target &&
					(row.attributedModelId === model.model || row.requestedModelIds.includes(model.model)),
			),
	);
	return [...models, ...unreported];
}

function outcomes(snapshot: ExitSummarySnapshot): string {
	const counts = new Map<string, number>();
	for (const worker of snapshot.workers) counts.set(worker.outcome, (counts.get(worker.outcome) ?? 0) + 1);
	return [...counts].map(([outcome, n]) => `${count(n)} ${outcome}`).join(" · ");
}

/** Pure formatting: no ledger readers, filesystem work, or provider calls on exit. */
export function renderExitSummary(
	snapshot: ExitSummarySnapshot | null,
	preference: ExitSummaryStyle,
	width: number,
	tty: boolean,
	outputStyle: OutputStyle = "standard",
	height = 48,
): string[] {
	if (snapshot === null) return [];
	const style = resolveExitSummaryStyle(preference, outputStyle);
	const resume = `To resume: clio-coder, then /resume ${sanitizeCallTargetText(snapshot.sessionId)}`;
	if (style === "off") return [resume];
	const theme = tty ? clioTheme() : null;
	const room = Math.max(1, Math.floor(width) - (tty ? 4 : 0));
	const lines: string[] = [];
	const row = (key: string, value: string): string => {
		const label = theme ? theme.fg("fieldName", `${key}:`) : `${key}:`;
		const content = sanitizeCallTargetText(value);
		return `${label} ${theme ? theme.fg("body", content) : content}`;
	};
	const wrap = (text: string): string[] => (tty ? wrapTextWithAnsi(text, room) : [text]);
	const add = (key: string, value: string): void => {
		lines.push(...wrap(row(key, value)));
	};
	const divide = (): void => {
		if (theme) lines.push(innerDivider(theme, room));
	};
	const models = modelList(snapshot);
	const session = snapshot.sessionName ? `${snapshot.sessionName} · ${snapshot.sessionId}` : snapshot.sessionId;
	const resumeLines = wrap(theme?.fg("commandHint", resume) ?? resume);
	if (!tty) lines.push(`Clio Coder · Session ${style === "report" ? "report" : "summary"} · this visit`);
	// Session names can be arbitrarily long; keep identity from consuming the page.
	lines.push(truncateToWidth(row("Session", session), room));
	if (style === "brief") {
		const model = models.at(-1);
		lines.push(
			truncateToWidth(
				row(
					"Model",
					model
						? `${model.target} / ${model.model}${models.length > 1 ? ` (+${models.length - 1} others)` : ""}`
						: "not reported",
				),
				room,
			),
		);
		add("Tokens", count(snapshot.usage.reduce((sum, usage) => sum + usage.tokens, 0)));
		add("Cost", `${costLabel(snapshot.cost)} · ${formatCompactMs(snapshot.wallMs)} wall`);
	} else {
		add(
			"Activity",
			`${count(snapshot.turns)} turns · ${count(snapshot.files.length)} files changed · ${count(snapshot.workers.length)} workers`,
		);
		add(
			"Time",
			`${formatCompactMs(snapshot.wallMs)} wall · ${formatCompactMs(snapshot.modelMs)} model${snapshot.modelTimeIncomplete ? " (partly measured)" : ""}`,
		);
		add("Tokens", tokens(snapshot.usage));
		add("Cost", costLabel(snapshot.cost));
		if (snapshot.compactions > 0) add("Compactions", count(snapshot.compactions));
		if (style === "standard") {
			divide();
			if (models.length > 0) {
				for (const model of models.slice(0, 3)) add("Model", `${model.target} / ${model.model}`);
				if (models.length > 3) add("Models", `${count(models.length - 3)} more`);
			}
			if (snapshot.tools.length > 0) {
				add(
					"Tools",
					snapshot.tools
						.slice(0, 8)
						.map(({ tool, count: n }) => `${tool} ${count(n)}`)
						.join(" · ") + (snapshot.tools.length > 8 ? ` · ${snapshot.tools.length - 8} more kinds` : ""),
				);
			}
			if (snapshot.workers.length > 0) add("Workers", outcomes(snapshot));
		} else {
			const sections: Array<{ title: string; rows: string[]; shown: number }> = [];
			const section = (title: string, entries: string[]): void => {
				if (entries.length > 0)
					sections.push({ title, rows: entries.flatMap((entry) => wrap(sanitizeCallTargetText(entry))), shown: 0 });
			};
			section(
				`Models (${models.length})`,
				models.flatMap(({ target, model, usage }) => {
					if (!usage) return [`${target} / ${model} · usage not reported; cost unknown`];
					const requested = usage.requestedModelIds.filter((id) => id !== model);
					const extra = [
						["side questions", usage.sideQuestions],
						["handoffs", usage.handoffs],
						["prewarms", usage.prewarms],
						["memory", usage.backgroundMemory],
						["failed compactions", usage.failedCompaction],
						["system one", usage.systemOne ?? 0],
					]
						.filter(([, n]) => Number(n) > 0)
						.map(([label, n]) => `${n} ${label}`);
					return [
						`${target} / ${model} · ${count(usage.apiCalls)} calls · ${costLabel(usage.cost)}`,
						tokens([usage]),
						...(requested.length ? [`Requested: ${requested.join(", ")}`] : []),
						...(extra.length ? [extra.join(" · ")] : []),
					];
				}),
			);
			section(
				`Tools (${count(snapshot.tools.reduce((sum, tool) => sum + tool.count, 0))} calls)`,
				snapshot.tools.map(
					(tool) => `${tool.tool}: ${count(tool.count)} calls · ${count(tool.failures)} observed failures`,
				),
			);
			section(
				`Workers (${count(snapshot.workers.length)}; ${outcomes(snapshot)})`,
				snapshot.workers.map(
					(worker) =>
						`${worker.agent} · ${worker.outcome} · receipt ${worker.receipt} · ${worker.target} / ${worker.model} · ${worker.runId}`,
				),
			);
			section(
				`Files (${count(snapshot.files.length)}; change observations)`,
				snapshot.fileChanges.map((file) => `${file.path} · ${count(file.count)}`),
			);
			const permissions = Object.entries(snapshot.permissions).filter(([, n]) => n > 0);
			section(
				"Approvals & refusals",
				permissions.map(([status, n]) => `${status}: ${count(n)}`),
			);
			section(
				`Timeline${snapshot.timelineOmitted ? ` (${snapshot.timelineOmitted} earlier highlights omitted)` : ""}`,
				snapshot.timeline.map((event) => `${formatCompactMs(event.elapsedMs)} · ${event.text}`),
			);
			// One terminal page, capped at 80 rows; reserve resume and an omission row per group.
			const page = Math.max(16, Math.min(80, Math.floor(height) - 1));
			const budget = Math.max(0, page - (tty ? 2 : 0) - lines.length - resumeLines.length - 1);
			const active = sections.slice(0, Math.max(0, Math.floor((budget - 1) / 3)));
			let spare = budget - active.length * 2 - (active.length < sections.length ? 1 : 0);
			while (spare > 0) {
				let progressed = false;
				for (const group of active) {
					if (group.shown >= group.rows.length || spare <= 0) continue;
					group.shown += 1;
					spare -= 1;
					progressed = true;
				}
				if (!progressed) break;
			}
			for (const group of active) {
				lines.push(truncateToWidth(theme ? theme.fg("heading", group.title) : group.title, room));
				lines.push(...group.rows.slice(0, group.shown));
				if (group.shown < group.rows.length)
					lines.push(truncateToWidth(`… ${count(group.rows.length - group.shown)} more detail lines`, room));
			}
			if (active.length < sections.length)
				lines.push(truncateToWidth(`… ${sections.length - active.length} more sections; resume to inspect`, room));
		}
	}
	divide();
	lines.push(...resumeLines);
	return theme
		? frame(
				theme,
				`${brandMark(theme)} ${theme.style("wordmark", "Clio Coder", { bold: true })} ${theme.fg("brandCopper", style === "report" ? "· Session report" : "· Session summary")}`,
				lines,
				Math.max(4, Math.floor(width)),
				{ rightMeta: "this visit" },
			)
		: lines;
}
