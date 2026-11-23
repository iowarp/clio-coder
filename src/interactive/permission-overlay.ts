import { formatCountdown } from "../core/format-time.js";
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { type ActionClass, actionClassWords } from "../domains/safety/action-classifier.js";
import { credentialedCallKind } from "../domains/safety/call-consequence.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
	safetyNetRailText,
} from "../domains/safety/decision-presentation.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "../domains/safety/session-code-consent.js";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import { CARD_CALLOUT_MAX_WIDTH, CARD_GUTTER } from "./card.js";
import {
	type PlanSummary,
	planHeadline,
	planLimits,
	planRoute,
	planScope,
	readDispatchPlan,
} from "./dispatch-plan-summary.js";
import {
	MUTATION_PREVIEW_VISIBLE_ROWS,
	type MutationInspector,
	type MutationPreview,
	mutationFactsLine,
	targetWithoutPayloadSize,
} from "./mutation-preview.js";
import { fitHintEntries, fitRow, type RowBudgetedBody, windowRows } from "./overlay-frame.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_SESSION_SCOPE_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	type PermissionChoicesHint,
	type PermissionInspectionHint,
	type PermissionTermsHint,
	permissionHintEntries,
	permissionKeyLabel,
} from "./permission-hint.js";
import { renderToolArguments } from "./renderers/tool-execution.js";
import type { Choice, ClioTheme, ClioToken, Fact, HarnessFunction, Tone } from "./theme/index.js";
import {
	chip,
	chipRow,
	chipRows,
	choiceConsequence,
	choiceLead,
	choiceRows,
	clioTheme,
	commandBlock,
	factRows,
	functionText,
	GLYPH,
	keyCap,
	padAnsi,
	positionRow,
	releaseSpaces,
	rule,
	sectionRule,
	toneRole,
	toolFunction,
} from "./theme/index.js";
import { keyName } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";

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

/** A boxed frame for the card: the card's own columns plus the frame's borders and padding. */
export const PERMISSION_OVERLAY_WIDTH = CARD_CALLOUT_MAX_WIDTH + 4;

/** The composer's gutter left of a docked card (`DOCK_GUTTER`), which the callout width counts. */
const DOCK_INDENT = 2;

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

/** Whether the card opened too recently for Enter to answer it, read once per frame. */
export type PermissionSettlingReader = () => boolean;

export interface PermissionOverlayBodyHandle extends Component, RowBudgetedBody {
	/** Whether this card has a mutation the operator can read locally. */
	canInspect(): boolean;
	isInspecting(): boolean;
	toggleInspect(): void;
	scrollInspect(delta: number): void;
	/** The standing approval terms, folded behind the terms key (see `permissionTermsRows`). */
	isShowingTerms(): boolean;
	toggleTerms(): void;
	/**
	 * Whether the rows that name allow, deny and stop with their consequences
	 * are on screen, so the rail can carry only the keys they do not.
	 */
	isShowingChoices(): boolean;
	/**
	 * Whether those rows also name the terms and inspect keys, which a narrow
	 * card folds in beside the answers because its rail has no room for them.
	 */
	isShowingReadingKeys(): boolean;
	/** Whether the card view is up and its choice rows are scrolled out of view, so Enter and the session grant do nothing. */
	choicesOutOfView(): boolean;
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
	return view.axis.kind === "net" ? safetyNetRailText(view.axis.ruleId) : `${view.axis.level} autonomy`;
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
	// What the call does, in words (`runs a command`), not its class name (`execute action`).
	const classWords = actionClassWords(view.actionClass);
	// `write · write action` said the word twice. When the tool and its class
	// share the word, the tool chip alone carries it, in the risk tone, behind
	// the function glyph the transcript uses for that tool.
	const shared = view.actionClass === view.tool;
	const tool = shared
		? `${functionText(theme, kind, FUNCTION_GLYPH[kind])} ${theme.style(toneRole(risk), view.tool, { bold: true })}`
		: toolChip(theme, view.tool);
	const action = shared ? null : theme.style(toneRole(risk), classWords, { bold: true });
	const axis = chip(theme, axisText(view), axisTone);
	const full = chipRow(theme, [tool, action, axis], Number.POSITIVE_INFINITY);
	if (visibleWidth(full) <= width) return { rows: [full], ruleFact: null };
	// Tool and class wrap rather than clip when even they do not fit: in the
	// open inspection view nothing else names the class.
	return {
		rows: chipRows(theme, [tool, action], width),
		ruleFact: { label: "asked under", value: axisText(view), tone: axisTone },
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
			? "yours alone. Worker approvals are set to Ask me, so the main agent cannot answer this for you."
			: null;
	}
	if (grant.authority === "operator") {
		return "operator only. This rail is not the main agent's to grant; your answer decides it.";
	}
	if (grant.fromJudge === true) return "yours alone. Git hooks changed, so the safety judge does not decide this call.";
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
			...(view.sandboxed === true ? { sandboxed: true as const } : {}),
		}),
	);
}

/**
 * The clock each card last drew, for the top rule: one deadline record drives the rule, the pinned timer row and the
 * position clause, so the rule never says a time the card does not. Keyed by the view the lifecycle hands both.
 */
const railClocks = new WeakMap<ApprovalRequestView, string | null>();

function railClock(countdown: CardCountdown): string | null {
	if (countdown === null) return null;
	if (countdown === "held") return "held";
	return formatCountdown(isWorkerWindow(countdown) ? countdown.remainingMs : countdown);
}

/**
 * The top rule's unit for one decision: `needs approval · 3:32 · <actor>`, with the kind of call and the queue
 * position while they fit. Narrower, the actor goes, then the words, so the clock is the last thing standing.
 */
export function permissionRailTitle(
	view: ApprovalRequestView,
	context: { actor: string; room: number; queueDepth?: number },
): string {
	const presentation = permissionDecisionPresentation(view);
	const who =
		view.origin.kind === "worker"
			? `worker ${view.origin.agentId}`
			: context.actor.length > 0
				? context.actor
				: "CLIO Coder";
	const depth = context.queueDepth ?? view.queueDepth ?? 0;
	const count = depth > 1 ? ` ${GLYPH.dot} 1 of ${depth}` : "";
	const clock = railClocks.get(view) ?? null;
	const lead = clock === null ? "needs approval" : `needs approval ${GLYPH.dot} ${clock}`;
	// A worker's identity row already names the worker call; the kind is for the main agent's asks.
	const kind = view.origin.kind === "worker" ? null : (credentialedCallKind(view.consequence) ?? presentation.kind);
	const candidates = [
		...(kind === null ? [] : [`${lead} ${GLYPH.dot} ${kind} ${GLYPH.dot} ${who}${count}`]),
		`${lead} ${GLYPH.dot} ${who}${count}`,
		`${lead}${count}`,
		lead,
		...(clock === null ? [] : [clock]),
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= context.room) ?? clock ?? "needs approval";
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
	choicesShown = true,
	stopVerb?: string,
	readingKeysShown = false,
): string {
	// The rail always carries the answer keys. Under the card view it also says where the choices are: on screen,
	// or scrolled out of view, when `[↓] read choices` takes Enter's place because Enter does nothing until they show.
	const layer = inspection === "open" || terms === "open";
	const choices: PermissionChoicesHint | undefined = layer ? undefined : choicesShown ? "on-card" : "below";
	const entries = permissionHintEntries(composerHasDraft, inspection, terms, scrollable, stopVerb, choices);
	// A narrow card names the terms and inspect keys in its own choice rows, so the rail does not repeat them.
	const onCard = new Set<string>(
		choicesShown && readingKeysShown && !layer
			? [permissionKeyLabel(PERMISSION_TERMS_KEY), permissionKeyLabel(MUTATION_PREVIEW_KEY)]
			: [],
	);
	return fitHintEntries(
		entries.filter((entry) => !onCard.has(entry.key)),
		innerWidth - 3,
	);
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
	const stopWords = "ends the turn";
	const draftNote = hasDraft ? ` · clear your draft with Backspace first` : "";
	// Approving answers the ask and leaves the sandbox as it is: a write outside its roots fails all the same.
	const runs =
		view.sandboxed === true ? "runs this one call in the sandbox; outside writes still fail" : "runs this one call";
	if (presentation.tier === "worker") {
		// An approval is never remembered, only a denial (`deniedEscalations` in the
		// worker runtime, F8). The stop key does not reach the worker's process
		// unless the turn it ends is the one waiting on this worker.
		const endsWithTurn = mainTurn !== false && view.origin.kind === "worker" && view.origin.endsWithTurn === true;
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: `${runs}; an identical call asks again${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; an identical call in this run is refused without asking" },
			{
				key: permissionKeyLabel(PERMISSION_STOP_KEY),
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
				consequence: `runs it, and later test runners this session${draftNote}`,
			},
			{ key: "Esc", verb: "deny", consequence: "skips it; the next test runner asks again" },
			{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
		];
	}
	if (view.artifact?.kind === "settings-change") {
		return [
			{ key: "Enter", verb: "allow", consequence: `saves this change to your settings${draftNote}` },
			{ key: "Esc", verb: "deny", consequence: "skips it; nothing is saved" },
			{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
		];
	}
	if (view.artifact !== undefined) {
		const plan = view.artifact.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
		const count = plan?.members.length ?? 0;
		const workers =
			count === 1
				? "the worker"
				: count === 2
					? "both workers"
					: count > 2
						? `all ${count} workers`
						: "every worker in the plan";
		return [
			{
				key: "Enter",
				verb: "allow",
				consequence: hasDraft ? `starts ${workers} after you clear the draft` : `starts ${workers} now`,
			},
			{ key: "Esc", verb: "deny", consequence: "CLIO Coder continues without this dispatch" },
			{
				key: permissionKeyLabel(PERMISSION_STOP_KEY),
				verb: "stop",
				consequence: "denies this call and ends the turn",
				tone: "error",
			},
		];
	}
	return [
		{ key: "Enter", verb: "allow", consequence: `${runs}${draftNote}` },
		// A sandbox escape's session option names the scope it grants in full (M-7).
		...(view.escapeScope !== undefined
			? [
					{
						key: permissionKeyLabel(PERMISSION_SESSION_SCOPE_KEY),
						verb: "approve for this session",
						consequence: `${view.escapeScope.label.replace(/^Approve for this session:\s*/u, "")}; reruns of these unchanged files run without asking${draftNote}`,
					},
				]
			: []),
		{ key: "Esc", verb: "deny", consequence: "skips it" },
		{ key: permissionKeyLabel(PERMISSION_STOP_KEY), verb: "stop", consequence: stopWords, tone: "error" },
	];
}

/**
 * The choices on as few rows as they take: `[Enter] allow: runs this one
 * call · [Esc] deny: skips it · [alt+x] stop: ends the turn`, wrapped between
 * choices where it can be, never between a key and its verb, and a choice too
 * long for its row hangs its consequence under the verb. Every consequence stays.
 */
function compactChoiceRows(
	theme: ClioTheme,
	choices: ReadonlyArray<Choice>,
	width: number,
	reading: ReadonlyArray<ReadingKey> = [],
): string[] {
	const held = (text: string): string => text.replaceAll(" ", "\u00a0");
	const parts = [
		...choices.map((choice): string | string[] => {
			const lead = choiceLead(theme, choice);
			const head = held(`${lead.cap} ${lead.verb}`);
			const one = `${head}${choiceConsequence(theme, choice, `: ${choice.consequence}`)}`;
			if (visibleWidth(one) <= width) return one;
			// Too long for its row: the consequence starts beside the verb and hangs under it, so the key and verb never
			// stand on a row alone. Under 44 cells (W1) it hangs by 2, a row the reading form cannot spare otherwise.
			const capWidth = visibleWidth(lead.cap) + 1;
			const indent = width < 44 || capWidth > Math.floor(width / 3) ? 2 : capWidth;
			const words = choice.consequence.split(" ");
			const firstRoom = width - visibleWidth(head) - 2;
			let first = "";
			while (words.length > 0 && visibleWidth(`${first} ${words[0]}`.trim()) <= firstRoom) {
				first = `${first} ${words.shift()}`.trim();
			}
			// No whole word fits beside the verb (a path): fold the word after a separator, or after its first cells.
			const opening = words[0];
			if (first.length === 0 && opening !== undefined && firstRoom > 0) {
				const fold = Math.max(...["/", "-", "_", ".", ","].map((sep) => opening.lastIndexOf(sep, firstRoom - 1)));
				const at = fold >= 0 ? fold + 1 : firstRoom;
				first = opening.slice(0, at);
				words[0] = opening.slice(at);
				if (words[0].length === 0) words.shift();
			}
			const rest = words.length === 0 ? [] : wrapTextWithAnsi(words.join(" "), Math.max(1, width - indent));
			return [
				`${head}${choiceConsequence(theme, choice, first.length > 0 ? `: ${first}` : ":")}`,
				...rest.map((row) => `${" ".repeat(indent)}${choiceConsequence(theme, choice, row)}`),
			];
		}),
		...readingParts(theme, reading),
	];
	return joinChoiceUnits(theme, parts, width);
}

/** A key that reads the call rather than answering it. */
interface ReadingKey {
	key: string;
	verb: string;
}

/**
 * The terms key, and the inspect key when the call has something local to
 * read. A rail 40 columns wide holds two short entries, and the answer keys
 * and the scroll arrows outrank these, so a narrow card names them in its own
 * choice rows instead of leaving them on no surface at all.
 */
function readingKeys(inspectable: boolean): ReadingKey[] {
	return [
		{ key: permissionKeyLabel(PERMISSION_TERMS_KEY), verb: "terms" },
		...(inspectable ? [{ key: permissionKeyLabel(MUTATION_PREVIEW_KEY), verb: "inspect" }] : []),
	];
}

function readingParts(theme: ClioTheme, reading: ReadonlyArray<ReadingKey>): string[] {
	return reading.map((entry) =>
		`${keyCap(theme, entry.key)} ${theme.fg("muted", entry.verb)}`.replaceAll(" ", "\u00a0"),
	);
}

/**
 * What the call acts on, in its gutter: the command or path, or for a plan
 * what the plan does. Every view of the card shows it, so no answer key is
 * ever on screen without the thing it answers.
 */
function cardTargetRows(theme: ClioTheme, view: ApprovalRequestView, width: number): string[] {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	// A plan card names the call by what the plan does; its raw arguments (`roster=<string 7 bytes>`) are in the inspector.
	const plan = view.artifact?.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
	const targetText = plan !== null ? planHeadline(plan) : targetWithoutPayloadSize(view.target, view.mutation);
	if (targetText === undefined || targetText.length === 0) return [];
	return plan !== null
		? commandBlock(theme, targetText, width, { tone: risk, prose: true })
		: targetBlock(theme, targetText, risk, width);
}

/**
 * Key entries joined with a divider and broken between entries, never inside
 * a key's name and never on a dangling divider: at 40 columns the wrapped
 * paragraph ended rows on `deny ·` and `terms ·`.
 */
function joinChoiceUnits(
	theme: ClioTheme,
	units: ReadonlyArray<string | ReadonlyArray<string>>,
	width: number,
): string[] {
	const divider = theme.fg("divider", " · ");
	const rows: string[] = [];
	let current = "";
	for (const unit of units) {
		// A choice already laid out on its own rows starts a row and closes on its last.
		if (typeof unit !== "string") {
			if (current.length > 0) rows.push(current);
			rows.push(...unit.slice(0, -1));
			current = unit.at(-1) ?? "";
			continue;
		}
		const joined = current.length === 0 ? unit : `${current}${divider}${unit}`;
		if (visibleWidth(joined) <= width) {
			current = joined;
			continue;
		}
		if (current.length > 0) rows.push(current);
		if (visibleWidth(unit) <= width) {
			current = unit;
			continue;
		}
		const wrapped = wrapTextWithAnsi(unit, width);
		rows.push(...wrapped.slice(0, -1));
		current = wrapped.at(-1) ?? "";
	}
	if (current.length > 0) rows.push(current);
	return rows.map(releaseSpaces);
}

/** A sentence led by a status glyph, its later rows indented under the text rather than under the glyph. */
function hangingWrap(text: string, width: number): string[] {
	const rows = wrapTextWithAnsi(text, width);
	if (rows.length <= 1 || width < 12) return rows;
	return wrapTextWithAnsi(text, width - CARD_GUTTER.length).map((row, index) =>
		index === 0 ? row : `${CARD_GUTTER}${row}`,
	);
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
	if (countdown === "held") return { outcome: `${GLYPH.phaseBlocked} no time limit now`, holds: "", tone: "annotation" };
	if (isWorkerWindow(countdown)) {
		const left = formatCountdown(countdown.remainingMs);
		const ending = view.workerFallback === "fail" ? "fails the run" : "denies";
		if (!countdown.held) return { outcome: `${GLYPH.warn} ${left} ${ending}`, holds: "key holds", tone: "warning" };
		return {
			outcome: `${GLYPH.phaseBlocked} extended · no answer in ${left} ${ending}`,
			holds: "",
			tone: countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation",
		};
	}
	const remaining = formatCountdown(countdown);
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

/** The sealed plan text as rows, each field line wrapped on its own. */
function planTextRows(text: string, width: number): string[] {
	return text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, width));
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

function taskVia(task: NonNullable<ApprovalRequestView["task"]>): string {
	return task.via === undefined ? "" : ` · via ${task.via}`;
}

/** The task row's value: the operator's words are theirs; a dispatch read-root ask names the dispatched task (CLI-P35). */
function taskRowValue(task: NonNullable<ApprovalRequestView["task"]>): string {
	if (task.dispatch !== undefined) {
		const { position, count } = task.dispatch;
		return `dispatch${count > 1 ? ` task ${position} of ${count}` : ""}: "${task.text}"`;
	}
	return `"${task.text}" · you${taskVia(task)}`;
}

/**
 * A label keeps its value's row at every width: a window edge between a label
 * and the value under it left a lone `rule` on the 40-column card.
 */
const CARD_FACT_ROWS = { stack: "never" } as const;

/** The parts of the card view, each a block the layout pins or windows (7.4). */
interface PermissionCardParts {
	/** Actor, tool, class of action, autonomy. */
	identity: string[];
	/** The exact bytes under decision on the `▌` bar, then what the call is classified to do. */
	effect: string[];
	/** What a dispatch grants: its scope row and its limits row. */
	scope: string[];
	/** Everything else, in reading order: the window between the scope and the choices. */
	window: string[];
	/** Every choice with its consequence, one row each, the consequence wrapping under itself. */
	choices: string[];
	/** The same choices joined on as few rows as they take, every consequence kept. */
	compactChoices: string[];
	/** The terms and inspect keys, when the rail has no room for them; they follow the compact choices. */
	readingRows: string[];
	/** The timer sentence: remaining time, what expiry does, and who can hold it. */
	timer: string[];
	/** The timer as one clause for the position row. */
	timerClause: ReturnType<typeof compactCountdownClause>;
	/** Whether the choice rows also carry the terms and inspect keys. */
	readingFolded: boolean;
}

/**
 * The timer row, from the one deadline record the top rule also reads. It says only what is true: a held main call
 * has no limit, a held worker window still ends, and a window inside the worker is one no key reaches.
 */
function timerRows(
	theme: ClioTheme,
	view: ApprovalRequestView,
	countdown: CardCountdown,
	hasDraft: boolean,
	width: number,
): string[] {
	if (countdown === null) return [];
	const answer = hasDraft ? "Backspace clears your draft, then Enter allows" : "Enter allows";
	// The card is the outermost layer, so its Esc is the one that denies.
	const escWords = "Esc denies";
	const after =
		view.workerFallback === "fail"
			? "denies this call and fails the worker run"
			: "denies this call; the worker carries on without it";
	if (countdown === "held") {
		return hangingWrap(theme.fg("annotation", `${GLYPH.phaseBlocked} No time limit now. ${answer}, ${escWords}.`), width);
	}
	if (isWorkerWindow(countdown)) {
		const left = formatCountdown(countdown.remainingMs);
		const sentence = countdown.held
			? `${GLYPH.phaseBlocked} Extended for you. No answer in ${left} ${after}. ${answer}, ${escWords}.`
			: `${GLYPH.warn} No answer in ${left} ${after}. Any key holds the card.`;
		const tone = !countdown.held || countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation";
		return hangingWrap(theme.fg(tone, sentence), width);
	}
	if (view.origin.kind === "worker") {
		// The window runs inside the worker's process, so no key here can hold it.
		return hangingWrap(
			theme.fg("warning", `${GLYPH.warn} No answer in ${formatCountdown(countdown)} ${after}. No key pauses this.`),
			width,
		);
	}
	return hangingWrap(
		theme.fg(
			"warning",
			`${GLYPH.warn} No answer in ${formatCountdown(countdown)} denies this call and CLIO Coder continues without it. Any key holds the card.`,
		),
		width,
	);
}

/** One row per task: index, agent, the route when routes differ, and the task, cut with `…` to the row. */
function planTaskRows(theme: ClioTheme, plan: PlanSummary, routesDiffer: boolean, width: number): string[] {
	const names = plan.members.map((member) => member.label ?? member.agent);
	const routes = plan.members.map(planRoute);
	const indexWidth = String(plan.members.length).length;
	const nameWidth = names.reduce((max, name) => Math.max(max, visibleWidth(name)), 0);
	const routeWidth = routesDiffer ? routes.reduce((max, route) => Math.max(max, visibleWidth(route)), 0) : 0;
	return plan.members.map((member, index) => {
		const task = (member.task ?? plan.sharedTask ?? "").replace(/\s+/gu, " ").trim();
		const lead = `${theme.fg("annotation", String(index + 1).padStart(indexWidth))} ${padAnsi(names[index] ?? "", nameWidth)}`;
		const route = routesDiffer ? `  ${theme.fg("annotation", padAnsi(routes[index] ?? "", routeWidth))}` : "";
		const row = `${lead}${route}${task.length > 0 ? `  ${task}` : ""}`;
		return visibleWidth(row) <= width ? row : truncateToWidth(row, width, GLYPH.ellipsis, false);
	});
}

/** The effect's first `rows` rows; the rest open the window, and the last pinned row says how many follow. */
function pinEffect(
	theme: ClioTheme,
	effect: ReadonlyArray<string>,
	rows: number,
	width: number,
): { pinned: string[]; overflow: string[] } {
	if (effect.length <= rows) return { pinned: [...effect], overflow: [] };
	const keep = Math.max(1, rows);
	const marker = (count: number): string =>
		theme.fg("annotation", `${GLYPH.ellipsis} ${count} more ${count === 1 ? "row" : "rows"}`);
	const last = effect[keep - 1] ?? "";
	const whole = marker(effect.length - keep);
	if (visibleWidth(last) + 1 + visibleWidth(whole) <= width) {
		return { pinned: [...effect.slice(0, keep - 1), `${last} ${whole}`], overflow: effect.slice(keep) };
	}
	// The cut row opens the window whole, so every byte stays reachable.
	const cutMarker = marker(effect.length - keep + 1);
	const cut = truncateToWidth(last, Math.max(1, width - visibleWidth(cutMarker) - 1), "", false);
	return { pinned: [...effect.slice(0, keep - 1), `${cut} ${cutMarker}`], overflow: effect.slice(keep - 1) };
}

/**
 * The card view's blocks for the width the frame gives it. The card leads with what changes per call: the tool and its
 * class in the risk tone, the exact bytes under decision, and for a dispatch the scope it grants. Then each key with its
 * consequence, so what allow, deny and stop do is read without opening anything. The standing terms of the decision
 * are the same on every card, so they fold behind the terms key.
 */
function permissionCardParts(
	view: ApprovalRequestView,
	width: number,
	advisory: string,
	countdown: CardCountdown,
	hasDraft: boolean,
	mainTurn: boolean | undefined,
	inspectable: boolean,
	settling: boolean,
): PermissionCardParts {
	const theme = clioTheme();
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	const policy = tierPolicy();
	const identity = identityRow(theme, view, presentation, content);
	const plan = view.artifact?.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
	const effectFacts: Fact[] = [];
	if (view.consequence !== undefined && view.consequence.length > 0) {
		effectFacts.push({ label: "effect", value: view.consequence.join("\n") });
	} else if ((view.tool === "bash" || view.tool === "run_script") && view.artifact === undefined) {
		// Silence here would read as "no notable effect" on exactly the commands Clio cannot read.
		effectFacts.push({
			label: "effect",
			value: "not classified: CLIO Coder has no reading of what this command changes",
			tone: "warning",
		});
	}
	// What the approval grants, from every task: never from the first alone.
	const scope = plan === null ? null : planScope(plan);
	const limits = plan === null ? null : planLimits(plan);
	const scopeFacts: Fact[] = [];
	if (scope !== null)
		scopeFacts.push({ label: "scope", value: scope.text, ...(scope.outside ? { tone: "error" as const } : {}) });
	if (limits?.perTask.some((value) => value !== null)) {
		scopeFacts.push({ label: "limits", value: limits.shared ?? "differ per task; each is listed below the plan" });
	}
	// Why before the rule's name: on a short card the reason (it writes outside this workspace) is what decides it.
	const lead: Fact[] = [];
	if (view.netReason !== undefined && view.netReason.length > 0) lead.push({ label: "why", value: view.netReason });
	if (identity.ruleFact !== null) lead.push(identity.ruleFact);
	const tail: Fact[] = [];
	if (presentation.reversibility === "limited") tail.push({ label: "undo", value: "not guaranteed" });
	else if (presentation.reversibility === "unknown") tail.push({ label: "undo", value: "unknown, treat as permanent" });
	// Size and digest stay on the card whether or not the operator opens the mutation, so the decision always
	// carries the identity of the bytes it applies to. Wrapped, never ellipsized.
	if (view.mutation !== undefined) {
		tail.push({
			label: "mutation",
			value: `${mutationFactsLine(view.mutation)} · ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} reads it before you decide`,
		});
	} else if (view.origin.kind === "worker" && isFileMutationTool(view.tool)) {
		tail.push({
			label: "mutation",
			value:
				"no local preview: this call's arguments stay inside the worker, so you are approving the target above without inspecting the change.",
			tone: "warning",
		});
	}
	// The asking prompt is standard's evidence (3.2): every tier that describes every row shows it.
	if (view.task !== undefined && policy.listDescriptions === "all") {
		tail.push({ label: "asked", value: taskRowValue(view.task), fit: "clip" });
	}
	// The rail title names the model asking; the row earns its place only for a worker, whose id and run the operator
	// cannot read anywhere else.
	if (view.origin.kind === "worker") {
		tail.push({ label: "asked by", value: `worker ${view.origin.agentId} (run ${view.origin.runId})`, tone: "muted" });
		if (view.tool === "bash" && / … \+\d+ more characters$/u.test(view.target ?? "")) {
			tail.push({
				label: "cut",
				value: "this card shows the start of the call; the rest stays inside the worker and cannot be read here.",
				tone: "warning",
			});
		}
	}
	const authority = workerGrantAuthority(view);
	if (authority !== null) tail.push({ label: "authority", value: authority });
	if (plan !== null && limits !== null) {
		if (limits.shared === null) {
			for (const [index, value] of limits.perTask.entries()) {
				if (value !== null) tail.push({ label: `limits ${index + 1}`, value });
			}
		}
		if (plan.cost !== null) tail.push({ label: "cost", value: plan.cost });
		if (plan.deadline !== null) tail.push({ label: "deadline", value: plan.deadline });
		// Route forecasts are provenance: the tier that shows every argument row shows every fact row.
		if (policy.toolArgRow) {
			for (const [index, member] of plan.members.entries()) {
				for (const value of member.forecasts) tail.push({ label: `forecast ${index + 1}`, value });
			}
		}
	}
	// Dimmed and last among the facts: the only line on this card no part of the harness acted on.
	if (advisory.length > 0) tail.push({ label: "advisory", value: advisory, tone: "muted" });
	// One label column across the call's facts; the scope block keeps its own, as the grant it states is read alone.
	const column = (facts: ReadonlyArray<Fact>): number =>
		facts.reduce((max, fact) => Math.max(max, visibleWidth(fact.label)), 0);
	const widest = column([...effectFacts, ...lead, ...tail]);
	const rows = (facts: ReadonlyArray<Fact>, labelWidth = widest): string[] =>
		facts.length === 0
			? []
			: factRows(
					theme,
					facts.map((fact) => ({ ...fact, label: fact.label.padEnd(labelWidth) })),
					content,
					CARD_FACT_ROWS,
				);
	const planSection =
		plan === null
			? []
			: [
					sectionRule(theme, content, "Plan", { meta: `[${permissionKeyLabel(MUTATION_PREVIEW_KEY)}] every field` }),
					...planTaskRows(theme, plan, scope?.routesDiffer === true, content),
				];
	const artifactRows =
		view.artifact?.kind === "settings-change"
			? [sectionRule(theme, content, "Settings change"), ...planTextRows(view.artifact.text, content)]
			: view.artifact !== undefined && plan === null
				? [sectionRule(theme, content, "Resolved dispatch plan"), ...planTextRows(view.artifact.text, content)]
				: [];
	// Enter is ignored for a moment after the card opens, so a key typed for the prompt cannot allow it unread; its
	// row says so by going quiet meanwhile.
	const choices = permissionChoices(view, presentation, hasDraft, mainTurn).map((choice) =>
		settling && choice.key === "Enter" ? { ...choice, dimmed: true } : choice,
	);
	// The rail gives up its reading keys before its answer keys; when they overflow it, the choice rows carry them.
	const allReading = readingKeys(inspectable);
	const railText = [...allReading.map((entry) => `[${keyName(entry.key)}] ${entry.verb}`), "[↑↓] scroll"].join(" · ");
	const readingFolded = visibleWidth(railText) > content - 3;
	const reading = readingFolded ? allReading : [];
	return {
		identity: identity.rows,
		effect: [...cardTargetRows(theme, view, content), ...rows(effectFacts)],
		scope: rows(scopeFacts, column(scopeFacts)),
		window: [...rows(lead), ...planSection, ...rows(tail), ...artifactRows],
		choices: [
			...choiceRows(theme, choices, content),
			...(reading.length === 0 ? [] : joinChoiceUnits(theme, readingParts(theme, reading), content)),
		],
		compactChoices: compactChoiceRows(theme, choices, content),
		readingRows: reading.length === 0 ? [] : joinChoiceUnits(theme, readingParts(theme, reading), content),
		timer: timerRows(theme, view, countdown, hasDraft, content),
		timerClause: compactCountdownClause(view, countdown),
		readingFolded,
	};
}

/**
 * The standing terms of the decision, one sentence each. The authorization
 * sentence already opens with "Approval", so it carries no label of its own.
 */
function permissionTermsRows(theme: ClioTheme, view: ApprovalRequestView, width: number): string[] {
	const presentation = permissionDecisionPresentation(view);
	const wrapTerm = (text: string): string[] => wrapTextWithAnsi(theme.fg("decisionExplanation", text), width);
	return [
		...(view.task !== undefined ? wrapTerm(`Task: ${taskRowValue(view.task)}`) : []),
		...wrapTerm(presentation.authorizationCopy),
		...wrapTerm(`Consequence: ${presentation.consequenceCopy}`),
		...wrapTerm(presentation.reversibilityCopy),
		...wrapTerm(`Deny: ${actionConsequence(presentation, "deny")}`),
		...wrapTerm(`Stop: ${actionConsequence(presentation, "stop")}`),
		...wrapTerm("Hard-blocked actions remain blocked."),
	];
}

/**
 * The card with the mutation open. The identity, target and digest stay at the
 * top so the bytes on screen remain tied to the call they belong to, and the
 * choices give way to the mutation itself: the operator opened this to read
 * what changes, and the keys that answer the ask are on the rail throughout.
 * The window takes the rows the frame has, so the frame never has to cut it.
 */
/** The fewest diff rows a window should open with before the facts above it give way. */
const MIN_INSPECTION_ROWS = 4;

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
	const target =
		view.target !== undefined && view.target.length > 0 ? targetBlock(theme, view.target, risk, content) : [];
	const fullHead = [
		...identity.rows,
		...target,
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
		sectionRule(theme, content, previewLabel(preview.heading), {
			meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
		}),
		...previewReason(theme, preview.heading, content),
	];
	const tail =
		notes.length > 0 ? [fitRow(theme.fg("annotation", `Rendered safely: ${notes.join(", ")}.`), content)] : [];
	// A short dock cut the facts' rows and the whole diff with them, and no key reached it. The card
	// just stated those facts, so the diff keeps the rows and only the call's name stays above it.
	const compact = bodyRows > 0 && fullHead.length + tail.length + 1 + MIN_INSPECTION_ROWS > bodyRows;
	const head = compact
		? [
				...identity.rows.slice(0, 1),
				...target.slice(0, 1),
				sectionRule(theme, content, previewLabel(preview.heading), {
					meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
				}),
			]
		: fullHead;
	const visibleRows = compact
		? Math.max(1, bodyRows - head.length - tail.length - 1)
		: inspectionWindowRows(bodyRows, head.length + tail.length);
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
	private termsScroll = 0;
	private termsMaxScroll = 0;
	private choicesShown = false;
	private readingFolded = false;
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
		private readonly settling?: PermissionSettlingReader,
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
		this.termsScroll = 0;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	isShowingChoices(): boolean {
		return this.choicesShown;
	}

	isShowingReadingKeys(): boolean {
		return this.choicesShown && this.readingFolded;
	}

	choicesOutOfView(): boolean {
		return !this.terms && !this.isInspecting() && !this.choicesShown;
	}

	isCardScrollable(): boolean {
		if (this.isInspecting()) return false;
		return this.terms ? this.termsMaxScroll > 0 : this.cardMaxScroll > 0;
	}

	scrollCard(delta: number): boolean {
		if (!this.isCardScrollable()) return false;
		if (this.terms) {
			this.termsScroll = Math.max(0, Math.min(this.termsScroll + delta, this.termsMaxScroll));
			return true;
		}
		this.cardScroll = Math.max(0, Math.min(this.cardScroll + delta, this.cardMaxScroll));
		return true;
	}

	render(width: number): string[] {
		const advisory = this.readAdvisory();
		const countdownMs = this.readCountdown();
		const hasDraft = this.readDraft();
		const mainTurn = this.readMainTurn();
		const settling = this.readSettling();
		// The top rule reads the same deadline this frame draws, so the two never disagree.
		railClocks.set(this.view, railClock(countdownMs));
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
			this.termsScroll,
			advisory,
			typeof countdownMs === "number"
				? Math.ceil(countdownMs / 1000)
				: isWorkerWindow(countdownMs)
					? `${Math.ceil(countdownMs.remainingMs / 1000)}:${countdownMs.held}`
					: (countdownMs ?? ""),
			hasDraft,
			mainTurn,
			settling,
			permissionKeyLabel(PERMISSION_STOP_KEY),
			skinEpoch(),
			// A held card redraws at the new tier on the next frame (3.1).
			tierRevision(),
		].join("|");
		if (this.memo?.key === key) return this.memo.lines;
		this.choicesShown = false;
		const lines = this.renderFresh(width, advisory, countdownMs, hasDraft, mainTurn, settling);
		this.memo = { key, lines };
		return lines;
	}

	private renderFresh(
		width: number,
		advisory: string,
		countdownMs: CardCountdown,
		hasDraft: boolean,
		mainTurn: boolean | undefined,
		settling = false,
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
			// The sealed plan text is what an approval covers, field for field; it leads the details the card summarizes.
			const artifact = this.view.artifact;
			if (artifact !== undefined) {
				rows.unshift(
					sectionRule(theme, content, artifact.kind === "settings-change" ? "Settings change" : "Resolved dispatch plan"),
					...planTextRows(artifact.text, content),
					sectionRule(theme, content, "Exact invocation"),
				);
				this.lastLineCount = rows.length;
			}
			const identity = identityRow(theme, this.view, permissionDecisionPresentation(this.view), content);
			const head = [
				...identity.rows,
				...(identity.ruleFact === null ? [] : factRows(theme, [identity.ruleFact], content, CARD_FACT_ROWS)),
				sectionRule(theme, content, artifact !== undefined ? "Details" : "Exact invocation", {
					meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
				}),
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
		// The card reads as a callout: on a wide terminal its sentences stop at the card width, not the dock's.
		// The inspection above keeps every column, because where a character sits is what it shows.
		// The card reads as a callout: its sentences stop at the callout width, counted with the dock's 2-cell indent, so
		// no row ends past column 88 on a wide terminal. The inspection above keeps every column.
		const card = Math.min(width, CARD_CALLOUT_MAX_WIDTH - DOCK_INDENT);
		if (this.preview === null && this.terms) return this.renderTerms(card, countdownMs);
		if (this.preview === null) {
			const parts = permissionCardParts(
				this.view,
				card,
				advisory,
				countdownMs,
				hasDraft,
				mainTurn,
				this.canInspect(),
				settling,
			);
			this.readingFolded = parts.readingFolded;
			return this.layoutCard(parts, card);
		}
		const rendered = permissionInspectionLines(this.view, this.preview, width, this.scroll, this.bodyRows);
		this.lastLineCount = rendered.wrappedLineCount;
		this.lastVisibleRows = rendered.visibleRows;
		return rendered.lines;
	}

	/**
	 * The card in the rows the frame has, decisions first (7.4). The identity, the effect, the scope, every choice with
	 * its consequence and the timer are pinned; everything else is one window between the scope and the choices, with a
	 * position row directly above the choices when it is cut. When that does not fit it shrinks in order and stops as
	 * soon as it fits: the window to one row, the effect to one row ending `… N more rows`, the choices to their compact
	 * form, the timer into the position row. Past that the card is in reading form: the identity and one effect row are
	 * pinned and everything else, choices included, is one window, and Enter does nothing until the choices are on
	 * screen. With no known budget the card renders whole.
	 */
	private layoutCard(parts: PermissionCardParts, width: number): string[] {
		const theme = clioTheme();
		const budget = this.bodyRows;
		const preview = Math.max(1, tierPolicy().decisionPreviewRows);
		const { identity, scope, window: rest, choices, compactChoices, timer, timerClause } = parts;
		const settled = (rows: string[]): string[] => {
			this.cardMaxScroll = 0;
			this.cardScroll = 0;
			this.choicesShown = true;
			return rows;
		};
		const position = (start: number, end: number, total: number, inline: boolean): string =>
			inline || timerClause === null
				? positionRow(theme, { start, end, total, keys: ["↑↓ scroll"] }, width)
				: this.timedPosition(timerClause, start, end, total, width);
		const effect = pinEffect(theme, parts.effect, preview, width);
		const head = [...identity, ...effect.pinned, ...scope];
		const body = [...effect.overflow, ...rest];
		const divider = body.length > 0 ? [rule(theme, width)] : [];
		if (budget <= 0 || head.length + body.length + divider.length + choices.length + timer.length <= budget) {
			return settled([...head, ...body, ...divider, ...choices, ...timer]);
		}
		if (head.length + body.length + choices.length + timer.length <= budget) {
			return settled([...head, ...body, ...choices, ...timer]);
		}
		const stages = [
			{ effect: preview, compact: false, inline: true },
			{ effect: 1, compact: false, inline: true },
			{ effect: 1, compact: true, inline: true },
			{ effect: 1, compact: true, inline: timerClause === null },
		];
		for (const stage of stages) {
			const pinned = pinEffect(theme, parts.effect, stage.effect, width);
			const top = [...identity, ...pinned.pinned, ...scope];
			const answer = stage.compact ? [...compactChoices, ...parts.readingRows] : choices;
			const sentence = stage.inline ? timer : [];
			const all = [...pinned.overflow, ...rest];
			const room = budget - top.length - answer.length - sentence.length;
			// A window that fits whole needs no position row.
			if (all.length <= room) return settled([...top, ...all, ...answer, ...sentence]);
			const height = room - 1;
			if (height < 1) continue;
			this.cardMaxScroll = all.length - height;
			this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
			const end = this.cardScroll + height;
			this.choicesShown = true;
			return [
				...top,
				...all.slice(this.cardScroll, end),
				position(this.cardScroll + 1, end, all.length, stage.inline),
				...answer,
				...sentence,
			];
		}
		// Reading form: the call stays named, and the choices are read in the window before Enter can answer.
		const one = pinEffect(theme, parts.effect, 1, width);
		const top = [...identity, ...one.pinned].slice(0, Math.max(1, budget));
		// The reading keys come before the choices here, so the choices close the window and fit it whole sooner.
		const all = [
			...scope,
			...one.overflow,
			...rest,
			...parts.readingRows,
			...compactChoices,
			...(timerClause === null ? timer : []),
		];
		const positioned = budget >= top.length + 2;
		const height = Math.max(0, budget - top.length - (positioned ? 1 : 0));
		this.cardMaxScroll = height > 0 ? Math.max(0, all.length - height) : 0;
		this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
		const end = Math.min(all.length, this.cardScroll + height);
		const choicesFrom = scope.length + one.overflow.length + rest.length + parts.readingRows.length;
		this.choicesShown = height > 0 && choicesFrom >= this.cardScroll && choicesFrom + compactChoices.length <= end;
		return [
			...top,
			...all.slice(this.cardScroll, end),
			...(positioned ? [position(this.cardScroll + 1, end, all.length, false)] : []),
		];
	}

	/**
	 * The terms as a layer of their own, the way the inspection is: the call's
	 * name stays on top, the terms take every row below it, and the rail carries
	 * the answer keys while they are open. Folded into the card they shared its
	 * window with the facts and the choices, and at 40x15 the window had no row
	 * left for a single sentence of them.
	 */
	private renderTerms(width: number, countdown: CardCountdown): string[] {
		const theme = clioTheme();
		const content = Math.max(8, Math.floor(width));
		const identity = identityRow(theme, this.view, permissionDecisionPresentation(this.view), content);
		// The call stays named beside the answer keys while the terms are read: two rows of it at most,
		// marked when cut, so the terms keep the rest of the rows.
		const target = cardTargetRows(theme, this.view, content);
		const targetRows = target.slice(0, 2);
		const lastTarget = targetRows.at(-1);
		if (lastTarget !== undefined && target.length > targetRows.length) {
			targetRows[targetRows.length - 1] = markContinued(lastTarget, content);
		}
		const head = [
			...identity.rows,
			...targetRows,
			sectionRule(theme, content, "Terms", { meta: `Esc or ${permissionKeyLabel(PERMISSION_TERMS_KEY)} hides` }),
		];
		const rows = permissionTermsRows(theme, this.view, content);
		const clause = compactCountdownClause(this.view, countdown);
		this.choicesShown = false;
		this.cardMaxScroll = 0;
		const budget = this.bodyRows;
		const visible = budget <= 0 ? rows.length : Math.max(1, budget - head.length - 1);
		const pane = windowRows(rows, this.termsScroll, visible);
		this.termsScroll = pane.start;
		this.termsMaxScroll = pane.maxScroll;
		const end = pane.start + pane.window.length;
		const footer =
			pane.position === null
				? clause === null
					? []
					: [
							fitRow(
								theme.fg(clause.tone, `${clause.outcome}${clause.holds.length > 0 ? ` · ${clause.holds}` : ""}`),
								content,
							),
						]
				: clause === null
					? [positionRow(theme, { ...pane.position, keys: ["↑↓ scroll"] }, content)]
					: [this.timedPosition(clause, pane.start + 1, end, rows.length, content)];
		return [...head, ...pane.window, ...footer];
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
		// `1–1/14` read as a fraction; the short forms keep the words `of` and `rows`, the way every position row says it.
		const range = start === end ? `${start}` : `${start}–${end}`;
		const candidates = [
			`${clause.outcome}${holds} · ${range} of ${total} rows · ↑↓ scroll`,
			`${clause.outcome} · ${range} of ${total} rows · ↑↓ scroll`,
			// A 40-column rail keeps only the answer keys, so the arrows stay on this row as long as any form fits.
			`${clause.outcome} · ${range} of ${total} rows · ↑↓`,
			`${clause.outcome} · ${range} of ${total} · ↑↓`,
			`${clause.outcome} · ${range} of ${total}`,
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

	private readSettling(): boolean {
		if (this.settling === undefined) return false;
		try {
			return this.settling();
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
	settling?: PermissionSettlingReader,
): PermissionOverlayBodyHandle {
	return new PermissionOverlayBody(
		view,
		inspect,
		invocation,
		advisory,
		countdown,
		draft,
		mainTurn,
		workerWindow,
		settling,
	);
}
