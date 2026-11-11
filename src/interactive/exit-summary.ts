import type { ExitSummaryStyle, OutputStyle } from "../core/defaults.js";
import { resolveExitSummaryStyle } from "../core/defaults.js";
import { formatFooterTokens } from "../core/display-units.js";
import { plainOutcomeLabel } from "../domains/dispatch/failure-headline.js";
import { formatOpenDecision } from "../domains/safety/autonomy-window.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";
import {
	brandMark,
	clioTheme,
	exactRouteLabel,
	formatCompactMs,
	formatTargetLabel,
	frame,
	innerDivider,
} from "./theme/index.js";
import { USAGE_NOT_MEASURED } from "./usage-words.js";

const count = (value: number): string => value.toLocaleString("en-US");
const countLabel = (value: number | string, noun: string): string =>
	`${typeof value === "number" ? count(value) : value} ${noun}${value === 1 || value === "1" ? "" : "s"}`;

const SPEND_NOT_AVAILABLE = "not available";

/**
 * `3 outcomes · 2 reproduce or numeric-compare passes · 1 worker run host-verified · 4,115 tokens each · ~$0.0041 est
 * each`, or the words saying there is nothing to divide by. A share keeps the session row's own mark, so an unpriced
 * route reads `cost not measured` here as it does on /usage.
 */
function verifiedFacts(spend: ExitSummarySnapshot["spend"]): string[] {
	if (spend.kind !== "ready") return [SPEND_NOT_AVAILABLE];
	const verified = spend.verified;
	if (verified.kind === "none") return [verified.words];
	return [
		countLabel(verified.count, "outcome"),
		...verified.parts,
		verified.tokens === USAGE_NOT_MEASURED ? `tokens ${USAGE_NOT_MEASURED}` : `${verified.tokens} tokens each`,
		verified.cost === USAGE_NOT_MEASURED ? `cost ${USAGE_NOT_MEASURED}` : `${verified.cost} each`,
	];
}

/** What joins the facts of one row, and the only place a narrow row may break (E4). */
const FACT_SEPARATOR = " · ";

/** A wrapped row's continuation starts here, so it reads as the same row rather than a new one. */
const HANG = "  ";

/**
 * The route as the session header spells it, `target · model`, naming the target once: a model id that already starts
 * with its target's name (`mock` serving `mock/judge-model`) read `mock / mock/judge-model` (E3).
 */
function routeLabel(target: string, model: string): string {
	const named = model.startsWith(`${target}/`) ? model.slice(target.length + 1) : model;
	return exactRouteLabel({ targetId: target, modelId: named }) ?? formatTargetLabel(target, model);
}

/**
 * `lead` then the facts, laid out in `room` cells. A row breaks only between facts and drops the separator at the
 * break, so no row starts or ends with `·` and no fact is split across rows (E4). A fact wider than a whole row has no
 * boundary to break at, so it alone wraps at its spaces.
 */
function factRows(lead: string, facts: ReadonlyArray<string>, room: number): string[] {
	const rows: string[] = [];
	let row = lead;
	let bare = true;
	const queue = [...facts];
	for (let fact = queue.shift(); fact !== undefined; fact = queue.shift()) {
		const joined = bare ? `${row}${fact}` : `${row}${FACT_SEPARATOR}${fact}`;
		if (visibleWidth(joined) <= room) {
			row = joined;
			bare = false;
			continue;
		}
		const alone = visibleWidth(`${HANG}${fact}`) <= room;
		if (!alone && fact.includes(FACT_SEPARATOR)) {
			// A compound fact too wide for any row, such as a `target · model` route, breaks at its own boundaries by the
			// same rule, rather than at a space that leaves its `·` ending a row. It starts a row of its own, so its first
			// part never reads as one more fact of the row before it.
			if (!bare) {
				rows.push(row);
				row = HANG;
				bare = true;
			}
			queue.unshift(...fact.split(FACT_SEPARATOR));
			continue;
		}
		if (!bare) {
			rows.push(row);
			row = HANG;
		} else if (row === lead && lead !== "" && alone) {
			// A first fact that fits a row of its own moves under its label rather than splitting beside it.
			rows.push(lead.trimEnd());
			row = HANG;
		}
		if (visibleWidth(`${row}${fact}`) <= room) {
			row = `${row}${fact}`;
			bare = false;
			continue;
		}
		const [first = "", ...rest] = wrapTextWithAnsi(fact, Math.max(1, room - Math.max(visibleWidth(row), HANG.length)));
		bare = false;
		if (rest.length === 0) {
			row = `${row}${first}`;
			continue;
		}
		rows.push(`${row}${first}`, ...rest.slice(0, -1).map((piece) => `${HANG}${piece}`));
		row = `${HANG}${rest.at(-1) ?? ""}`;
	}
	if (!bare || rows.length === 0) rows.push(row);
	return rows;
}

/** A display the collector joined with ` · `, back into its facts. No read-model display contains the separator. */
const factsOf = (line: string): string[] => line.split(FACT_SEPARATOR).filter((fact) => fact.length > 0);

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

/** `2 questions auto-resolved`, `1 permission ask timed out`, or null when Clio answered nothing alone (#421). */
function unattendedSummary(snapshot: Pick<ExitSummarySnapshot, "unattended">): string[] | null {
	const { questions, permissions } = snapshot.unattended;
	const parts = [
		...(questions > 0 ? [`${countLabel(questions, "question")} auto-resolved`] : []),
		...(permissions > 0 ? [`${countLabel(permissions, "permission ask")} timed out and denied`] : []),
	];
	return parts.length > 0 ? parts : null;
}

/** Hook files shown before the line says how many more there are. */
const GIT_HOOKS_SHOWN = 4;

function gitHookEntry(hook: { path: string; kind: string; key?: string }): string {
	return hook.key === undefined ? `${hook.kind} ${hook.path}` : `${hook.kind} ${hook.key} in ${hook.path}`;
}

/** `changed .git/hooks/pre-commit`, `added core.fsmonitor in .git/config`, or null when nothing changed this visit. */
function gitHooksSummary(snapshot: Pick<ExitSummarySnapshot, "gitHooks">): string[] | null {
	const hooks = snapshot.gitHooks ?? [];
	if (hooks.length === 0) return null;
	const shown = hooks.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
	const more = hooks.length > GIT_HOOKS_SHOWN ? [`${count(hooks.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more];
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
function internalGitSummary(snapshot: Pick<ExitSummarySnapshot, "internalGit">): string[] | null {
	const runs = snapshot.internalGit ?? [];
	if (runs.length === 0) return null;
	const shown = runs.slice(0, GIT_HOOKS_SHOWN).map((run) => {
		const changes = run.changes.slice(0, GIT_HOOKS_SHOWN).map(gitHookEntry);
		const more = run.changes.length > GIT_HOOKS_SHOWN ? [`${count(run.changes.length - GIT_HOOKS_SHOWN)} more`] : [];
		return `${run.operation} ${INTERNAL_GIT_OUTCOMES[run.outcome] ?? run.outcome} (${[...changes, ...more].join(", ")})`;
	});
	const more = runs.length > GIT_HOOKS_SHOWN ? [`${count(runs.length - GIT_HOOKS_SHOWN)} more`] : [];
	return [...shown, ...more];
}

/**
 * `contained yolo · 42 tool calls, 12 min, 310k tokens · paused at the 40-call cap · 2 open decisions`, then the
 * decisions themselves when `list`, or null when the session never ran at yolo (ob-yolo D7).
 */
function autonomySummary(snapshot: Pick<ExitSummarySnapshot, "autonomy">, list: boolean): string[] | null {
	const report = snapshot.autonomy;
	if (report === undefined) return null;
	const used = report.usage;
	const total = report.openDecisions.length + report.openDecisionsOmitted;
	const halted =
		report.halted === null
			? []
			: [
					report.halted.kind === "judge"
						? `ended by the safety judge (${report.halted.detail})`
						: `paused at the ${report.halted.detail}`,
				];
	const shown = list ? report.openDecisions.slice(-GIT_HOOKS_SHOWN).map(formatOpenDecision) : [];
	return [
		`${report.confinement} yolo`,
		`${countLabel(used.toolCalls, "tool call")}, ${formatCompactMs(used.activeMs)}, ${formatFooterTokens(used.tokens)} tokens`,
		...halted,
		total === 0 ? "no open decisions" : countLabel(total, "open decision"),
		...shown,
		...(shown.length > 0 && total > shown.length ? [`${count(total - shown.length)} more`] : []),
	];
}

function workerOutcome(worker: ExitSummarySnapshot["workers"][number]): string {
	return worker.outcome === "succeeded" && worker.against !== undefined ? worker.against : worker.outcome;
}

function outcomes(snapshot: ExitSummarySnapshot): string[] {
	const counts = new Map<string, number>();
	// A run that finished but failed its validation reads as Fleet reads it, not as the exit code's success.
	for (const worker of snapshot.workers) {
		const outcome = workerOutcome(worker);
		counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	}
	// Quitting drains the fleet, so a worker still running when the summary was taken did not keep running.
	return [...counts].map(
		([outcome, n]) => `${count(n)} ${outcome === "running" ? "stopped by quitting" : plainOutcomeLabel(outcome)}`,
	);
}

/**
 * The closing line for a visit with no conversation: a launch that sent nothing,
 * or one that only ran a fleet plan. There is no session a resume line could
 * name, so it says that rather than leaving the exit silent.
 */
export function renderExitWithoutConversation(
	preference: ExitSummaryStyle,
	outputStyle: OutputStyle,
	tty: boolean,
): string[] {
	if (resolveExitSummaryStyle(preference, outputStyle) === "off") return [];
	const line = "Clio Coder · no conversation this visit, so there is nothing to resume.";
	return [tty ? clioTheme().fg("annotation", line) : line];
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
	const paint = (row: string, lead: number): string =>
		theme ? `${theme.fg("fieldName", row.slice(0, lead))}${theme.fg("body", row.slice(lead))}` : row;
	/** One row of facts; the lead is the row's own `Key: ` and is painted as a field name. */
	const add = (key: string, facts: ReadonlyArray<string>): void => {
		const lead = `${key}: `;
		const clean = facts.map((fact) => sanitizeCallTargetText(fact));
		if (!tty) {
			lines.push(`${lead}${clean.join(FACT_SEPARATOR)}`);
			return;
		}
		const rows = factRows(lead, clean, room);
		lines.push(paint(rows[0] ?? lead, lead.length), ...rows.slice(1).map((row) => paint(row, 0)));
	};
	const divide = (): void => {
		if (theme) lines.push(innerDivider(theme, room));
	};
	const models = modelList(snapshot);
	const spend = snapshot.spend;
	const unattended = unattendedSummary(snapshot);
	const gitHooks = gitHooksSummary(snapshot);
	const internalGit = internalGitSummary(snapshot);
	const autonomy = autonomySummary(snapshot, style !== "brief");
	const session = snapshot.sessionName ? `${snapshot.sessionName} · ${snapshot.sessionId}` : snapshot.sessionId;
	// The command and its id are one thing to type, so a narrow card breaks before `/resume`, never between them (E7).
	const resumeCommand = `/resume ${sanitizeCallTargetText(snapshot.sessionId)}`;
	const resumeRows =
		!tty || visibleWidth(resume) <= room
			? [resume]
			: ["To resume: clio-coder, then", resumeCommand].flatMap((row) => wrapTextWithAnsi(row, room));
	const resumeLines = resumeRows.map((row) => theme?.fg("commandHint", row) ?? row);
	const visitTime = `${formatCompactMs(snapshot.wallMs)} this visit`;
	if (!tty) lines.push(`Clio Coder · Session ${style === "report" ? "report" : "summary"} · this visit`);
	// Session names can be arbitrarily long; keep identity from consuming the page.
	lines.push(truncateToWidth(paint(`Session: ${sanitizeCallTargetText(session)}`, "Session: ".length), room));
	// Tokens and cost cover every visit and branch the session paid for, workers included, so their rows say
	// "Session" under a card headed "this visit"; the visit's own share is its call count (#434 §11.3).
	if (style === "brief") {
		const model = models.at(-1);
		add("Model", [
			model
				? `${routeLabel(model.target, model.model)}${models.length > 1 ? ` (+${countLabel(models.length - 1, "other")})` : ""}`
				: "not reported",
		]);
		add("Session tokens", spend.kind === "ready" ? factsOf(spend.tokens) : [SPEND_NOT_AVAILABLE]);
		add("Session cost", [spend.kind === "ready" ? spend.cost : SPEND_NOT_AVAILABLE, visitTime]);
		add("Verified", verifiedFacts(spend));
		// What Clio decided while the operator was away is never folded away.
		if (unattended !== null) add("Unattended", unattended);
		// Nor is a hook that runs outside the sandbox on the next git command.
		if (gitHooks !== null) add("Git hooks", gitHooks);
		if (internalGit !== null) add("Internal git", internalGit);
		// Yolo's account of what it ran alone and what it left for the operator.
		if (autonomy !== null) add("Autonomy", autonomy);
	} else {
		// A turn is one operator prompt; a model call is one request sent, so a turn that used tools or retried makes
		// several. Workers' calls count here as /usage counts them, and `workers` counts their runs.
		add("Activity", [
			countLabel(snapshot.turns, "turn"),
			...(spend.kind === "ready" ? [countLabel(spend.visitCalls, "model call")] : []),
			`${countLabel(snapshot.files.length, "file")} changed`,
			countLabel(snapshot.workers.length, "worker"),
		]);
		add("Time", [
			visitTime,
			...(spend.kind !== "ready"
				? [`model time ${SPEND_NOT_AVAILABLE}`]
				: spend.callTime !== null
					? [`${spend.callTime} in model calls`]
					: []),
			...(spend.kind === "ready" && spend.callTimeCoverage !== null ? [spend.callTimeCoverage] : []),
		]);
		add("Session tokens", spend.kind === "ready" ? factsOf(spend.breakdown) : [SPEND_NOT_AVAILABLE]);
		add("Session cost", [spend.kind === "ready" ? spend.cost : SPEND_NOT_AVAILABLE]);
		add("Verified", verifiedFacts(spend));
		if (style === "report" && spend.kind === "ready" && spend.cache !== null) {
			add("Cache", [
				`${spend.cache.share} of prompt tokens read from cache`,
				...(spend.cache.lastTurn !== null ? [`last turn ${spend.cache.lastTurn}`] : []),
				...(spend.cache.replay !== null ? [spend.cache.replay] : []),
			]);
		}
		if (snapshot.compactions > 0) add("Compactions", [count(snapshot.compactions)]);
		if (unattended !== null) add("Unattended", unattended);
		if (gitHooks !== null) add("Git hooks", gitHooks);
		if (internalGit !== null) add("Internal git", internalGit);
		// Yolo's account of what it ran alone and what it left for the operator.
		if (autonomy !== null) add("Autonomy", autonomy);
		if (style === "standard") {
			divide();
			if (models.length > 0) {
				for (const model of models.slice(0, 3)) add("Model", [routeLabel(model.target, model.model)]);
				if (models.length > 3) add("Models", [`${count(models.length - 3)} more`]);
			}
			if (snapshot.tools.length > 0) {
				add("Tools", [
					...snapshot.tools.slice(0, 8).map(({ tool, count: n }) => `${tool} ${count(n)}`),
					...(snapshot.tools.length > 8 ? [countLabel(snapshot.tools.length - 8, "more kind")] : []),
				]);
			}
			if (snapshot.workers.length > 0) add("Workers", outcomes(snapshot));
		} else {
			const sections: Array<{ title: string; rows: string[]; shown: number }> = [];
			/** Each entry is one detail line's facts, wrapped between them like any row. */
			const section = (title: string, entries: ReadonlyArray<ReadonlyArray<string>>): void => {
				if (entries.length === 0) return;
				const rows = entries.flatMap((facts) => {
					const clean = facts.map((fact) => sanitizeCallTargetText(fact));
					return tty ? factRows("", clean, room) : [clean.join(FACT_SEPARATOR)];
				});
				sections.push({ title, rows, shown: 0 });
			};
			section(
				`Models (${models.length})`,
				models.flatMap(({ target, model, spend: recorded }) =>
					recorded
						? [
								[routeLabel(target, model), countLabel(recorded.calls, "model call"), `cost ${recorded.cost}`],
								factsOf(recorded.breakdown),
							]
						: [[routeLabel(target, model), "no call record names it"]],
				),
			);
			if (spend.kind === "ready" && spend.byRole.length > 0) section("Model calls by agent", [factsOf(spend.byRole)]);
			section(
				`Tools (${countLabel(
					snapshot.tools.reduce((sum, tool) => sum + tool.count, 0),
					"call",
				)})`,
				snapshot.tools.map((tool) => [
					`${tool.tool}: ${countLabel(tool.count, "call")}`,
					countLabel(tool.failures, "observed failure"),
				]),
			);
			section(
				`Workers (${count(snapshot.workers.length)}; ${outcomes(snapshot).join(", ")})`,
				snapshot.workers.map((worker) => [
					worker.agent,
					plainOutcomeLabel(workerOutcome(worker)),
					`run record ${worker.record}`,
					routeLabel(worker.target, worker.model),
					worker.runId,
				]),
			);
			section(
				`Files (${count(snapshot.files.length)}; change observations)`,
				snapshot.fileChanges.map((file) => [file.path, count(file.count)]),
			);
			const permissions = Object.entries(snapshot.permissions).filter(([, n]) => n > 0);
			section(
				"Approvals & refusals",
				permissions.map(([status, n]) => [`${status}: ${count(n)}`]),
			);
			section(
				`Timeline${snapshot.timelineOmitted ? ` (${countLabel(snapshot.timelineOmitted, "earlier highlight")} omitted)` : ""}`,
				snapshot.timeline.map((event) => [formatCompactMs(event.elapsedMs), event.text]),
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
					lines.push(truncateToWidth(`… ${countLabel(group.rows.length - group.shown, "more detail line")}`, room));
			}
			if (active.length < sections.length)
				lines.push(
					truncateToWidth(`… ${countLabel(sections.length - active.length, "more section")}; resume to inspect`, room),
				);
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
				// Whole or absent: `t…` in the corner said nothing; the Time row still says `this visit`.
				Math.floor(width) >= 52 ? { rightMeta: "this visit" } : {},
			)
		: lines;
}
