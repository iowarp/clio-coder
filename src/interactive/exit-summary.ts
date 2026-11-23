import type { ExitSummaryStyle, OutputStyle } from "../core/defaults.js";
import { formatFooterTokens } from "../core/display-units.js";
import { formatCount } from "../core/format-time.js";
import { tierPolicy } from "../core/presentation-tier.js";
import { plainOutcomeLabel, refusedCallsWords } from "../domains/dispatch/failure-headline.js";
import { formatOpenDecision } from "../domains/safety/autonomy-window.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ExitSummarySnapshot } from "./exit-summary-collector.js";
import {
	brandMark,
	type ClioTheme,
	clioTheme,
	exactRouteLabel,
	formatElapsed,
	formatTargetLabel,
	GLYPH,
	rule,
	type SemanticRole,
	widthClass,
} from "./theme/index.js";
import { economyReceipt, USAGE_NOT_MEASURED } from "./usage-words.js";

const count = (value: number): string => value.toLocaleString("en-US");
const countLabel = (value: number | string, noun: string): string =>
	`${typeof value === "number" ? count(value) : value} ${noun}${value === 1 || value === "1" ? "" : "s"}`;

const SPEND_NOT_AVAILABLE = "not available";

/** What joins the facts of one row, and the only place a narrow row may break (E4). */
const FACT_SEPARATOR = ` ${GLYPH.sep} `;

/**
 * How the collector and the read model join the facts of one display. It is their data format, not this card's
 * chrome, so it stays the literal they write whatever the glyph mode.
 */
const DISPLAY_SEPARATOR = " · ";

/** A display the collector joined, back into its facts. No read-model display contains the separator. */
const factsOf = (line: string): string[] => line.split(DISPLAY_SEPARATOR).filter((fact) => fact.length > 0);

/** Body rows start two cells in, under the title rule's text. */
const INDENT = "  ";

/**
 * Token figures in the short form a shared row uses (`2.0k`, `455.9k`), keeping their `≥` or `≈` mark; the cache
 * read reads `cached`. Only figures of 1,000 and more change, so a note's small counts stay as written.
 */
function shortFigures(text: string): string {
	return text
		.replace(/^cache read /u, "cached ")
		.replace(/\d{1,3}(?:,\d{3})+|\d{4,}/gu, (digits) => formatCount(Number(digits.replaceAll(",", ""))));
}

/** A labelled token figure of the collector's breakdown, as opposed to a note on what no call reported. */
const TOKEN_FIGURE = /^(?:in|out|cache read|cache write|reasoning) \S+$/u;

/**
 * The route-priced cost, then the receipt the economics fold gives: extra cost, seat credits, API equivalent. A
 * declared pool fee belongs to its period, so it is never on this per-session line.
 */
function sessionCostFacts(spend: ExitSummarySnapshot["spend"], tier: OutputStyle): string[] {
	if (spend.kind !== "ready") return [SPEND_NOT_AVAILABLE];
	const facts = [spend.cost, ...(spend.economy ? economyReceipt(spend.economy, null).map((part) => part.text) : [])];
	if (tier === "detailed") return facts;
	// Below detailed a row states one unknown at most (2.9): the measured parts, else the route cost's own words.
	const known = facts.filter((fact) => !UNKNOWN_COST.test(fact));
	return known.length > 0 ? known : [spend.cost];
}

/** A cost part that states no amount: `not measured`, `extra unknown`, `API equiv unknown`. */
const UNKNOWN_COST = new RegExp(`${USAGE_NOT_MEASURED}|\\bunknown\\b|${SPEND_NOT_AVAILABLE}`, "u");

/**
 * `3 outcomes · 2 reproduce or numeric-compare passes · 4,115 session tokens per outcome · ~$0.0041 est per outcome`,
 * or the words saying there is nothing to divide by. The share divides the whole session's spend, so it says so
 * (bt-11).
 */
function verifiedFacts(spend: ExitSummarySnapshot["spend"], tier: OutputStyle): string[] {
	if (spend.kind !== "ready") return [SPEND_NOT_AVAILABLE];
	const verified = spend.verified;
	// Below detailed a row states one unknown, so the none case keeps its two facts short (2.9).
	if (verified.kind === "none")
		return tier === "detailed" ? verified.words.split("; ") : ["no judged outcome", "command checks are not counted"];
	return [
		countLabel(verified.count, "outcome"),
		...verified.parts,
		verified.tokens === USAGE_NOT_MEASURED
			? `tokens ${USAGE_NOT_MEASURED}`
			: `${verified.tokens} session tokens per outcome`,
		verified.cost === USAGE_NOT_MEASURED ? `cost ${USAGE_NOT_MEASURED}` : `${verified.cost} per outcome`,
	];
}

/**
 * The route as the session header spells it, `target · model`, naming the target once: a model id that already starts
 * with its target's name (`mock` serving `mock/judge-model`) read `mock / mock/judge-model` (E3).
 */
function routeLabel(target: string, model: string): string {
	const named = model.startsWith(`${target}/`) ? model.slice(target.length + 1) : model;
	return exactRouteLabel({ targetId: target, modelId: named }) ?? formatTargetLabel(target, model);
}

/**
 * `lead` then the facts, laid out in `room` cells, each later row starting with `hang`. A row breaks only between
 * facts and drops the separator at the break, so no row starts or ends with `·` and no fact is split across rows
 * (E4). A fact wider than a whole row has no boundary to break at, so it alone wraps at its spaces.
 */
function factRows(lead: string, facts: ReadonlyArray<string>, room: number, hang: string): string[] {
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
		const alone = visibleWidth(`${hang}${fact}`) <= room;
		if (!alone && fact.includes(DISPLAY_SEPARATOR)) {
			// A compound fact too wide for any row, such as a `target · model` route, breaks at its own boundaries by the
			// same rule. It starts a row of its own, so its first part never reads as one more fact of the row before it.
			if (!bare) {
				rows.push(row);
				row = hang;
				bare = true;
			}
			queue.unshift(...fact.split(DISPLAY_SEPARATOR));
			continue;
		}
		if (!bare) {
			rows.push(row);
			row = hang;
		}
		if (visibleWidth(`${row}${fact}`) <= room) {
			row = `${row}${fact}`;
			bare = false;
			continue;
		}
		const firstRoom = Math.max(1, room - visibleWidth(row));
		const [first = "", ...overflow] = wrapTextWithAnsi(fact, firstRoom);
		bare = false;
		if (overflow.length === 0) {
			row = `${row}${first}`;
			continue;
		}
		// Only the first piece sits beside the label; the rest rewraps at the row's width under the hanging indent, or a
		// narrow card wrapped every continuation as narrow as the label left the first (CLI-P57).
		const remainder = fact.startsWith(first) ? fact.slice(first.length).trimStart() : overflow.join(" ");
		const rest = wrapTextWithAnsi(remainder, Math.max(1, room - hang.length));
		rows.push(`${row}${first}`, ...rest.slice(0, -1).map((piece) => `${hang}${piece}`));
		row = `${hang}${rest.at(-1) ?? ""}`;
	}
	if (!bare || rows.length === 0) rows.push(row);
	return rows;
}

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
 * The autonomy disclosure: what ran without the operator this visit. A yolo window says how long and how many calls
 * ran unasked, then what stopped it and the decisions it left; what Clio answered for an absent operator follows
 * (#421). Standard and up add the confinement and the cap tokens, detailed lists the open decisions. Null when the
 * visit had no yolo window and answered nothing alone (ob-yolo D7).
 */
function autonomyFacts(snapshot: ExitSummarySnapshot, tier: OutputStyle): string[] | null {
	const facts: string[] = [];
	const report = snapshot.autonomy;
	if (report !== undefined) {
		const total = report.openDecisions.length + report.openDecisionsOmitted;
		facts.push(
			`yolo for ${formatElapsed(report.usage.activeMs)}`,
			`${countLabel(report.usage.toolCalls, "call")} ran unasked`,
		);
		if (report.halted !== null)
			facts.push(
				report.halted.kind === "judge"
					? `ended by the safety judge (${report.halted.detail})`
					: report.halted.kind === "exploration"
						? `ended by the read-streak gate (${report.halted.detail})`
						: `paused at the ${report.halted.detail}`,
			);
		if (total > 0) facts.push(countLabel(total, "open decision"));
		if (tier !== "compact") {
			facts.push(report.confinement, `${formatFooterTokens(report.usage.tokens)} cap tokens`);
			if (total === 0) facts.push("no open decisions");
		}
		if (tier === "detailed") {
			const shown = report.openDecisions.slice(-GIT_HOOKS_SHOWN).map(formatOpenDecision);
			facts.push(...shown);
			if (shown.length > 0 && total > shown.length) facts.push(`${count(total - shown.length)} more`);
		}
	}
	const { questions, permissions } = snapshot.unattended;
	if (questions > 0) facts.push(`${countLabel(questions, "question")} auto-resolved`);
	if (permissions > 0) facts.push(`${countLabel(permissions, "permission ask")} timed out and denied`);
	return facts.length > 0 ? facts : null;
}

/**
 * The failed-check disclosure, worst first: workers whose validation failed or whose record was compromised, check
 * commands that failed, then records left unverified. Null when every check this visit held.
 */
function checkFacts(snapshot: ExitSummarySnapshot): { facts: string[]; failed: boolean } | null {
	const against = new Map<string, number>();
	let compromised = 0;
	let unverified = 0;
	for (const worker of snapshot.workers) {
		if (worker.against !== undefined) against.set(worker.against, (against.get(worker.against) ?? 0) + 1);
		else if (worker.record === "compromised") compromised += 1;
		else if (worker.record === "unverified") unverified += 1;
	}
	const failedChecks = snapshot.tools.find((tool) => tool.tool === "verify")?.failures ?? 0;
	const facts = [
		...[...against].map(([words, n]) =>
			words === "validation failed"
				? `${GLYPH.error} ${countLabel(n, "worker")} failed validation`
				: `${GLYPH.error} ${countLabel(n, "worker")}: ${words}`,
		),
		...(compromised > 0 ? [`${GLYPH.error} ${count(compromised)} compromised`] : []),
		...(failedChecks > 0 ? [`${GLYPH.error} ${countLabel(failedChecks, "check")} failed`] : []),
		...(unverified > 0 ? [`${GLYPH.warn} ${count(unverified)} unverified`] : []),
	];
	if (facts.length === 0) return null;
	return { facts, failed: against.size > 0 || compromised > 0 || failedChecks > 0 };
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
	const words = [...counts].map(
		([outcome, n]) => `${count(n)} ${outcome === "running" ? "stopped by quitting" : plainOutcomeLabel(outcome)}`,
	);
	// A clean exit says nothing of a refused call; the collected block names it, so this row does too.
	const refused = snapshot.workers.reduce((sum, worker) => sum + (worker.refusedCalls ?? 0), 0);
	if (refused === 0) return words;
	const guarded = snapshot.workers.reduce((sum, worker) => sum + (worker.guardedCalls ?? 0), 0);
	return [...words, refusedCallsWords(refused, guarded)];
}

/**
 * One worker as the detailed card names it: its state glyph, agent, run id and the word that state rests on. The
 * worst of the process outcome, the validation verdict and the record's integrity wins (2.7).
 */
function workerFact(worker: ExitSummarySnapshot["workers"][number]): string {
	const ended = worker.outcome === "succeeded" || worker.outcome === "completed";
	const [glyph, word] =
		worker.against !== undefined
			? [GLYPH.error, worker.against]
			: !ended
				? [
						worker.outcome === "running" || worker.outcome === "cancelled" || worker.outcome === "canceled"
							? GLYPH.cancelled
							: GLYPH.error,
						worker.outcome === "running" ? "stopped by quitting" : plainOutcomeLabel(worker.outcome),
					]
				: worker.record === "compromised"
					? [GLYPH.error, worker.record]
					: worker.record === "reviewed" || worker.record === "grounded"
						? [GLYPH.ok, worker.record]
						: [GLYPH.warn, worker.record === "not available" ? "record not read" : worker.record];
	return `${glyph} ${worker.agent} ${worker.runId} ${word}`;
}

/** A timeline event's offset into the visit, `M:SS`. */
function clock(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Section {
	label: string;
	/** Each entry is one logical line of facts; a later entry starts a row of its own. */
	lines: ReadonlyArray<ReadonlyArray<string>>;
	/** What a cut counts: `… 5 more events`. */
	noun?: string;
	/** Said after the cut count: `resume to inspect`. */
	tail?: string;
	/** The most physical rows the section may take whatever the budget left. */
	maxRows?: number;
	role?: SemanticRole;
}

/** A physical row before painting: the label cells, then the value. */
interface Row {
	label: string;
	value: string;
}

/**
 * The closing line for a visit with no conversation: a launch that sent nothing,
 * or one that only ran a fleet plan. There is no session a resume line could
 * name, so it says that rather than leaving the exit silent.
 */
export function renderExitWithoutConversation(preference: ExitSummaryStyle, tty: boolean): string[] {
	if (preference === "off") return [];
	const line = `CLIO Coder ${GLYPH.sep} no conversation this visit, so there is nothing to resume.`;
	return [tty ? clioTheme().fg("annotation", line) : line];
}

/**
 * The exit summary (5.2): an open island of a titled light rule, a label column of facts and the resume command last.
 * `outputStyle` sizes it and `height` caps it in physical rows (`exitRows`), claimed in order: the title, the resume
 * command, the autonomy and failed-check disclosures, then routine facts in tier order. A section that does not fit
 * shortens to its first rows and says how much it left out. Without a TTY the rows are plain, unwrapped and carry no
 * rule. Pure formatting: no ledger readers, filesystem work, or provider calls on exit.
 */
export function renderExitSummary(
	snapshot: ExitSummarySnapshot | null,
	preference: ExitSummaryStyle,
	width: number,
	tty: boolean,
	outputStyle: OutputStyle = "standard",
	height = 48,
): string[] {
	if (snapshot === null) return [];
	const id = sanitizeCallTargetText(snapshot.sessionId);
	const resumeCommand = `clio-coder --resume ${id}`;
	if (preference === "off") return [`To resume: ${resumeCommand}`];
	const tier = outputStyle;
	const theme = tty ? clioTheme() : null;
	const cells = Math.max(1, Math.floor(width));
	const narrow = tty && widthClass(cells) !== "W3" && widthClass(cells) !== "W4" && widthClass(cells) !== "W5";
	// Labels stack above their values under 44 cells (W1).
	const stacked = tty && widthClass(cells) === "W1";
	const room = tty ? Math.max(1, cells - INDENT.length) : Number.POSITIVE_INFINITY;
	const cap = tierPolicy(tier).exitRows(Math.max(1, Math.floor(height)));

	const spend = snapshot.spend;
	const models = modelList(snapshot);
	const sessions = snapshot.visitSessions ?? 1;
	const otherTools = snapshot.otherSessionToolCalls ?? 0;
	const autonomy = autonomyFacts(snapshot, tier);
	const checks = checkFacts(snapshot);
	const clean = (facts: ReadonlyArray<string>): string[] => facts.map((fact) => sanitizeCallTargetText(fact));

	const disclosures: Section[] = [
		...(autonomy ? [{ label: "autonomy", lines: [clean(autonomy)], role: "body" as const }] : []),
		...(checks
			? [
					{ label: "checks", lines: [clean(checks.facts)], role: checks.failed ? ("error" as const) : ("warning" as const) },
				]
			: []),
	];
	const routine: Section[] = [];
	if (tier === "compact") {
		const model = models.at(-1);
		routine.push({
			label: "",
			lines: [
				clean([
					spend.kind === "ready"
						? `${shortFigures(factsOf(spend.tokens)[0] ?? "")} tokens`
						: `tokens ${SPEND_NOT_AVAILABLE}`,
					spend.kind === "ready" ? (sessionCostFacts(spend, tier)[0] ?? spend.cost) : `cost ${SPEND_NOT_AVAILABLE}`,
					...(model ? [routeLabel(model.target, model.model)] : []),
					...(spend.kind !== "ready"
						? []
						: spend.verified.kind === "none"
							? ["no judged outcome"]
							: [countLabel(spend.verified.count, "verified outcome")]),
				]),
			],
		});
	} else {
		const hooks = gitHooksSummary(snapshot);
		const git = internalGitSummary(snapshot);
		// A hook runs outside the sandbox on the next git command, so these follow the disclosures.
		if (hooks) disclosures.push({ label: "hooks", lines: [clean(hooks)], role: "warning" });
		if (git) disclosures.push({ label: "git", lines: [clean(git)], role: "warning" });
		// A turn is one operator prompt; a model call is one request sent, workers' included as /usage counts them.
		// A visit that switched sessions keeps its counts across them, but the call count is the named session's.
		const unrecorded = snapshot.unrecordedWorkerFiles;
		routine.push({
			label: "work",
			lines: [
				clean([
					`${countLabel(snapshot.turns, "turn")}${snapshot.sessionTurns !== undefined && sessions > 1 ? ` (${count(snapshot.sessionTurns)} in this session)` : ""}`,
					...(spend.kind === "ready"
						? [`${countLabel(spend.visitCalls, "model call")}${sessions > 1 ? " in this session" : ""}`]
						: []),
					countLabel(snapshot.workers.length, "worker"),
					`${countLabel(snapshot.files.length, "file")} changed${unrecorded > 0 ? ` (${countLabel(unrecorded, "worker")} kept no write record)` : ""}`,
					...(sessions > 1 ? [countLabel(sessions, "session")] : []),
					...(snapshot.compactions > 0 ? [countLabel(snapshot.compactions, "compaction")] : []),
				]),
			],
		});
		routine.push({
			label: "time",
			lines: [
				clean([
					formatElapsed(snapshot.wallMs),
					...(spend.kind !== "ready"
						? [`model time ${SPEND_NOT_AVAILABLE}`]
						: spend.callTime !== null
							? [`${spend.callTime} in model calls`]
							: []),
					...(spend.kind === "ready" && spend.callTimeCoverage !== null ? [spend.callTimeCoverage] : []),
				]),
			],
		});
		routine.push({
			label: "tokens",
			lines: [
				clean(
					spend.kind === "ready"
						? factsOf(spend.breakdown)
								// Standard states the figures; detailed adds the notes on what no call reported (2.9).
								.filter((fact) => tier === "detailed" || TOKEN_FIGURE.test(fact))
								.map(shortFigures)
						: [SPEND_NOT_AVAILABLE],
				),
			],
		});
		routine.push({ label: "cost", lines: [clean(sessionCostFacts(spend, tier))] });
		routine.push({ label: "verified", lines: [clean(verifiedFacts(spend, tier))] });
		if (tier === "detailed" && spend.kind === "ready" && spend.cache !== null) {
			routine.push({
				label: "cache",
				lines: [
					clean([
						`${spend.cache.share} of prompt tokens read from cache`,
						...(spend.cache.lastTurn !== null ? [`last turn ${spend.cache.lastTurn}`] : []),
						...(spend.cache.replay !== null ? [spend.cache.replay] : []),
					]),
				],
			});
		}
		if (models.length > 0) {
			routine.push(
				tier === "detailed"
					? {
							label: models.length > 1 ? "models" : "model",
							lines: models.map(({ target, model, spend: recorded }) =>
								clean([routeLabel(target, model), recorded ? countLabel(recorded.calls, "call") : "no call record names it"]),
							),
							noun: "models",
						}
					: {
							label: models.length > 1 ? "models" : "model",
							lines: [
								clean([
									...models.slice(0, 3).map((model) => routeLabel(model.target, model.model)),
									...(models.length > 3 ? [`+${count(models.length - 3)} more`] : []),
								]),
							],
						},
			);
		}
		if (tier === "detailed" && spend.kind === "ready" && spend.byRole.length > 0)
			routine.push({ label: "calls", lines: [clean(factsOf(spend.byRole))] });
		// Tools are the named session's own; a visit that switched sessions says what the others ran instead of
		// dropping the row when this session ran none (TUI-6). Kinds sort by count, then name.
		if (snapshot.tools.length > 0 || otherTools > 0) {
			const kinds = [...snapshot.tools]
				.filter((tool) => tool.count > 0)
				.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
				.map(({ tool, count: n }) => `${tool} ${count(n)}`);
			const failures = snapshot.tools.reduce((sum, tool) => sum + tool.failures, 0);
			const extras = [
				...(kinds.length === 0 ? ["none in this session"] : []),
				...(otherTools > 0 ? [`${countLabel(otherTools, "call")} in other sessions this visit`] : []),
				...(tier === "detailed" && failures > 0 ? [`${count(failures)} failed`] : []),
			];
			routine.push({ label: "tools", lines: [clean([...kinds, ...extras])], noun: "kinds", maxRows: stacked ? 2 : 1 });
		}
		if (snapshot.workers.length > 0)
			routine.push(
				tier === "detailed"
					? { label: "workers", lines: [clean(snapshot.workers.map(workerFact))], noun: "workers" }
					: { label: "workers", lines: [clean(outcomes(snapshot))] },
			);
		if (tier === "detailed" && snapshot.timeline.length > 0)
			routine.push({
				label: "timeline",
				lines: [clean(snapshot.timeline.map((event) => `${clock(event.elapsedMs)} ${event.text}`))],
				noun: "events",
				tail: "resume to inspect",
			});
	}

	const resumeSection: Section = { label: "resume", lines: [[resumeCommand]], role: "commandHint" };
	const all = [...disclosures, ...routine, resumeSection];
	const column = all.reduce((widest, section) => Math.max(widest, section.label.length), 0) + 2;
	const pad = (label: string): string => (label.length === 0 ? "" : label.padEnd(column));
	const hang = " ".repeat(column);

	/** A section's rows showing `shown` of its units, then the count of the rest when `mark` asks for it. */
	const layout = (section: Section, shown: number, mark: boolean): Row[] => {
		const multi = section.lines.length > 1;
		const units = multi ? section.lines.length : (section.lines[0]?.length ?? 0);
		const hidden = units - shown;
		const more =
			hidden > 0 && mark
				? [
						`${GLYPH.ellipsis} ${count(hidden)} more${section.noun ? ` ${section.noun}` : ""}${section.tail ? `${FACT_SEPARATOR}${section.tail}` : ""}`,
					]
				: [];
		const lines = multi
			? [...section.lines.slice(0, shown), ...(more.length > 0 ? [more] : [])]
			: [[...(section.lines[0] ?? []).slice(0, shown), ...more]];
		if (stacked) {
			const values = lines.flat().flatMap((fact) => wrapTextWithAnsi(fact, room));
			return section.label.length === 0
				? values.map((value) => ({ label: "", value }))
				: [{ label: section.label, value: "" }, ...values.map((value) => ({ label: "", value }))];
		}
		const rows: Row[] = [];
		lines.forEach((facts, index) => {
			const lead = index === 0 ? pad(section.label) : hang;
			const indent = section.label.length === 0 ? "" : hang;
			factRows(lead, facts, room, indent).forEach((row, at) => {
				const labelCells = index === 0 && at === 0 ? lead.length : 0;
				rows.push({ label: row.slice(0, labelCells), value: row.slice(labelCells) });
			});
		});
		return rows;
	};

	/**
	 * The most of a section that fits `budget` rows. Compact drops whole facts silently, so each row stays one row (a
	 * label and its value under 44 cells); the other tiers say how much they cut. A compact disclosure whose first fact
	 * alone is too wide keeps its first rows, the last closed with an ellipsis. Null when not even the cut count fits.
	 */
	const fit = (section: Section, budget: number): Row[] | null => {
		const perSection = tier === "compact" ? (stacked ? 2 : 1) : budget;
		const limit = Math.min(budget, perSection, section.maxRows ?? budget);
		if (limit <= 0) return null;
		const units = section.lines.length > 1 ? section.lines.length : (section.lines[0]?.length ?? 0);
		const mark = tier !== "compact";
		for (let shown = units; shown >= (mark ? 0 : 1); shown -= 1) {
			const rows = layout(section, shown, mark);
			if (rows.length <= limit) return rows;
		}
		if (mark) return null;
		const rows = layout(section, 1, false).slice(0, limit);
		const last = rows.at(-1);
		if (last === undefined) return null;
		const valueRoom = Math.max(1, room - visibleWidth(last.label) - 2);
		rows[rows.length - 1] = {
			label: last.label,
			value: `${truncateToWidth(last.value, valueRoom, "", false)} ${GLYPH.ellipsis}`,
		};
		return rows;
	};

	// The command and its id are one thing to copy, so under 72 cells it takes a row of its own, never broken inside.
	const resumeRows: Row[] =
		narrow || stacked
			? [{ label: "resume", value: "" }, ...wrapTextWithAnsi(resumeCommand, room).map((value) => ({ label: "", value }))]
			: [{ label: pad("resume"), value: resumeCommand }];

	let left = cap - 1 - resumeRows.length;
	const body: Array<{ section: Section; rows: Row[] }> = [];
	for (const section of [...disclosures, ...routine]) {
		const rows = fit(section, left);
		if (rows === null) continue;
		body.push({ section, rows });
		left -= rows.length;
	}
	body.push({ section: resumeSection, rows: resumeRows });

	const sessionText = `${narrow ? "" : "session "}${snapshot.sessionName ? `${sanitizeCallTargetText(snapshot.sessionName)} ${GLYPH.sep} ` : ""}${id}`;
	const meta = tier === "compact" ? formatElapsed(snapshot.wallMs) : "this visit";
	const paint = (row: Row, role: SemanticRole): string => {
		const text = `${row.label}${row.value}`;
		if (!theme) return `${INDENT}${text}`.trimEnd();
		return `${INDENT}${theme.fg("annotation", row.label)}${theme.fg(role, row.value)}`;
	};
	const lines = body.flatMap(({ section, rows }) => rows.map((row) => paint(row, section.role ?? "body")));
	if (!theme) return [`CLIO Coder ${GLYPH.sep} ${sessionText} ${GLYPH.sep} ${meta}`, ...lines];
	return [titleRule(theme, cells, sessionText, meta), ...lines];
}

/**
 * `>C_ CLIO Coder · session <id> ───── this visit ─`: the meta goes before the title is shortened, and a title wider
 * than the row closes with an ellipsis.
 */
function titleRule(theme: ClioTheme, cells: number, sessionText: string, meta: string): string {
	const head = `${GLYPH.brand} CLIO Coder ${GLYPH.sep} `;
	const metaCells = visibleWidth(meta) + 4;
	const withMeta = visibleWidth(head) + visibleWidth(sessionText) + 3 + metaCells <= cells;
	const textRoom = Math.max(1, cells - visibleWidth(head) - 3 - (withMeta ? metaCells : 0));
	const text = truncateToWidth(sessionText, textRoom, GLYPH.ellipsis, false);
	const title = `${brandMark(theme)} ${theme.style("wordmark", "CLIO Coder", { bold: true })} ${theme.fg("annotation", GLYPH.sep)} ${theme.style("heading", text, { bold: true })}`;
	return rule(theme, cells, {
		left: title,
		leftRaw: true,
		...(withMeta ? { right: meta, rightTail: theme.fg("divider", GLYPH.rule) } : {}),
	});
}
