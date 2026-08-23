import type { ActionClass } from "../domains/safety/action-classifier.js";
import type { AutonomyExposure } from "../domains/safety/autonomy.js";
import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForPermission,
} from "../domains/safety/decision-presentation.js";
import type { Component } from "../engine/tui.js";
import { fitHintEntries } from "./overlay-frame.js";
import { permissionHintEntries } from "./permission-hint.js";
import type { ClioToken } from "./theme/index.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";
export { permissionHintEntries } from "./permission-hint.js";

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
	queueDepth?: number;
}

const PERMISSION_OVERLAY_CONTENT_WIDTH = 78;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

/**
 * Keep the decision next to the composer rail that mirrors its keys. The
 * terminal engine resolves this anchor on every layout pass, so the five-row
 * clearance remains attached to the bottom edge after a resize.
 */
export const PERMISSION_OVERLAY_PLACEMENT = {
	anchor: "bottom-center",
	margin: { bottom: 5 },
} as const;

class PermissionOverlayBody implements Component {
	constructor(private readonly view: ApprovalRequestView) {}

	render(width: number): string[] {
		return permissionOverlayLines(this.view, width);
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
export function permissionOverlayHint(innerWidth: number, composerHasDraft = false): string {
	return fitHintEntries(permissionHintEntries(composerHasDraft), innerWidth - 3);
}

function actionConsequence(presentation: DecisionPresentation, id: "deny" | "stop"): string {
	return presentation.requiredActions.find((action) => action.id === id)?.consequence ?? "";
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

export function createPermissionOverlayBody(view: ApprovalRequestView): Component {
	return new PermissionOverlayBody(view);
}
