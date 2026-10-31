import type { ExitSummaryStyle, OutputStyle } from "../core/defaults.js";
import { resolveExitSummaryStyle } from "../core/defaults.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";
import { brandMark, clioTheme, formatCompactMs, frame, innerDivider } from "./theme/index.js";

const count = (value: number): string => value.toLocaleString("en-US");

const SPEND_NOT_AVAILABLE = "not available";

type ModelSpend = Extract<ExitSummarySnapshot["spend"], { kind: "ready" }>["models"][number];

/** The read model's `target/model` groups, then any model this visit saw that no call record names. */
function modelList(snapshot: ExitSummarySnapshot): Array<{ target: string; model: string; spend?: ModelSpend }> {
	const groups = snapshot.spend.kind === "ready" ? snapshot.spend.models : [];
	const recorded = groups.map((spend) => {
		const slash = spend.key.indexOf("/");
		return { target: spend.key.slice(0, slash), model: spend.key.slice(slash + 1), spend };
	});
	const unreported = snapshot.models.filter(
		(model) => !recorded.some((row) => row.target === model.target && row.model === model.model),
	);
	return [...recorded, ...unreported];
}

/** `2 questions auto-resolved · 1 permission ask timed out`, or null when Clio answered nothing alone (#421). */
function unattendedSummary(snapshot: Pick<ExitSummarySnapshot, "unattended">): string | null {
	const { questions, permissions } = snapshot.unattended;
	const parts = [
		...(questions > 0 ? [`${count(questions)} question${questions === 1 ? "" : "s"} auto-resolved`] : []),
		...(permissions > 0
			? [`${count(permissions)} permission ask${permissions === 1 ? "" : "s"} timed out and denied`]
			: []),
	];
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** Hook files shown before the line says how many more there are. */
const GIT_HOOKS_SHOWN = 4;

function gitHookEntry(hook: { path: string; kind: string; key?: string }): string {
	return hook.key === undefined ? `${hook.kind} ${hook.path}` : `${hook.kind} ${hook.key} in ${hook.path}`;
}

/** `changed .git/hooks/pre-commit · added core.fsmonitor in .git/config`, or null when nothing changed this visit. */
function gitHooksSummary(snapshot: Pick<ExitSummarySnapshot, "gitHooks">): string | null {
	const hooks = snapshot.gitHooks ?? [];
	if (hooks.length === 0) return null;
	const shown = hooks.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
	const more = hooks.length > GIT_HOOKS_SHOWN ? [`${count(hooks.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more].join(" · ");
}

/** How the summary words each outcome of src/domains/safety/internal-git-policy.ts. */
const INTERNAL_GIT_OUTCOMES: Readonly<Record<string, string>> = {
	"hooks-off": "without hooks",
	overridden: "with changed config overridden",
	skipped: "skipped",
	yolo: "under yolo with changes",
};

/**
 * `git worktree add without hooks (added .git/hooks/post-checkout) · git
 * merge under yolo with changes (...)`, or null when Clio's own git met no drift.
 */
function internalGitSummary(snapshot: Pick<ExitSummarySnapshot, "internalGit">): string | null {
	const runs = snapshot.internalGit ?? [];
	if (runs.length === 0) return null;
	const shown = runs.slice(0, GIT_HOOKS_SHOWN).map((run) => {
		const changes = run.changes.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
		const more = run.changes.length > GIT_HOOKS_SHOWN ? [`${count(run.changes.length - GIT_HOOKS_SHOWN)} more`] : [];
		return `${run.operation} ${INTERNAL_GIT_OUTCOMES[run.outcome] ?? run.outcome} (${[...changes, ...more].join(", ")})`;
	});
	const more = runs.length > GIT_HOOKS_SHOWN ? [`${count(runs.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more].join(" · ");
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
	const spend = snapshot.spend;
	const unattended = unattendedSummary(snapshot);
	const gitHooks = gitHooksSummary(snapshot);
	const internalGit = internalGitSummary(snapshot);
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
		add("Tokens", spend.kind === "ready" ? spend.tokens : SPEND_NOT_AVAILABLE);
		add(
			"Cost",
			`${spend.kind === "ready" ? spend.cost : SPEND_NOT_AVAILABLE} · ${formatCompactMs(snapshot.wallMs)} wall`,
		);
		// What Clio decided while the operator was away is never folded away.
		if (unattended !== null) add("Unattended", unattended);
		// Nor is a hook that runs outside the sandbox on the next git command.
		if (gitHooks !== null) add("Git hooks", gitHooks);
		if (internalGit !== null) add("Internal git", internalGit);
	} else {
		add(
			"Activity",
			`${count(snapshot.turns)} turns${spend.kind === "ready" ? ` · ${count(spend.visitCalls)} calls this visit` : ""} · ${count(snapshot.files.length)} files changed · ${count(snapshot.workers.length)} workers`,
		);
		add(
			"Time",
			`${formatCompactMs(snapshot.wallMs)} wall this visit · ${spend.kind === "ready" ? `${spend.modelTime} model across the session` : `model ${SPEND_NOT_AVAILABLE}`}`,
		);
		// Session totals cover every branch this session paid for; the visit's own share is its call count.
		add("Tokens", spend.kind === "ready" ? spend.breakdown : SPEND_NOT_AVAILABLE);
		add("Cost", spend.kind === "ready" ? spend.cost : SPEND_NOT_AVAILABLE);
		if (snapshot.compactions > 0) add("Compactions", count(snapshot.compactions));
		if (unattended !== null) add("Unattended", unattended);
		if (gitHooks !== null) add("Git hooks", gitHooks);
		if (internalGit !== null) add("Internal git", internalGit);
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
				models.flatMap(({ target, model, spend: recorded }) =>
					recorded
						? [`${target} / ${model} · ${recorded.calls} calls · ${recorded.cost}`, recorded.breakdown]
						: [`${target} / ${model} · no call record names it`],
				),
			);
			if (spend.kind === "ready" && spend.byRole.length > 0) section("Calls by agent", [spend.byRole]);
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
