import type { ActionClass } from "../domains/safety/action-classifier.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
	safetyNetRailText,
} from "../domains/safety/decision-presentation.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../domains/safety/session-code-consent.js";
import { type Component, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
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
 * Milliseconds before an unanswered card denies itself (#421), read once per
 * frame; null once the operator is present or no window applies.
 */
export type PermissionCountdownReader = () => number | null;

/** Whether the composer holds a draft, read once per frame: Enter is inert while it does (#186). */
export type PermissionDraftReader = () => boolean;

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
export function permissionRiskTone(actionClass: ActionClass, exposure?: ApprovalRequestView["exposure"]): Tone {
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
	return view.axis.kind === "net"
		? safetyNetRailText(view.axis.ruleId, view.gateBuild)
		: `autonomy level ${view.axis.level}`;
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
	if (grant === undefined) return null;
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
			gateBuild: view.gateBuild,
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
	const candidates = [`${who} needs approval · ${presentation.kind}${count}`, `${who} needs approval${count}`];
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
): string {
	const entries = permissionHintEntries(composerHasDraft, inspection, terms, scrollable);
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
): Parameters<typeof choiceRows>[1] {
	const actionClass = view.actionClass;
	const stop = presentation.requiredActions.find((action) => action.id === "stop");
	const stopWords = stop?.consequence.includes("main-agent turn") ? "ends the main-agent turn" : "ends the turn";
	const draftNote = hasDraft ? ` · inert until Backspace clears your draft` : "";
	if (presentation.tier === "worker") {
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `runs it and holds for identical calls in this worker run${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it and holds for identical calls in this worker run" },
			{ key: PERMISSION_STOP_KEY, verb: "stop", consequence: stopWords, tone: "error" },
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
	countdownMs: number | null,
): string[] {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const identity = identityRow(theme, view, presentation, width);
	const lines = [...identity.rows];
	if (view.target !== undefined && view.target.length > 0) {
		lines.push(...targetBlock(theme, view.target, risk, width));
	}
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
	}
	const authority = workerGrantAuthority(view);
	if (authority !== null) facts.push({ label: "authority", value: authority });
	// Dimmed and below the facts, because it is the only line on this card
	// that no part of the harness acted on. The sentence says so itself; the
	// styling keeps it from reading as a verdict at a glance.
	if (advisory.length > 0) facts.push({ label: "advisory", value: advisory, tone: "muted" });
	lines.push(...factRows(theme, facts, width));
	// Last among the facts so it never scrolls away: the operator who walks
	// past the screen reads what happens if they keep walking.
	if (countdownMs !== null) {
		lines.push(
			...wrapTextWithAnsi(
				theme.fg(
					"warning",
					`${GLYPH.warn} No answer in ${formatUnattendedRemaining(countdownMs)} denies this call and Clio continues without it. Any key holds the card.`,
				),
				width,
			),
		);
	}
	return lines;
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
	countdownMs: number | null = null,
	hasDraft = false,
	rowBudget = 0,
): { facts: string[]; rest: string[]; termsAt: number | null; choicesAt: number; choicesRows: number } {
	const theme = clioTheme();
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	const facts = permissionFacts(theme, view, presentation, content, advisory, countdownMs);
	const rest: string[] = [];
	if (view.artifact !== undefined) {
		rest.push(
			sectionRule(theme, content, "Resolved dispatch plan"),
			...view.artifact.text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, content)),
		);
	}
	const choices = permissionChoices(view, presentation, hasDraft);
	const full = choiceRows(theme, choices, content);
	// A short dock (a draft under the card, a 24-row terminal) may not hold the
	// facts and three choice rows together, and the choices are what the keys
	// mean. They then fold to one wrapped row rather than scroll away.
	const fits = rowBudget <= 0 || facts.length + rest.length + full.length <= rowBudget;
	const choicesAt = rest.length;
	rest.push(...(fits ? full : compactChoiceRows(theme, choices, content)));
	const choicesRows = rest.length - choicesAt;
	if (!terms) return { facts, rest, termsAt: null, choicesAt, choicesRows };
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
	return { facts, rest, termsAt, choicesAt, choicesRows };
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
		...(pane.position === null ? [] : [positionRow(theme, { ...pane.position, unit: "lines" }, content)]),
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
			countdownMs === null ? "" : Math.ceil(countdownMs / 1000),
			hasDraft,
			skinEpoch(),
		].join("|");
		if (this.memo?.key === key) return this.memo.lines;
		this.choicesShown = false;
		const lines = this.renderFresh(width, advisory, countdownMs, hasDraft);
		this.memo = { key, lines };
		return lines;
	}

	private renderFresh(width: number, advisory: string, countdownMs: number | null, hasDraft: boolean): string[] {
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
				...(identity.ruleFact === null ? [] : factRows(theme, [identity.ruleFact], content)),
				sectionRule(theme, content, "Exact invocation", { meta: `${MUTATION_PREVIEW_KEY} closes` }),
			];
			this.lastVisibleRows = inspectionWindowRows(this.bodyRows, head.length);
			const pane = windowRows(rows, this.scroll, this.lastVisibleRows);
			this.scroll = pane.start;
			return [...head, ...pane.window, ...(pane.position === null ? [] : [positionRow(theme, pane.position, content)])];
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
	 * in, the choices are pinned under a window over everything else instead:
	 * the keys and their consequences are the answer, and are never the rows
	 * the frame cuts. With no known budget the card renders whole.
	 */
	private windowCard(sections: ReturnType<typeof permissionCardSections>, width: number): string[] {
		const { facts, rest, termsAt, choicesAt, choicesRows } = sections;
		const whole = [...facts, ...rest];
		const budget = this.bodyRows;
		if (budget <= 0 || whole.length <= budget) {
			this.cardMaxScroll = 0;
			this.cardScroll = 0;
			this.jumpToTerms = false;
			this.choicesShown = true;
			return whole;
		}
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
			// The rail names the scroll and terms keys; the row carries the place alone.
			return [
				...facts,
				...rest.slice(this.cardScroll, end),
				positionRow(clioTheme(), { start: this.cardScroll + 1, end, total: rest.length }, width),
			];
		}
		const choices = rest.slice(choicesAt, choicesAt + choicesRows);
		const scrolled = [...facts, ...rest.slice(0, choicesAt), ...rest.slice(choicesAt + choicesRows)];
		const height = Math.max(0, budget - choices.length - 1);
		if (height === 0) {
			this.cardMaxScroll = 0;
			this.cardScroll = 0;
			this.jumpToTerms = false;
			this.choicesShown = choices.length <= budget;
			return choices.slice(0, budget);
		}
		this.cardMaxScroll = Math.max(0, scrolled.length - height);
		if (this.jumpToTerms) {
			this.jumpToTerms = false;
			if (termsAt !== null) this.cardScroll = facts.length + termsAt - choicesRows;
		}
		this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
		const end = this.cardScroll + height;
		this.choicesShown = true;
		return [
			...scrolled.slice(this.cardScroll, end),
			positionRow(clioTheme(), { start: this.cardScroll + 1, end, total: scrolled.length }, width),
			...choices,
		];
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

	private readCountdown(): number | null {
		if (this.countdown === undefined) return null;
		try {
			return this.countdown();
		} catch {
			return null;
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
): PermissionOverlayBodyHandle {
	return new PermissionOverlayBody(view, inspect, invocation, advisory, countdown, draft);
}
