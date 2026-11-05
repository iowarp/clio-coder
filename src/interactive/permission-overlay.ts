import type { ActionClass } from "../domains/safety/action-classifier.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
	safetyNetRailText,
} from "../domains/safety/decision-presentation.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../domains/safety/session-code-consent.js";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import {
	MUTATION_PREVIEW_VISIBLE_ROWS,
	type MutationInspector,
	type MutationPreview,
	mutationFactsLine,
} from "./mutation-preview.js";
import { fitHintEntries, fitRow, type RowBudgetedBody, windowRows } from "./overlay-frame.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	type PermissionInspectionHint,
	type PermissionTermsHint,
	permissionHintEntries,
} from "./permission-hint.js";
import { renderToolArguments } from "./renderers/tool-execution.js";
import type { Choice, ClioTheme, ClioToken, Fact, HarnessFunction, Tone } from "./theme/index.js";
import {
	chip,
	chipRow,
	chipRows,
	choiceRows,
	clioTheme,
	commandBlock,
	factRows,
	functionText,
	GLYPH,
	keyCap,
	positionRow,
	releaseSpaces,
	sectionRule,
	toneRole,
	toolFunction,
} from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import { formatUnattendedRemaining } from "./unattended-countdown.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";
export type { ApprovalRequestView } from "../session-control/approval-request-view.js";
export {
	MUTATION_PREVIEW_KEY,
	PERMISSION_TERMS_KEY,
	type PermissionInspectionHint,
	type PermissionTermsHint,
	permissionHintEntries,
} from "./permission-hint.js";

const PERMISSION_OVERLAY_CONTENT_WIDTH = 78;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

/**
 * A late-arriving advisory line for the card, read once per frame.
 *
 * It is a getter rather than a field on the view because the dialog opens the
 * instant the call parks and the advisory is answered over the network after
 * that. Nothing waits for it: the card renders without the line, and the line
 * appears at the next frame if an answer ever arrives.
 */
export type PermissionAdvisoryReader = () => string;

/**
 * Milliseconds before an unanswered card denies itself (#421), `held` once the
 * operator is present, null when no window applies.
 */
export type PermissionCountdown = number | "held" | null;

/**
 * A worker ask whose window the dispatching process runs, so a key can hold it.
 * A bare number on a worker card is a window inside the worker, which no key
 * reaches. A held window still ends, at its ceiling, so it keeps its time left.
 */
export interface WorkerWindowCountdown {
	remainingMs: number;
	held: boolean;
}

/** What a card's timer row is drawn from. */
type CardCountdown = PermissionCountdown | WorkerWindowCountdown;

function isWorkerWindow(countdown: CardCountdown): countdown is WorkerWindowCountdown {
	return typeof countdown === "object" && countdown !== null;
}

/** A held window turns back into a warning this close to its ceiling. */
const HELD_WINDOW_WARNING_MS = 60_000;
export type PermissionCountdownReader = () => PermissionCountdown;
export type WorkerWindowReader = () => WorkerWindowCountdown | null;

/** Whether the composer holds a draft, read once per frame: Enter is inert while it does (#186). */
export type PermissionDraftReader = () => boolean;

/** Whether a main-agent turn is running, read once per frame: a worker card's stop ends one only if it is. */
export type PermissionMainTurnReader = () => boolean;

export interface PermissionOverlayBodyHandle extends Component, RowBudgetedBody {
	/** Whether this card has a mutation the operator can read locally. */
	canInspect(): boolean;
	isInspecting(): boolean;
	toggleInspect(): void;
	scrollInspect(delta: number): void;
	/** The standing approval terms, folded behind the terms key (see `permissionCardSections`). */
	isShowingTerms(): boolean;
	toggleTerms(): void;
	/**
	 * Whether the rows that name allow, deny and stop with their consequences
	 * are on screen, so the rail can carry only the keys they do not.
	 */
	isShowingChoices(): boolean;
	/** Whether the card, inspection closed, is taller than its rows and windows itself. */
	isCardScrollable(): boolean;
	/** Move that window; false when the card fits and the key is not the card's. */
	scrollCard(delta: number): boolean;
}

/**
 * The risk a call carries, as the tone its action chip and its command gutter
 * take. Red is reserved for what the classifier cannot bound or undo; amber
 * for execution and dispatch, whose effects may already have run; orange for a
 * workspace write, which can be reviewed and reverted; cyan for a read. An
 * outward exposure never reads below amber, whatever the class.
 */
function permissionRiskTone(actionClass: ActionClass, exposure?: ApprovalRequestView["exposure"]): Tone {
	const base: Tone =
		actionClass === "read"
			? "info"
			: actionClass === "write"
				? "action"
				: actionClass === "execute" || actionClass === "dispatch"
					? "warning"
					: "error";
	if (exposure === "outward" && (base === "info" || base === "action")) return "warning";
	return base;
}

const FUNCTION_GLYPH: Readonly<Record<HarnessFunction, string>> = {
	builtin: GLYPH.toolHeader,
	shell: GLYPH.classExecute,
	mutation: GLYPH.classMutate,
	network: GLYPH.classNetwork,
	dispatch: GLYPH.workerAgent,
	shadowDispatch: GLYPH.workerAgent,
	skill: GLYPH.classKnowledge,
	mcp: GLYPH.classExternal,
	extension: GLYPH.classExternal,
	context: GLYPH.classKnowledge,
	decision: GLYPH.classInteraction,
	artifact: GLYPH.classExternal,
};

/** The tool as the transcript draws it: its function glyph and its function color. */
function toolChip(theme: ClioTheme, tool: string): string {
	const kind = toolFunction(tool);
	return functionText(theme, kind, `${FUNCTION_GLYPH[kind]} ${tool}`);
}

/** The axis that asked, in the words the parked row and the notice use. */
function axisText(view: ApprovalRequestView): string {
	return view.axis.kind === "net" ? safetyNetRailText(view.axis.ruleId) : `autonomy level ${view.axis.level}`;
}

/**
 * The first row: the tool, the action class in its risk tone, and the rule
 * that fired. Everything an operator needs to place the ask before reading
 * the command. When the three do not fit the row, the rule moves to its own
 * fact row below rather than being clipped, and the tool and class wrap, so
 * nothing that explains the ask is ever cut.
 */
function identityRow(
	theme: ClioTheme,
	view: ApprovalRequestView,
	presentation: DecisionPresentation,
	width: number,
): { rows: string[]; ruleFact: Fact | null } {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const axisTone: Tone = presentation.semanticToken === "warning" ? "warning" : "muted";
	const kind = toolFunction(view.tool);
	const classWords = view.actionClass.replaceAll("_", " ");
	// `write · write action` said the word twice. When the tool and its class
	// share the word, the tool chip alone carries it, in the risk tone, behind
	// the function glyph the transcript uses for that tool.
	const shared = view.actionClass === view.tool;
	const tool = shared
		? `${functionText(theme, kind, FUNCTION_GLYPH[kind])} ${theme.style(toneRole(risk), view.tool, { bold: true })}`
		: toolChip(theme, view.tool);
	const action = shared ? null : theme.style(toneRole(risk), `${classWords} action`, { bold: true });
	const axis = chip(theme, axisText(view), axisTone);
	const full = chipRow(theme, [tool, action, axis], Number.POSITIVE_INFINITY);
	if (visibleWidth(full) <= width) return { rows: [full], ruleFact: null };
	// Tool and class wrap rather than clip when even they do not fit: in the
	// open inspection view nothing else names the class.
	return {
		rows: chipRows(theme, [tool, action], width),
		ruleFact: { label: "rule", value: axisText(view), tone: axisTone },
	};
}

/**
 * The target in a gutter: the command or path in the strongest reading
 * color, folded at spaces and then at separators, never clipped, because the
 * last token of a path is the one that says what is touched.
 */
function targetBlock(theme: ClioTheme, target: string, risk: Tone, width: number): string[] {
	return commandBlock(theme, target, width, { tone: risk });
}

/** The card line for a worker ask routed through the main agent, or null for every other card. */
function workerGrantAuthority(view: ApprovalRequestView): string | null {
	const grant = view.workerGrant;
	if (grant === undefined) {
		return view.origin.kind === "worker"
			? "yours alone. fleet.permissions.mode escalate asks you, not the main agent."
			: null;
	}
	if (grant.authority === "operator") {
		return "operator only. This rail is not the main agent's to grant; your answer decides it.";
	}
	return grant.forwardedByMain
		? "the main agent approved this worker request and, below yolo, asks you to decide."
		: "the main agent may decide this ordinary worker request.";
}

function permissionDecisionPresentation(view: ApprovalRequestView): DecisionPresentation {
	return classifyDecisionPresentation(
		decisionFactsForPermission({
			tool: view.tool,
			actionClass: view.actionClass,
			axis:
				view.axis.kind === "net"
					? { kind: "safety-net", ruleId: view.axis.ruleId }
					: { kind: "autonomy", level: view.axis.level },
			origin: view.origin,
			...(view.exposure !== undefined ? { exposure: view.exposure } : {}),
		}),
	);
}

/**
 * The rail title for one decision: who needs approval, what kind, and its place
 * in the queue. The kind goes first when the rail is narrow, then the model's
 * name, so the count and the words "needs approval" survive at 60 columns.
 */
export function permissionRailTitle(
	view: ApprovalRequestView,
	context: { actor: string; room: number; queueDepth?: number },
): string {
	const presentation = permissionDecisionPresentation(view);
	const who =
		view.origin.kind === "worker" ? `Worker ${view.origin.agentId}` : context.actor.length > 0 ? context.actor : "Clio";
	const depth = context.queueDepth ?? view.queueDepth ?? 0;
	const count = depth > 1 ? ` · 1 of ${depth}` : "";
	// `Worker coder needs approval · worker call` says worker twice and nothing about the call.
	const candidates = [
		...(view.origin.kind === "worker" ? [] : [`${who} needs approval · ${presentation.kind}${count}`]),
		`${who} needs approval${count}`,
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= context.room) ?? `Needs approval${count}`;
}

export function permissionOverlayTone(_view: ApprovalRequestView): ClioToken {
	return "decisionCue";
}

/**
 * The footer for a box `innerWidth` columns wide inside its borders. The
 * three columns the bottom border spends on `─ ` and the trailing space come
 * off the top, which is what `buildResponsiveHint` does for every other frame.
 */
export function permissionOverlayHint(
	innerWidth: number,
	composerHasDraft = false,
	inspection: PermissionInspectionHint = "none",
	terms: PermissionTermsHint = "closed",
	scrollable = false,
	choicesShown = false,
	stopVerb?: string,
): string {
	const entries = permissionHintEntries(composerHasDraft, inspection, terms, scrollable, stopVerb);
	// While the card's own rows name allow, deny and stop with what they do,
	// the rail carries only the keys those rows do not: terms, inspect, scroll,
	// and the Backspace that clears a draft. The moment the rows leave the
	// screen (open terms scrolled past them, the mutation open) every answer
	// key is back on the rail.
	const shown = choicesShown
		? entries.filter((entry) => entry.key !== "Enter" && entry.key !== "Esc" && entry.key !== PERMISSION_STOP_KEY)
		: entries;
	return fitHintEntries(shown.length > 0 ? shown : entries, innerWidth - 3);
}

/** The tools whose parked call mutates a file, so a card without a preview owes the operator a reason. */
function isFileMutationTool(tool: string): boolean {
	return tool === "write" || tool === "edit";
}

function actionConsequence(presentation: DecisionPresentation, id: "deny" | "stop"): string {
	return presentation.requiredActions.find((action) => action.id === id)?.consequence ?? "";
}

/**
 * What each key does, in one clause each, for the folded card. These are the
 * facts `termsSummary` used to join into one sentence: allow runs this one
 * call (or, for a worker, holds for identical calls in its run; for the test
 * runner consent, covers later runners this session), deny skips it, stop ends
 * the turn. The full terms behind the terms key say the same at length.
 */
function permissionChoices(
	view: ApprovalRequestView,
	presentation: DecisionPresentation,
	hasDraft: boolean,
	mainTurn?: boolean,
): Parameters<typeof choiceRows>[1] {
	const actionClass = view.actionClass;
	const stopWords = "ends the turn";
	const draftNote = hasDraft ? ` · inert until Backspace clears your draft` : "";
	if (presentation.tier === "worker") {
		// An approval is never remembered, only a denial (`deniedEscalations` in the
		// worker runtime, F8). The stop key does not reach the worker's process
		// unless the turn it ends is the one waiting on this worker.
		const endsWithTurn = mainTurn !== false && view.origin.kind === "worker" && view.origin.endsWithTurn === true;
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `runs this one call; an identical call asks again${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; an identical call in this run is refused without asking" },
			{
				key: PERMISSION_STOP_KEY,
				verb: "stop",
				// A worker asks while the main agent is often idle, and a key cannot end a turn that is not running.
				consequence: endsWithTurn
					? "denies it and ends the main turn, which also stops this worker"
					: mainTurn === undefined
						? "denies it and ends any main turn; this worker keeps running"
						: mainTurn
							? "denies it and ends the main turn; this worker keeps running"
							: "denies it; no main turn is running, and this worker keeps running",
				tone: "error",
			},
		];
	}
	if (view.axis.kind === "net" && view.axis.ruleId === SESSION_CODE_CONSENT_RULE_ID) {
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `runs this ${actionClass} call and later test runners this session${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; the next test runner asks again" },
			{ key: PERMISSION_STOP_KEY, verb: "stop", consequence: stopWords, tone: "error" },
		];
	}
	return [
		{ key: "Enter", verb: "allow", consequence: `runs this one ${actionClass} call${draftNote}` },
		{ key: "Esc", verb: "deny", consequence: "skips it" },
		{ key: PERMISSION_STOP_KEY, verb: "stop", consequence: stopWords, tone: "error" },
	];
}

/**
 * The choices on as few rows as they take: `[Enter] allow: runs this one
 * call · [Esc] deny: skips it · [alt+x] stop: ends the turn`, wrapped between
 * choices where it can be, never between a key and its verb.
 */
function compactChoiceRows(theme: ClioTheme, choices: ReadonlyArray<Choice>, width: number): string[] {
	const held = (text: string): string => text.replaceAll(" ", "\u00a0");
	const parts = choices.map(
		(choice) =>
			`${held(`${keyCap(theme, choice.key)} ${theme.style(toneRole(choice.tone ?? "neutral"), choice.verb, { bold: true })}`)}${theme.fg("decisionConsequence", `: ${choice.consequence}`)}`,
	);
	return wrapTextWithAnsi(parts.join(theme.fg("divider", " · ")), width).map(releaseSpaces);
}

/**
 * The same choices as keys and verbs alone, for a card whose effect would
 * otherwise lose rows to them. Their consequences stay in the scrolled window,
 * and Enter still says what it waits for while a draft holds it.
 */
function bareChoiceRows(theme: ClioTheme, choices: ReadonlyArray<Choice>, width: number, hasDraft: boolean): string[] {
	const bare = choices.map((choice, index) => ({
		...choice,
		verb: index === 0 && hasDraft ? `${choice.verb} after Backspace` : choice.verb,
	}));
	const held = (text: string): string => text.replaceAll(" ", "\u00a0");
	const parts = bare.map((choice) =>
		held(`${keyCap(theme, choice.key)} ${theme.style(toneRole(choice.tone ?? "neutral"), choice.verb, { bold: true })}`),
	);
	return wrapTextWithAnsi(parts.join(theme.fg("divider", " · ")), width).map(releaseSpaces);
}

/** A target row whose next row is out of view, marked so it cannot be read as the end of the command. */
function markContinued(row: string, width: number): string {
	return visibleWidth(row) + 2 <= width
		? `${row} ${GLYPH.ellipsis}`
		: truncateToWidth(row, width, GLYPH.ellipsis, false);
}

/** The countdown as one clause for the row that also says where the window is, on a card too short for its sentence. */
function compactCountdownClause(
	view: ApprovalRequestView,
	countdown: CardCountdown,
): { outcome: string; holds: string; tone: ClioToken } | null {
	if (countdown === null) return null;
	if (countdown === "held") return { outcome: `${GLYPH.phaseBlocked} timer held`, holds: "", tone: "annotation" };
	if (isWorkerWindow(countdown)) {
		const left = formatUnattendedRemaining(countdown.remainingMs);
		const ending = view.workerFallback === "fail" ? "fails the run" : "denies";
		if (!countdown.held) return { outcome: `${GLYPH.warn} ${left} ${ending}`, holds: "key holds", tone: "warning" };
		return {
			outcome: `${GLYPH.phaseBlocked} held, ${left} ${ending}`,
			holds: "",
			tone: countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation",
		};
	}
	const remaining = formatUnattendedRemaining(countdown);
	if (view.origin.kind !== "worker") {
		return { outcome: `${GLYPH.warn} ${remaining} denies`, holds: "key holds", tone: "warning" };
	}
	const outcome = view.workerFallback === "fail" ? "fails the run" : "denies";
	return { outcome: `${GLYPH.warn} ${remaining} ${outcome}`, holds: "", tone: "warning" };
}

/**
 * Hard wrap for mutation text. Prose wraps on words; a proposed file line and a
 * diff row do not, because the column a character sits in is part of what the
 * operator is reading. The continuation marker says the row was folded rather
 * than cut, which is the difference between a wrap and unmarked truncation.
 */
function wrapMutationLine(value: string, max: number): string[] {
	if (max <= 1) return [value];
	if (value.length <= max) return [value];
	const lines: string[] = [];
	let remaining = value;
	while (remaining.length > max) {
		lines.push(`${remaining.slice(0, max - 1)}↩`);
		remaining = remaining.slice(max - 1);
	}
	lines.push(remaining);
	return lines;
}

/** A diff row in its sign's tone, so an edit's additions and removals read apart. */
function paintMutationRow(theme: ClioTheme, row: string, diff: boolean): string {
	if (!diff) return row;
	if (row.startsWith("+")) return theme.fg("success", row);
	if (row.startsWith("-")) return theme.fg("error", row);
	if (row.startsWith("@@")) return theme.fg("annotation", row);
	return row;
}

function wrapArtifactLine(value: string, max: number): string[] {
	if (value.length <= max) return [value];
	const lines: string[] = [];
	let remaining = value;
	while (remaining.length > max) {
		const candidate = remaining.slice(0, max + 1);
		const whitespace = candidate.lastIndexOf(" ");
		const cut = whitespace >= Math.floor(max / 2) ? whitespace : max;
		lines.push(remaining.slice(0, cut));
		remaining = `    ${remaining.slice(cut).trimStart()}`;
	}
	lines.push(remaining);
	return lines;
}

/**
 * A label keeps its value's row at every width: a window edge between a label
 * and the value under it left a lone `rule` on the 40-column card.
 */
const CARD_FACT_ROWS = { stack: "never" } as const;

interface PermissionFactRows {
	/** Identity, target, the fact table and the timer, in reading order. */
	lines: string[];
	target: string[];
	effect: string[];
	/** Every fact row but the effect's. */
	others: string[];
	/** The timer sentence as a short card's window carries it; a held timer's position row says all of it. */
	windowTimer: string[];
}

/**
 * The facts that identify the call, in reading order: the identity row, the
 * exact target in a gutter, then the labelled table. The target is the one
 * thing never clipped, because a deep path's file name is what says what the
 * write touches.
 */
function permissionFacts(
	theme: ClioTheme,
	view: ApprovalRequestView,
	presentation: DecisionPresentation,
	width: number,
	advisory: string,
	countdown: CardCountdown,
	hasDraft: boolean,
): PermissionFactRows {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const identity = identityRow(theme, view, presentation, width);
	const target = view.target !== undefined && view.target.length > 0 ? targetBlock(theme, view.target, risk, width) : [];
	const facts: Fact[] = identity.ruleFact === null ? [] : [identity.ruleFact];
	if (view.netReason !== undefined && view.netReason.length > 0) facts.push({ label: "why", value: view.netReason });
	if (view.consequence !== undefined && view.consequence.length > 0) {
		facts.push({ label: "effect", value: view.consequence.join("\n") });
	}
	// Size and digest stay on the folded card whether or not the operator
	// opens the mutation, so the decision always carries the identity of the
	// bytes it applies to. Wrapped, never ellipsized: at 40 columns the digest
	// is the tail of the line, and ellipsizing it would drop the one fact that
	// ties the decision to the bytes it applies to.
	if (view.mutation !== undefined) {
		facts.push({
			label: "mutation",
			value: `${mutationFactsLine(view.mutation)} · ${MUTATION_PREVIEW_KEY} reads it before you decide`,
		});
	} else if (view.origin.kind === "worker" && isFileMutationTool(view.tool)) {
		facts.push({
			label: "mutation",
			value:
				"no local preview: this call's arguments stay inside the worker, so you are approving the target above without inspecting the change.",
			tone: "warning",
		});
	}
	// The rail title already names the model asking; the row earns its place
	// only for a worker, whose id and run the operator cannot read anywhere else.
	if (view.origin.kind === "worker") {
		facts.push({ label: "asked by", value: `worker ${view.origin.agentId} (run ${view.origin.runId})`, tone: "muted" });
		// A worker card has no inspect key: its arguments stay in the worker, so a
		// cut command is one the operator cannot finish reading anywhere.
		if (view.tool === "bash" && view.target?.endsWith("…") === true) {
			facts.push({
				label: "cut",
				value: "this card shows the start of the call; the rest stays inside the worker and cannot be read here.",
				tone: "warning",
			});
		}
	}
	const authority = workerGrantAuthority(view);
	if (authority !== null) facts.push({ label: "authority", value: authority });
	// Dimmed and below the facts, because it is the only line on this card
	// that no part of the harness acted on. The sentence says so itself; the
	// styling keeps it from reading as a verdict at a glance.
	if (advisory.length > 0) facts.push({ label: "advisory", value: advisory, tone: "muted" });
	// Last among the facts so it never scrolls away: the operator who walks
	// past the screen reads what happens if they keep walking.
	const timer: string[] = [];
	const answer = hasDraft ? "Backspace clears your draft, then Enter allows" : "Enter allows";
	const after =
		view.workerFallback === "fail"
			? "denies this call and fails the worker run"
			: "denies this call; the worker carries on without it";
	if (countdown === "held") {
		timer.push(
			...wrapTextWithAnsi(theme.fg("annotation", `${GLYPH.phaseBlocked} timer held · ${answer}, Esc denies`), width),
		);
	} else if (isWorkerWindow(countdown)) {
		const left = formatUnattendedRemaining(countdown.remainingMs);
		const sentence = countdown.held
			? `${GLYPH.phaseBlocked} Timer held. No answer in ${left} ${after}. ${answer}, Esc denies.`
			: `${GLYPH.warn} No answer in ${left} ${after}. Any key holds the card.`;
		const tone = !countdown.held || countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation";
		timer.push(...wrapTextWithAnsi(theme.fg(tone, sentence), width));
	} else if (countdown !== null && view.origin.kind === "worker") {
		// The window runs inside the worker's process, so no key here can hold it.
		timer.push(
			...wrapTextWithAnsi(
				theme.fg(
					"warning",
					`${GLYPH.warn} No answer in ${formatUnattendedRemaining(countdown)} ${after}. No key pauses this.`,
				),
				width,
			),
		);
	} else if (countdown !== null) {
		timer.push(
			...wrapTextWithAnsi(
				theme.fg(
					"warning",
					`${GLYPH.warn} No answer in ${formatUnattendedRemaining(countdown)} denies this call and Clio continues without it. Any key holds the card.`,
				),
				width,
			),
		);
	}
	// The same table split around the effect, one label column across both, for
	// a short card that leads its window with what the call does.
	const widest = facts.reduce((max, fact) => Math.max(max, visibleWidth(fact.label)), 0);
	const aligned = facts.map((fact) => ({ ...fact, label: fact.label.padEnd(widest) }));
	return {
		lines: [...identity.rows, ...target, ...factRows(theme, facts, width, CARD_FACT_ROWS), ...timer],
		target,
		effect: factRows(
			theme,
			aligned.filter((fact) => fact.label.trimEnd() === "effect"),
			width,
			CARD_FACT_ROWS,
		),
		others: factRows(
			theme,
			aligned.filter((fact) => fact.label.trimEnd() !== "effect"),
			width,
			CARD_FACT_ROWS,
		),
		windowTimer: countdown === "held" ? [] : timer,
	};
}

/**
 * The overlay's body, laid out for the width the frame gives it.
 *
 * Every line used to be sized for a 78-column box and the frame hard-cut the
 * rest, so a 40-column terminal saw the safety sentences end mid-word and an
 * 80-column one saw the command being authorized end mid-argument, both with
 * nothing marking the cut.
 *
 * The card leads with what changes per call: the tool and its class in the
 * risk tone, the rule that fired, the target in full, the mutation facts, and
 * who asked. Then the three keys, each with its consequence, so what allow,
 * deny and stop do is read without opening anything. The standing terms of
 * the decision (approval, consequence, reversibility, hard blocks) are the
 * same on every card, so they fold behind the terms key.
 */
function permissionCardSections(
	view: ApprovalRequestView,
	width: number,
	terms = false,
	advisory = "",
	countdown: CardCountdown = null,
	hasDraft = false,
	rowBudget = 0,
	mainTurn?: boolean,
): {
	facts: string[];
	/** Leading fact rows that name the call; a short card pins them beside the answer keys. */
	identityRows: number;
	/** The same facts split for a short card's window. */
	parts: PermissionFactRows;
	/** The choices without their consequences, when a short card's effect needs the rows. */
	bareChoices: string[];
	/** The timer as one clause for the position row of a short card. */
	timerClause: ReturnType<typeof compactCountdownClause>;
	rest: string[];
	termsAt: number | null;
	choicesAt: number;
	choicesRows: number;
} {
	const theme = clioTheme();
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	const parts = permissionFacts(theme, view, presentation, content, advisory, countdown, hasDraft);
	const facts = parts.lines;
	const identityRows = identityRow(theme, view, presentation, content).rows.length;
	const timerClause = compactCountdownClause(view, countdown);
	const rest: string[] = [];
	if (view.artifact !== undefined) {
		rest.push(
			sectionRule(theme, content, "Resolved dispatch plan"),
			...view.artifact.text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, content)),
		);
	}
	const choices = permissionChoices(view, presentation, hasDraft, mainTurn);
	const bareChoices = bareChoiceRows(theme, choices, content, hasDraft);
	const full = choiceRows(theme, choices, content);
	// A short dock (a draft under the card, a 24-row terminal) may not hold the
	// facts and three choice rows together, and the choices are what the keys
	// mean. They then fold to one wrapped row rather than scroll away.
	const fits = rowBudget <= 0 || facts.length + rest.length + full.length <= rowBudget;
	const choicesAt = rest.length;
	rest.push(...(fits ? full : compactChoiceRows(theme, choices, content)));
	const choicesRows = rest.length - choicesAt;
	const shared = { facts, identityRows, parts, bareChoices, timerClause };
	if (!terms) return { ...shared, rest, termsAt: null, choicesAt, choicesRows };
	const wrapTerm = (text: string): string[] => wrapTextWithAnsi(theme.fg("decisionExplanation", text), content);
	const termsAt = rest.length;
	rest.push(
		sectionRule(theme, content, "Terms"),
		...wrapTerm(`Approval: ${presentation.authorizationCopy}`),
		...wrapTerm(`Consequence: ${presentation.consequenceCopy}`),
		...wrapTerm(presentation.reversibilityCopy),
		...wrapTerm(`Deny: ${actionConsequence(presentation, "deny")}`),
		...wrapTerm(`Stop: ${actionConsequence(presentation, "stop")}`),
		...wrapTerm("Hard-blocked actions remain blocked."),
	);
	return { ...shared, rest, termsAt, choicesAt, choicesRows };
}

/**
 * The card with the mutation open. The identity, target and digest stay at the
 * top so the bytes on screen remain tied to the call they belong to, and the
 * choices give way to the mutation itself: the operator opened this to read
 * what changes, and the keys that answer the ask are on the rail throughout.
 * The window takes the rows the frame has, so the frame never has to cut it.
 */
function permissionInspectionLines(
	view: ApprovalRequestView,
	preview: MutationPreview,
	width: number,
	scroll: number,
	bodyRows: number,
): { lines: string[]; wrappedLineCount: number; visibleRows: number } {
	const theme = clioTheme();
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const diff = preview.heading.startsWith("Effective diff") || preview.heading.startsWith("Requested replacements");
	const wrapped = preview.body
		.flatMap((line) => wrapMutationLine(line, content))
		.map((row) => paintMutationRow(theme, row, diff));
	const notes: string[] = [];
	if (preview.neutralized) notes.push("control characters shown as ·");
	if (preview.tabsExpanded) notes.push("tabs shown as spaces");
	const identity = identityRow(theme, view, presentation, content);
	const head = [
		...identity.rows,
		...(view.target !== undefined && view.target.length > 0 ? targetBlock(theme, view.target, risk, content) : []),
		...factRows(
			theme,
			[
				...(identity.ruleFact === null ? [] : [identity.ruleFact]),
				...(view.netReason !== undefined && view.netReason.length > 0
					? [{ label: "why", value: view.netReason } satisfies Fact]
					: []),
				{ label: "mutation", value: mutationFactsLine(preview.facts) },
			],
			content,
			CARD_FACT_ROWS,
		),
		sectionRule(theme, content, previewLabel(preview.heading), { meta: `${MUTATION_PREVIEW_KEY} closes` }),
		...previewReason(theme, preview.heading, content),
	];
	const tail =
		notes.length > 0 ? [fitRow(theme.fg("annotation", `Rendered safely: ${notes.join(", ")}.`), content)] : [];
	const visibleRows = inspectionWindowRows(bodyRows, head.length + tail.length);
	const pane = windowRows(wrapped, scroll, visibleRows);
	const lines = [
		...head,
		...pane.window,
		...(pane.position === null
			? []
			: [positionRow(theme, { ...pane.position, unit: "lines", keys: ["↑↓ scroll"] }, content)]),
		...tail,
	];
	return { lines, wrappedLineCount: wrapped.length, visibleRows };
}

/**
 * The preview's own name for what it shows, without the path the target block
 * above already carries: `Proposed content`, `Effective diff`, `Requested
 * replacements`, or the whole heading when it names no file.
 */
function previewLabel(heading: string): string {
	const at = heading.indexOf(" for ");
	return at === -1 ? heading : heading.slice(0, at);
}

/** A heading's parenthesised reason (`the file could not be read: …`), on its own wrapped rows. */
function previewReason(theme: ClioTheme, heading: string, width: number): string[] {
	const open = heading.indexOf(" (");
	if (open === -1 || !heading.endsWith(")")) return [];
	return wrapTextWithAnsi(theme.fg("warning", heading.slice(open + 2, -1)), width);
}

/**
 * Rows an inspection window may use: the frame's budget less the rows around
 * it and the position row, never under four, and the fixed preview height
 * when the budget is not known yet.
 */
function inspectionWindowRows(bodyRows: number, surroundingRows: number): number {
	if (bodyRows <= 0) return MUTATION_PREVIEW_VISIBLE_ROWS;
	return Math.max(4, bodyRows - surroundingRows - 1);
}

/**
 * The overlay body, plus the inspection state the key router drives. The
 * preview is built on the first toggle rather than per frame, so the file read
 * and the diff happen once when the operator asks for them. The rows are
 * memoized on everything that shapes them, so a card that waits on the
 * operator costs the frame one key comparison per render.
 */
class PermissionOverlayBody implements PermissionOverlayBodyHandle {
	private preview: MutationPreview | null = null;
	private scroll = 0;
	private lastLineCount = 0;
	private lastVisibleRows = MUTATION_PREVIEW_VISIBLE_ROWS;
	private terms = false;
	private argumentsOpen = false;
	private bodyRows = 0;
	private cardScroll = 0;
	private cardMaxScroll = 0;
	private jumpToTerms = false;
	private choicesShown = false;
	private memo: { key: string; lines: string[] } | null = null;

	constructor(
		private readonly view: ApprovalRequestView,
		private readonly inspect?: MutationInspector,
		private readonly invocation?: () => unknown,
		private readonly advisory?: PermissionAdvisoryReader,
		private readonly countdown?: PermissionCountdownReader,
		private readonly draft?: PermissionDraftReader,
		private readonly mainTurn?: PermissionMainTurnReader,
		private readonly workerWindow?: WorkerWindowReader,
	) {}

	canInspect(): boolean {
		return this.inspect !== undefined || this.invocation !== undefined;
	}

	isInspecting(): boolean {
		return this.preview !== null || this.argumentsOpen;
	}

	toggleInspect(): void {
		if (this.inspect === undefined) {
			if (this.invocation !== undefined) this.argumentsOpen = !this.argumentsOpen;
			this.scroll = 0;
			return;
		}
		if (this.preview !== null) {
			this.preview = null;
			this.scroll = 0;
			return;
		}
		this.preview = this.inspect();
		this.scroll = 0;
	}

	scrollInspect(delta: number): void {
		if (!this.isInspecting()) return;
		const maxScroll = Math.max(0, this.lastLineCount - this.lastVisibleRows);
		this.scroll = Math.max(0, Math.min(this.scroll + delta, maxScroll));
	}

	isShowingTerms(): boolean {
		return this.terms;
	}

	toggleTerms(): void {
		this.terms = !this.terms;
		this.cardScroll = 0;
		// Opening the terms brings them into view: on a short dock the choices
		// above them would otherwise fill the window and the key would seem inert.
		this.jumpToTerms = this.terms;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	isShowingChoices(): boolean {
		return this.choicesShown;
	}

	isCardScrollable(): boolean {
		return !this.isInspecting() && this.cardMaxScroll > 0;
	}

	scrollCard(delta: number): boolean {
		if (!this.isCardScrollable()) return false;
		this.cardScroll = Math.max(0, Math.min(this.cardScroll + delta, this.cardMaxScroll));
		return true;
	}

	render(width: number): string[] {
		const advisory = this.readAdvisory();
		const countdownMs = this.readCountdown();
		const hasDraft = this.readDraft();
		const mainTurn = this.readMainTurn();
		// The countdown is keyed by the second it displays, so a card with a
		// window redraws once a second and a card without one never redraws
		// for it.
		const key = [
			width,
			this.bodyRows,
			this.terms,
			this.argumentsOpen,
			this.preview === null ? 0 : 1,
			this.scroll,
			this.cardScroll,
			advisory,
			typeof countdownMs === "number"
				? Math.ceil(countdownMs / 1000)
				: isWorkerWindow(countdownMs)
					? `${Math.ceil(countdownMs.remainingMs / 1000)}:${countdownMs.held}`
					: (countdownMs ?? ""),
			hasDraft,
			mainTurn,
			skinEpoch(),
		].join("|");
		if (this.memo?.key === key) return this.memo.lines;
		this.choicesShown = false;
		const lines = this.renderFresh(width, advisory, countdownMs, hasDraft, mainTurn);
		this.memo = { key, lines };
		return lines;
	}

	private renderFresh(
		width: number,
		advisory: string,
		countdownMs: CardCountdown,
		hasDraft: boolean,
		mainTurn: boolean | undefined,
	): string[] {
		if (this.argumentsOpen && this.invocation) {
			const theme = clioTheme();
			const content = Math.max(8, Math.floor(width));
			const rows = renderToolArguments(
				this.invocation(),
				content,
				false,
				Number.POSITIVE_INFINITY,
				false,
				this.view.tool === "bash" ? "shell" : undefined,
			);
			this.lastLineCount = rows.length;
			const identity = identityRow(theme, this.view, permissionDecisionPresentation(this.view), content);
			const head = [
				...identity.rows,
				...(identity.ruleFact === null ? [] : factRows(theme, [identity.ruleFact], content, CARD_FACT_ROWS)),
				sectionRule(theme, content, "Exact invocation", { meta: `${MUTATION_PREVIEW_KEY} closes` }),
			];
			this.lastVisibleRows = inspectionWindowRows(this.bodyRows, head.length);
			const pane = windowRows(rows, this.scroll, this.lastVisibleRows);
			this.scroll = pane.start;
			return [
				...head,
				...pane.window,
				...(pane.position === null ? [] : [positionRow(theme, { ...pane.position, keys: ["↑↓ scroll"] }, content)]),
			];
		}
		if (this.preview === null) {
			const sections = permissionCardSections(
				this.view,
				width,
				this.terms,
				advisory,
				countdownMs,
				hasDraft,
				this.bodyRows,
				mainTurn,
			);
			return this.windowCard(sections, width);
		}
		const rendered = permissionInspectionLines(this.view, this.preview, width, this.scroll, this.bodyRows);
		this.lastLineCount = rendered.wrappedLineCount;
		this.lastVisibleRows = rendered.visibleRows;
		return rendered.lines;
	}

	/**
	 * The card in the rows the frame has. The facts that identify the call stay
	 * put and the choices and terms below them scroll, because the frame's own
	 * cut hid the end of the Stop consequence at 60x40 with nothing that reached
	 * it (BT-005). When the facts alone leave no window the choices could fit
	 * in, the identity and the choices are pinned around a window over
	 * everything else instead: an answer key is never live while the call it
	 * answers is off screen, and the keys are never the rows the frame cuts. The
	 * target's first row joins the identity when the window keeps a row without
	 * it, and the window opens on the effect, because what the call does outranks
	 * every other fact on a card this short. With no known budget the card
	 * renders whole.
	 */
	private windowCard(sections: ReturnType<typeof permissionCardSections>, width: number): string[] {
		const { facts, identityRows, parts, bareChoices, timerClause, rest, termsAt, choicesAt, choicesRows } = sections;
		const whole = [...facts, ...rest];
		const budget = this.bodyRows;
		if (budget <= 0 || whole.length <= budget) {
			this.cardMaxScroll = 0;
			this.cardScroll = 0;
			this.jumpToTerms = false;
			this.choicesShown = true;
			return whole;
		}
		// The rail drops its reading keys first at 60 columns, which is where a card
		// overflows (BT-005), so the row that shows the cut names the way past it.
		const position = (start: number, end: number, total: number): string =>
			positionRow(
				clioTheme(),
				{ start, end, total, keys: ["↑↓ scroll", ...(this.terms ? [`${PERMISSION_TERMS_KEY} back`] : [])] },
				width,
			);
		const room = budget - facts.length - 1;
		if (room >= choicesRows) {
			this.cardMaxScroll = rest.length - room;
			// Opening the terms brings the window to the choices, so the terms
			// begin beneath keys that stay on screen and every row below is
			// reached by scrolling down (BT-005).
			if (this.jumpToTerms) {
				this.jumpToTerms = false;
				if (termsAt !== null) this.cardScroll = choicesAt;
			}
			this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
			const end = this.cardScroll + room;
			this.choicesShown = choicesAt >= this.cardScroll && choicesAt + choicesRows <= end;
			return [...facts, ...rest.slice(this.cardScroll, end), position(this.cardScroll + 1, end, rest.length)];
		}
		const fullChoices = rest.slice(choicesAt, choicesAt + choicesRows);
		const answerRows = identityRows + fullChoices.length;
		// Too short to hold the choices as well, even as bare keys beside what the
		// call is and does: they join the window and every answer key is on the
		// rail, so the identity holds and every row stays reachable.
		const callRows = identityRows + Math.min(parts.target.length, 1) + parts.effect.length;
		if (budget < answerRows + 2 && budget < callRows + bareChoices.length + 1) {
			const all = [...parts.target, ...parts.effect, ...parts.others, ...parts.windowTimer, ...rest];
			const positioned = budget >= identityRows + 2;
			const window = Math.max(0, budget - identityRows - (positioned ? 1 : 0));
			this.cardMaxScroll = window > 0 ? Math.max(0, all.length - window) : 0;
			if (this.jumpToTerms) {
				this.jumpToTerms = false;
				if (termsAt !== null) this.cardScroll = all.length - rest.length + termsAt;
			}
			this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
			const end = this.cardScroll + window;
			const choicesFrom = all.length - rest.length + choicesAt;
			this.choicesShown = choicesFrom >= this.cardScroll && choicesFrom + choicesRows <= end;
			return [
				...facts.slice(0, Math.min(identityRows, budget)),
				...all.slice(this.cardScroll, end),
				...(positioned
					? [
							timerClause === null
								? position(this.cardScroll + 1, end, all.length)
								: this.timedPosition(timerClause, this.cardScroll + 1, end, all.length, width),
						]
					: []),
			];
		}
		const hasTarget = parts.target.length > 0;
		const hasEffect = parts.effect.length > 0;
		// Rows the target may have once the identity, the choices, the position row
		// and the whole effect are placed. An effect that leaves it none takes the
		// rows the consequences spend, and they move into the window instead.
		const targetRoom = (choiceRows: number): number =>
			budget - identityRows - choiceRows - 1 - parts.effect.length - (hasEffect ? 0 : 1);
		const bare = targetRoom(fullChoices.length) < (hasTarget ? 1 : 0) && bareChoices.length < fullChoices.length;
		const choices = bare ? bareChoices : fullChoices;
		const targetPinned =
			!hasTarget || budget < identityRows + choices.length + 3
				? 0
				: Math.max(1, Math.min(parts.target.length, targetRoom(choices.length)));
		// A cut target must not read as the whole command, and it stays one block rather than folding around the effect.
		const targetRows = parts.target.slice(0, targetPinned);
		const lastTarget = targetRows.at(-1);
		if (lastTarget !== undefined && targetPinned < parts.target.length) {
			targetRows[targetPinned - 1] = markContinued(lastTarget, width);
		}
		const allFacts = [
			...(targetPinned === 0 ? parts.target : []),
			...parts.effect,
			...(targetPinned === 0 ? [] : parts.target.slice(targetPinned)),
			...parts.others,
			...parts.windowTimer,
		];
		const scrolled = [
			...allFacts,
			...(bare ? rest : [...rest.slice(0, choicesAt), ...rest.slice(choicesAt + choicesRows)]),
		];
		const pinned = [...facts.slice(0, identityRows), ...targetRows];
		const height = budget - pinned.length - choices.length - 1;
		this.cardMaxScroll = Math.max(0, scrolled.length - height);
		if (this.jumpToTerms) {
			this.jumpToTerms = false;
			if (termsAt !== null) this.cardScroll = allFacts.length + termsAt - (bare ? 0 : choicesRows);
		}
		this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
		const end = this.cardScroll + height;
		this.choicesShown = true;
		return [
			...pinned,
			...scrolled.slice(this.cardScroll, end),
			timerClause === null
				? position(this.cardScroll + 1, end, scrolled.length)
				: this.timedPosition(timerClause, this.cardScroll + 1, end, scrolled.length, width),
			...choices,
		];
	}

	/**
	 * The position row on a short card with a live timer. It carries the time and
	 * what running out does, because the sentence that says so at length has moved
	 * into the window and the card denies itself whether or not anyone scrolls.
	 */
	private timedPosition(
		clause: NonNullable<ReturnType<typeof compactCountdownClause>>,
		start: number,
		end: number,
		total: number,
		width: number,
	): string {
		const theme = clioTheme();
		const holds = clause.holds.length > 0 ? ` · ${clause.holds}` : "";
		const terms = this.terms ? ` · ${PERMISSION_TERMS_KEY} back` : "";
		const candidates = [
			`${clause.outcome}${holds} · ${start}–${end} of ${total} rows · ↑↓ scroll${terms}`,
			// The rail names the arrows at every width this form is needed.
			`${clause.outcome}${holds} · ${start}–${end}/${total}`,
			`${clause.outcome} · ${start}–${end}/${total}`,
		];
		const text = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? candidates.at(-1) ?? "";
		const timer = text.startsWith(`${clause.outcome}${holds}`) ? `${clause.outcome}${holds}` : clause.outcome;
		return fitRow(`${theme.fg(clause.tone, timer)}${theme.fg("annotation", text.slice(timer.length))}`, width);
	}

	/**
	 * A throwing or absent advisory reader is simply no advisory. This runs on
	 * every frame of a dialog the operator is answering, so it cannot be a place
	 * where anything fails loudly.
	 */
	private readAdvisory(): string {
		if (this.advisory === undefined) return "";
		try {
			return this.advisory();
		} catch {
			return "";
		}
	}

	private readCountdown(): CardCountdown {
		try {
			return this.workerWindow?.() ?? this.countdown?.() ?? null;
		} catch {
			return null;
		}
	}

	private readMainTurn(): boolean | undefined {
		if (this.mainTurn === undefined) return undefined;
		try {
			return this.mainTurn();
		} catch {
			return undefined;
		}
	}

	private readDraft(): boolean {
		if (this.draft === undefined) return false;
		try {
			return this.draft();
		} catch {
			return false;
		}
	}

	invalidate(): void {
		this.memo = null;
	}
}

/**
 * The overlay body for one parked call. The inspector, when present, is the
 * only path the mutation text takes: it is never placed on `view`, so nothing
 * that renders or forwards the view can carry the bytes with it.
 */
export function createPermissionOverlayBody(
	view: ApprovalRequestView,
	inspect?: MutationInspector,
	invocation?: () => unknown,
	advisory?: PermissionAdvisoryReader,
	countdown?: PermissionCountdownReader,
	draft?: PermissionDraftReader,
	mainTurn?: PermissionMainTurnReader,
	workerWindow?: WorkerWindowReader,
): PermissionOverlayBodyHandle {
	return new PermissionOverlayBody(view, inspect, invocation, advisory, countdown, draft, mainTurn, workerWindow);
}
