import type { Component } from "../engine/tui.js";
import { fitHintEntries, type HintEntry } from "./overlay-frame.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";

export interface ApprovalRequestView {
	requestId: string;
	tool: string;
	actionClass: string;
	axis: { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string };
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	reason: string;
	/** Typed, sanitized multi-line artifact that this one approval authorizes. */
	artifact?: { kind: "dispatch-plan"; text: string };
	/**
	 * One-line preview of the call's object: the command for bash, the path
	 * for file tools, else a compact args preview. The operator is deciding
	 * whether to allow this exact call, so the overlay must show what the
	 * call will touch, not just the tool name. Main-agent asks derive it from
	 * the parked call's args; worker escalations carry it in the escalation
	 * payload. Absent only when nothing meaningful is derivable.
	 */
	target?: string;
	queueDepth?: number;
}

const PERMISSION_OVERLAY_CONTENT_WIDTH = 78;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

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

function axisLabel(axis: ApprovalRequestView["axis"], style: ApprovalRequestView["origin"]["kind"]): string {
	if (axis.kind === "net") return `safety-net rail ${axis.ruleId}`;
	return style === "worker" ? `autonomy level ${axis.level}` : `autonomy level (${axis.level})`;
}

function askedBy(view: ApprovalRequestView): string {
	if (view.origin.kind === "worker") {
		return `worker ${view.origin.agentId} (run ${view.origin.runId}), ${axisLabel(view.axis, "worker")}`;
	}
	return axisLabel(view.axis, "main");
}

export function permissionOverlayTitle(): string {
	return "Allow this action once?";
}

/**
 * The keys that answer a parked call, as data, so the dialog footer and the
 * composer rail render the same policy at any width.
 *
 * At 40 columns the old positional elider removed `[s] stop turn` and left
 * "allow once" and an ambiguous "close" in front of an operator trying to
 * refuse. The key kept working, so the layout was hiding a live safety action.
 * Allow and stop are marked critical, Esc is marked droppable, and
 * `fitHintEntries` shortens every label before it drops anything.
 *
 * Esc says `deny`, not `close`: closing the dialog denies the call, and on the
 * one surface where a misread is a wrong decision about a tool call the key
 * names its effect.
 *
 * With a draft in the composer, Enter is inert (issue #186): the habitual send
 * key must not resolve toward "allow" on a safety rail. The entry then says so
 * and names the keys that clear the draft, which the router passes through.
 */
export function permissionHintEntries(composerHasDraft = false): HintEntry[] {
	return [
		composerHasDraft
			? { key: "Backspace", verb: "clear the draft to allow", short: "clear draft", critical: true }
			: { key: "Enter", verb: "allow once", short: "allow", critical: true },
		{ key: "s", verb: "stop turn", short: "stop", critical: true },
		// With a draft, deny and stop are the only immediate answers, so Esc
		// outranks the narrowing that would otherwise drop it first.
		{ key: "Esc", verb: "deny", critical: composerHasDraft },
	];
}

/**
 * The footer for a box `innerWidth` columns wide inside its borders. The
 * three columns the bottom border spends on `─ ` and the trailing space come
 * off the top, which is what `buildResponsiveHint` does for every other frame.
 */
export function permissionOverlayHint(innerWidth: number, composerHasDraft = false): string {
	return fitHintEntries(permissionHintEntries(composerHasDraft), innerWidth - 3);
}

const SAFETY_SENTENCES: ReadonlyArray<string> = [
	"Parked until you decide; allow or deny applies to this call only.",
	"Stopping the turn denies it and ends the run, so nothing asks again.",
	"Hard-blocked actions remain blocked.",
];

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
	// The parked call is awaiting a decision, not blocked: the raw rejection
	// short ("<tool> blocked: <class>") is never rendered here because its
	// wording contradicts the ask. Tool, Target, Action, and the asking axis
	// carry everything the operator needs to decide.
	const lines = [
		field("Tool: ", view.tool, content),
		...(view.target !== undefined && view.target.length > 0 ? [field("Target: ", view.target, content)] : []),
		field("Action: ", view.actionClass, content),
		field("Asked by: ", askedBy(view), content),
		...(view.artifact !== undefined
			? [
					"",
					"Resolved dispatch plan:",
					...view.artifact.text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, content)),
				]
			: []),
		"",
		...SAFETY_SENTENCES.flatMap((sentence) => wrapSentence(sentence, content)),
	];
	if (view.queueDepth !== undefined && view.queueDepth > 1) {
		lines.splice(lines.indexOf(""), 0, `1 of ${view.queueDepth} parked`);
	}
	return lines;
}

export function createPermissionOverlayBody(view: ApprovalRequestView): Component {
	return new PermissionOverlayBody(view);
}
