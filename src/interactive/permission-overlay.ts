import type { ActionClass } from "../domains/safety/action-classifier.js";
import type { AutonomyExposure } from "../domains/safety/autonomy.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
} from "../domains/safety/decision-presentation.js";
import type { Component, OverlayOptions, TUI } from "../engine/tui.js";
import {
	MUTATION_PREVIEW_VISIBLE_ROWS,
	type MutationFacts,
	type MutationInspector,
	type MutationPreview,
	mutationFactsLine,
	mutationPreviewWindow,
} from "./mutation-preview.js";
import { fitHintEntries } from "./overlay-frame.js";
import { MUTATION_PREVIEW_KEY, type PermissionInspectionHint, permissionHintEntries } from "./permission-hint.js";
import type { ClioToken } from "./theme/index.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";
export { MUTATION_PREVIEW_KEY, type PermissionInspectionHint, permissionHintEntries } from "./permission-hint.js";

export interface ApprovalRequestView {
	requestId: string;
	tool: string;
	actionClass: ActionClass;
	axis: { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string };
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	/** Admission-normalized exposure. Caller prose never supplies presentation fields. */
	exposure?: AutonomyExposure;
	reason: string;
	/** Typed, sanitized multi-line artifact that this one approval authorizes. */
	artifact?: { kind: "dispatch-plan"; text: string };
	/**
	 * One-line preview of the call's allowlisted object fields. The operator is
	 * deciding whether to allow this exact call, so the overlay must show what
	 * the call will touch, not just the tool name. Unlisted fields appear only as
	 * type-and-size summaries. Main-agent asks derive it from the parked call's
	 * args; worker escalations carry it in the escalation payload. Absent only
	 * when nothing meaningful is derivable.
	 */
	target?: string;
	/**
	 * Size and digest facts for a parked `write` or `edit`, and nothing else
	 * about it. The mutation text is deliberately absent: this view is what
	 * reaches the transcript row, the parked notice, and the approval-state
	 * event, so anything on it has already left the overlay. The text itself is
	 * held by the inspector the overlay opener is given (issue #254).
	 */
	mutation?: MutationFacts;
	queueDepth?: number;
}

const PERMISSION_OVERLAY_CONTENT_WIDTH = 78;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

/**
 * Place a permission frame immediately above the live composer in both TUI
 * modes. The editor grows with wrapped and multiline drafts, while the footer
 * can add notice rows, so their rendered heights are the bottom dock rather
 * than a fixed clearance. Regular mode preserves terminal scrollback and may
 * leave that dock above the viewport bottom when the transcript is short.
 * Recompute its viewport row on every frame so draft changes and terminal
 * resizes move the dialog with the composer.
 */
export function permissionOverlayPlacement(
	tui: Pick<TUI, "mode" | "render">,
	editor: Pick<Component, "render">,
	footer: Pick<Component, "render">,
): OverlayOptions {
	const margin = { bottom: 0 };
	return {
		anchor: "bottom-center",
		margin,
		visible: (termWidth, termHeight) => {
			const dockHeight = editor.render(termWidth).length + footer.render(termWidth).length;
			if (tui.mode === "fullscreen") {
				margin.bottom = dockHeight;
				return true;
			}

			const baseHeight = tui.render(termWidth).length;
			const composerTop = Math.max(0, baseHeight - dockHeight);
			const viewportStart = Math.max(0, baseHeight - termHeight);
			const composerViewportRow = composerTop - viewportStart;
			margin.bottom =
				composerViewportRow >= 0 && composerViewportRow < termHeight
					? Math.max(0, termHeight - composerViewportRow)
					: dockHeight;
			return true;
		},
	};
}

/**
 * The overlay body, plus the inspection state the key router drives. The
 * preview is built on the first toggle rather than per frame, so the file read
 * and the diff happen once when the operator asks for them.
 */
export interface PermissionOverlayBodyHandle extends Component {
	/** Whether this card has a mutation the operator can read locally. */
	canInspect(): boolean;
	isInspecting(): boolean;
	toggleInspect(): void;
	scrollInspect(delta: number): void;
}

class PermissionOverlayBody implements PermissionOverlayBodyHandle {
	private preview: MutationPreview | null = null;
	private scroll = 0;
	private lastLineCount = 0;

	constructor(
		private readonly view: ApprovalRequestView,
		private readonly inspect?: MutationInspector,
	) {}

	canInspect(): boolean {
		return this.inspect !== undefined;
	}

	isInspecting(): boolean {
		return this.preview !== null;
	}

	toggleInspect(): void {
		if (this.inspect === undefined) return;
		if (this.preview !== null) {
			this.preview = null;
			this.scroll = 0;
			return;
		}
		this.preview = this.inspect();
		this.scroll = 0;
	}

	scrollInspect(delta: number): void {
		if (this.preview === null) return;
		const maxScroll = Math.max(0, this.lastLineCount - MUTATION_PREVIEW_VISIBLE_ROWS);
		this.scroll = Math.max(0, Math.min(this.scroll + delta, maxScroll));
	}

	render(width: number): string[] {
		if (this.preview === null) return permissionOverlayLines(this.view, width);
		const rendered = permissionInspectionLines(this.view, this.preview, width, this.scroll);
		this.lastLineCount = rendered.wrappedLineCount;
		return rendered.lines;
	}

	invalidate(): void {}
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** `label: value`, with the value ellipsized to what the box actually has. */
function field(label: string, value: string, width: number): string {
	return `${label}${truncate(value, Math.max(1, width - label.length))}`;
}

/**
 * Greedy word wrap for prose. The safety sentences are the operator's only
 * statement of what allow and stop mean, so they wrap: cutting them at the
 * border produced "allow or de" on the surface where a misread is a wrong
 * decision about a tool call.
 */
function wrapSentence(value: string, max: number): string[] {
	if (max <= 0) return [value];
	const lines: string[] = [];
	let current = "";
	for (const word of value.split(" ")) {
		if (current.length === 0) current = word;
		else if (current.length + 1 + word.length <= max) current = `${current} ${word}`;
		else {
			lines.push(current);
			current = word;
		}
		while (current.length > max) {
			lines.push(current.slice(0, max));
			current = current.slice(max);
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
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

export function permissionDecisionPresentation(view: ApprovalRequestView): DecisionPresentation {
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

export function permissionOverlayTitle(view: ApprovalRequestView): string {
	return permissionDecisionPresentation(view).title;
}

export function permissionOverlayTone(view: ApprovalRequestView): ClioToken {
	return permissionDecisionPresentation(view).semanticToken;
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
): string {
	return fitHintEntries(permissionHintEntries(composerHasDraft, inspection), innerWidth - 3);
}

/** The tools whose parked call mutates a file, so a card without a preview owes the operator a reason. */
function isFileMutationTool(tool: string): boolean {
	return tool === "write" || tool === "edit";
}

function actionConsequence(presentation: DecisionPresentation, id: "deny" | "stop"): string {
	return presentation.requiredActions.find((action) => action.id === id)?.consequence ?? "";
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

/**
 * The card with the mutation open. The tool, target, and digest facts stay at
 * the top so the bytes on screen remain tied to the call they belong to, and
 * the standing safety prose gives way to the mutation itself: the operator
 * opened this to read what changes, and the keys that answer the ask are on the
 * footer throughout.
 */
function permissionInspectionLines(
	view: ApprovalRequestView,
	preview: MutationPreview,
	width: number,
	scroll: number,
): { lines: string[]; wrappedLineCount: number } {
	const content = Math.max(8, Math.floor(width));
	const wrapped = preview.body.flatMap((line) => wrapMutationLine(line, content));
	const pane = mutationPreviewWindow(wrapped, scroll);
	const notes: string[] = [];
	if (preview.neutralized) notes.push("control characters shown as ·");
	if (preview.tabsExpanded) notes.push("tabs shown as spaces");
	const lines = [
		field("Tool: ", `${view.tool} · Action: ${view.actionClass}`, content),
		...(view.target !== undefined && view.target.length > 0 ? [field("Target: ", view.target, content)] : []),
		...wrapSentence(`Mutation: ${mutationFactsLine(preview.facts)}`, content),
		"",
		...wrapSentence(preview.heading, content),
		...pane.window,
		...(pane.position === null ? [] : [pane.position]),
		...(notes.length > 0 ? [`Rendered safely: ${notes.join(", ")}.`] : []),
	];
	return { lines, wrappedLineCount: wrapped.length };
}

/**
 * The overlay's body, laid out for the width the frame gives it.
 *
 * Every line used to be sized for a 78-column box and the frame hard-cut the
 * rest, so a 40-column terminal saw the safety sentences end mid-word and an
 * 80-column one saw the command being authorized end mid-argument, both with
 * nothing marking the cut.
 */
export function permissionOverlayLines(view: ApprovalRequestView, width: number): string[] {
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	// The parked call is awaiting a decision, not blocked: the raw rejection
	// short ("<tool> blocked: <class>") is never rendered here because its
	// wording contradicts the ask. Tool, Target, Action, and the asking axis
	// carry everything the operator needs to decide.
	const lines = [
		field("Tool: ", `${view.tool} · Action: ${view.actionClass}`, content),
		...(view.target !== undefined && view.target.length > 0 ? [field("Target: ", view.target, content)] : []),
		// Size and digest stay on the collapsed card whether or not the operator
		// opens the mutation, so the decision always carries the identity of the
		// bytes it applies to.
		// Wrapped, never ellipsized: at 40 columns the digest is the tail of the
		// line, and ellipsizing it would drop the one fact that ties the decision
		// to the bytes it applies to.
		...(view.mutation !== undefined
			? [
					...wrapSentence(`Mutation: ${mutationFactsLine(view.mutation)}`, content),
					...wrapSentence(`Press ${MUTATION_PREVIEW_KEY} to read it before deciding.`, content),
				]
			: []),
		...(view.mutation === undefined && view.origin.kind === "worker" && isFileMutationTool(view.tool)
			? wrapSentence(
					"No local preview: this call's arguments stay inside the worker, so you are approving the target above without inspecting the mutation.",
					content,
				)
			: []),
		...wrapSentence(`Requested by: ${presentation.requestedByCopy}`, content),
		...(view.artifact !== undefined
			? [
					"",
					"Resolved dispatch plan:",
					...view.artifact.text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, content)),
				]
			: []),
		"",
		...wrapSentence(`Approval: ${presentation.authorizationCopy}`, content),
		...wrapSentence(`Consequence: ${presentation.consequenceCopy}`, content),
		...wrapSentence(presentation.reversibilityCopy, content),
		...wrapSentence(`Deny: ${actionConsequence(presentation, "deny")}`, content),
		...wrapSentence(`Stop: ${actionConsequence(presentation, "stop")}`, content),
		...wrapSentence("Hard-blocked actions remain blocked.", content),
	];
	if (view.queueDepth !== undefined && view.queueDepth > 1) {
		lines.splice(lines.indexOf(""), 0, `1 of ${view.queueDepth} parked`);
	}
	return lines;
}

/**
 * The overlay body for one parked call. The inspector, when present, is the
 * only path the mutation text takes: it is never placed on `view`, so nothing
 * that renders or forwards the view can carry the bytes with it.
 */
export function createPermissionOverlayBody(
	view: ApprovalRequestView,
	inspect?: MutationInspector,
): PermissionOverlayBodyHandle {
	return new PermissionOverlayBody(view, inspect);
}
