// Everything the permission card decides, kept out of the component because this app has no DOM
// test environment: the taxonomy, the escalation clock, the action set and the preview of the
// concrete thing being approved all have to be exercisable by node:test.
//
// Three rules carry the weight here.
//
//  - Escalation is a state, not a timeout. The card derives it from the permission's own
//    timestamps rather than waiting for the `permission.escalated` delta, so the UI never lags the
//    clock. The server's declared windows are 45 s to escalation and a 600 s budget
//    (server/acp/permissions.ts PERMISSION_TIMERS); this module reads them off the wire and only
//    falls back to those constants when a stamp does not parse.
//  - The only two one-time answers on the wire are `allow-once` and `reject`, which is why the card
//    eyebrow says ONE USE. `reject-and-stop` is a third answer the agent may announce per request;
//    it is drawn only when `canStopTurn` is true, because sending it otherwise is a 409 rather than
//    a silent plain reject.
//  - No model-authored prose reaches this card. Every sentence below is either fixed copy or a
//    value the agent already classified and bounded upstream.

import type { Permission, PermissionDecision, PermissionDecisionFacts } from "../../contracts/permissions.js";
import { formatDuration, formatTime } from "../api/clock.js";
import type { StatusTone } from "../design/status.js";

/** The server's declared escalation window, used only when `escalateAt` does not parse. */
export const ESCALATION_SECONDS = 45;
/** The server's declared approval budget, used only when `expiresAt` does not parse. */
export const BUDGET_SECONDS = 600;

/** The safety posture, verbatim. It is the product's whole promise in one line. */
export const SAFETY_POSTURE = "Nothing runs until you answer. The GUI never answers for you.";
/** The `ONE USE` is load-bearing: there is deliberately no allow-always on the wire. */
export const CARD_EYEBROW = "APPROVAL NEEDED · ONE USE";
export const KEYBOARD_HINT = "Alt+A allows once · Alt+R rejects";

export const bannerEyebrow = (escalated: boolean): string =>
	escalated ? "APPROVAL WAITING · ESCALATED" : "APPROVAL NEEDED";

export const isAwaitingAnswer = (permission: Pick<Permission, "status">): boolean =>
	permission.status === "pending" || permission.status === "escalated";

/**
 * The distinction between 'told no' and 'not told no' is a real difference in what the model sees:
 * a reject is an answer the agent receives, an expiry or a cancellation is not.
 */
export const RESOLUTION_SUMMARY: Readonly<Record<string, string>> = {
	allowed: "Allowed once by the operator.",
	rejected: "Rejected by the operator. Clio Coder was told no.",
	cancelled: "Withdrawn when the turn was cancelled. Clio Coder was not told no.",
	expired: "Nobody answered. The turn was stopped; Clio Coder was not told no.",
};

export const resolutionSummary = (status: string): string =>
	RESOLUTION_SUMMARY[status] ?? "Clio Coder recorded an outcome this GUI does not classify.";

export interface ApprovalTimings {
	/** True once the declared escalation window has passed, or once the server said so. */
	readonly escalated: boolean;
	readonly waitedMs: number;
	readonly waitedSeconds: number;
	readonly remainingMs: number;
	readonly remainingSeconds: number;
	/** True when the budget has run out on this clock, whatever the server has not yet told us. */
	readonly expired: boolean;
	/** False when `expiresAt` did not parse, which makes the countdown sentence degrade. */
	readonly budgetKnown: boolean;
	/** The window the product promised, not the observed wait. The announcer speaks this one. */
	readonly declaredEscalationSeconds: number;
}

const instant = (value: string): number | null => {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};
const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

export function deriveApprovalTimings(
	permission: Pick<Permission, "status" | "requestedAt" | "escalateAt" | "expiresAt">,
	nowMs: number,
): ApprovalTimings {
	const requested = instant(permission.requestedAt),
		escalateAt = instant(permission.escalateAt),
		expiresAt = instant(permission.expiresAt);
	const waitedMs = requested === null ? 0 : Math.max(0, nowMs - requested);
	const remainingMs = expiresAt === null ? 0 : Math.max(0, expiresAt - nowMs);
	const declared =
		requested !== null && escalateAt !== null && escalateAt > requested
			? seconds(escalateAt - requested)
			: ESCALATION_SECONDS;
	return {
		escalated: permission.status === "escalated" || (escalateAt !== null && nowMs >= escalateAt),
		waitedMs,
		waitedSeconds: seconds(waitedMs),
		remainingMs,
		remainingSeconds: seconds(remainingMs),
		expired: expiresAt !== null && nowMs >= expiresAt,
		budgetKnown: expiresAt !== null,
		declaredEscalationSeconds: declared,
	};
}

/** The countdown is phrased as a consequence rather than as a timer, because that is the decision. */
export function countdownSentence(timings: ApprovalTimings, expiresAt: string): string {
	return timings.budgetKnown
		? `If unanswered, this turn stops in ${formatDuration(timings.remainingMs)} (at ${formatTime(expiresAt)}).`
		: "If unanswered, this turn stops when Clio Coder's approval budget runs out.";
}

/** Under a second the wait is not a measurement worth printing, so it says the request just arrived. */
export const waitedSentence = (timings: ApprovalTimings): string =>
	timings.waitedMs < 1000 ? "Asked just now." : `Waiting ${formatDuration(timings.waitedMs)}.`;

export interface CallLocation {
	readonly path: string;
	readonly line?: number | null;
}

/** ACP line numbers are zero-based, so a reported line is shown one higher. */
export const formatLocation = (location: CallLocation): string =>
	typeof location.line === "number" && Number.isInteger(location.line)
		? `${location.path}:${location.line + 1}`
		: location.path;

/** At most three named inline; the rest are counted, never silently dropped. */
export function formatLocations(locations: readonly CallLocation[] | undefined): string[] {
	const all = (locations ?? []).map(formatLocation);
	return all.length > 3 ? [...all.slice(0, 3), `+${all.length - 3} more`] : all;
}

/** The permission carries no locations of its own; they come from the gated tool call. */
export function accessSentence(
	permission: Pick<Permission, "kind">,
	locations: readonly CallLocation[] | undefined,
): string {
	const named = formatLocations(locations);
	return `${permission.kind} access to ${named.length === 0 ? "this turn" : named.join(", ")}.`;
}

/**
 * The safety facts in the order the card prints them, after the title heading. The countdown moves
 * on the shared one-second clock, so this is recomputed per tick rather than memoised.
 */
export function safetyFacts(
	permission: Pick<Permission, "kind" | "status" | "requestedAt" | "escalateAt" | "expiresAt">,
	locations: readonly CallLocation[] | undefined,
	timings: ApprovalTimings,
): readonly string[] {
	return [
		accessSentence(permission, locations),
		countdownSentence(timings, permission.expiresAt),
		SAFETY_POSTURE,
		waitedSentence(timings),
	];
}

/** What a screen reader hears the moment a card appears. */
export const approvalAnnouncement = (permission: Pick<Permission, "title" | "kind">): string =>
	`Approval needed: ${permission.title}. ${permission.kind} access. Nothing runs until you answer.`;

// ---- the agent's own classification -------------------------------------------------------

/**
 * The agent classified the call before it asked. Without these facts a client would re-derive a
 * tier and a consequence from a tool name, which is a second and worse classifier, so this module
 * only ever labels values it was given and never invents one from the tool.
 */
export const DECISION_TIER_LABELS: Readonly<Record<string, string>> = {
	conversation: "Conversation",
	workspace: "Workspace",
	outward: "Outward",
	"safety-net": "Safety net",
	system: "System",
	worker: "Worker",
};

export const ACTION_CLASS_LABELS: Readonly<Record<string, string>> = {
	read: "reads content",
	write: "writes content",
	execute: "runs a command",
	dispatch: "dispatches a worker",
	system_modify: "changes this machine",
	git_destructive: "rewrites git history",
	unknown: "does something Clio Coder did not classify",
};

export const AFFECTED_SCOPE_LABELS: Readonly<Record<string, string>> = {
	conversation: "reaches this conversation only",
	workspace: "reaches this workspace",
	outward: "reaches outside this machine",
	system: "reaches this machine",
};

export const REVERSIBILITY_LABELS: Readonly<Record<string, string>> = {
	reversible: "reversible",
	limited: "reversible only in part",
	unknown: "not classified as reversible",
};

/**
 * The agent's three semantic tokens onto the six status tones. `accent` is the calm classification,
 * `action` is consequential, `warning` is the one that should stop an operator mid-scroll.
 */
export const DECISION_TONES: Readonly<Record<string, StatusTone>> = {
	accent: "neutral",
	action: "warn",
	warning: "fail",
};

export const decisionTone = (decision: PermissionDecisionFacts | undefined): StatusTone =>
	decision === undefined ? "warn" : (DECISION_TONES[decision.semanticToken] ?? "warn");

const labelled = (table: Readonly<Record<string, string>>, value: string): string => table[value] ?? value;

/** The short chips above the facts: tier, what it does, how far it reaches. */
export function decisionChips(decision: PermissionDecisionFacts | undefined): readonly string[] {
	if (decision === undefined) return [];
	const tier = decision.tierLabel.length > 0 ? decision.tierLabel : labelled(DECISION_TIER_LABELS, decision.tier);
	return [
		tier,
		labelled(ACTION_CLASS_LABELS, decision.actionClass),
		labelled(AFFECTED_SCOPE_LABELS, decision.affectedScope),
	];
}

export interface DecisionRow {
	readonly term: string;
	readonly value: string;
}

/**
 * The agent's own prose, already control-stripped and bounded to 512 bytes upstream. A copy field
 * the agent left empty falls back to this module's label for the matching enum rather than to a
 * blank row, and `reversibility` is the one axis where both a classification and a sentence exist.
 */
export function decisionRows(decision: PermissionDecisionFacts | undefined): readonly DecisionRow[] {
	if (decision === undefined) return [];
	const rows: DecisionRow[] = [];
	const push = (term: string, value: string) => {
		if (value.length > 0) rows.push({ term, value });
	};
	push("Authorization", decision.authorizationCopy);
	push("Consequence", decision.consequenceCopy);
	push(
		"Reversibility",
		decision.reversibilityCopy.length > 0
			? decision.reversibilityCopy
			: labelled(REVERSIBILITY_LABELS, decision.reversibility),
	);
	push("Requested by", decision.requestedByCopy);
	push("Target", decision.target ?? "");
	return rows;
}

/** Said in place of the classification when the agent announced none, so the gap is stated. */
export const NO_DECISION_FACTS = "Clio Coder sent no classification with this request.";

// ---- the answers ---------------------------------------------------------------------------

export interface ApprovalAction {
	readonly decision: PermissionDecision;
	readonly label: string;
	/** `primary` is the affirmative and is drawn last; the refusals are quiet and come first. */
	readonly variant: "quiet" | "primary";
	readonly description: string;
	/** The declared keybinding id, or null for an answer that has no chord. */
	readonly keybinding: "allowOnce" | "reject" | null;
}

const REJECT: ApprovalAction = {
	decision: "reject",
	label: "Reject",
	variant: "quiet",
	description: "Denies this one request. The turn continues.",
	keybinding: "reject",
};
const REJECT_AND_STOP: ApprovalAction = {
	decision: "reject-and-stop",
	label: "Reject and stop the turn",
	variant: "quiet",
	description: "Denies this request and every other parked request from this turn, and cancels the turn.",
	keybinding: null,
};
const ALLOW_ONCE: ApprovalAction = {
	decision: "allow-once",
	label: "Allow once",
	variant: "primary",
	description: "Allows this one call. Clio Coder asks again next time.",
	keybinding: "allowOnce",
};

/**
 * Destructive-safe first, affirmative last. The turn-ending refusal is drawn only when the agent
 * announced it: an engine with no tool registry announces nothing, and the card must still work
 * with the two answers that have always been on the wire.
 */
export function approvalActions(permission: Pick<Permission, "canStopTurn">): readonly ApprovalAction[] {
	return permission.canStopTurn ? [REJECT, REJECT_AND_STOP, ALLOW_ONCE] : [REJECT, ALLOW_ONCE];
}

// ---- the concrete thing being approved -------------------------------------------------------

/**
 * The narrow slice of a timeline tool call this card reads. It is deliberately structural rather
 * than `TimelineItem`, so the integrator can hand it the item directly or hand it whatever the
 * tool-presentation module projects, without this module reaching into either.
 */
export interface GatedCall {
	readonly title?: string;
	readonly toolKind?: string;
	readonly rawInput?: Readonly<Record<string, unknown>>;
	readonly locations?: readonly CallLocation[];
}

export interface ProposedEdit {
	readonly oldText: string;
	readonly newText: string;
}

/**
 * What to draw in the card body. This is the answer to 'review the tool input in the conversation',
 * which is what the old card asked the operator to do by hand.
 */
export type GatedPreview =
	| { readonly kind: "command"; readonly label: string; readonly command: string; readonly truncated: boolean }
	| {
			readonly kind: "edits";
			readonly label: string;
			readonly path: string;
			readonly edits: readonly ProposedEdit[];
			readonly truncated: boolean;
	  }
	| {
			readonly kind: "contents";
			readonly label: string;
			readonly path: string;
			readonly contents: string;
			readonly truncated: boolean;
	  }
	| { readonly kind: "path"; readonly label: string; readonly path: string }
	| {
			readonly kind: "host";
			readonly label: string;
			readonly host: string;
			readonly url: string;
			readonly requestedUrl: string;
			readonly truncated: boolean;
	  }
	| { readonly kind: "summary"; readonly label: string; readonly summary: string }
	| { readonly kind: "none"; readonly label: string; readonly note: string };

/** A synthesized block never renders more than this; the operator scrolls the real diff instead. */
export const PREVIEW_MAX_LINES = 400;
export const PREVIEW_MAX_CHARS = 16_000;
export const COMMAND_MAX_CHARS = 4_000;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * `rawInput` is the harness's literal argument object and nothing upstream promised it is printable,
 * so control codes are stripped here rather than trusted. Newlines and tabs survive because a
 * command and a file body are both multi-line by nature.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control codes is the point.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function clampText(value: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
	const clean = value.replace(CONTROL, "");
	const lines = clean.split("\n");
	const byLines = lines.length > maxLines;
	const kept = byLines ? lines.slice(0, maxLines).join("\n") : clean;
	const byChars = kept.length > maxChars;
	return { text: byChars ? kept.slice(0, maxChars) : kept, truncated: byLines || byChars };
}

function editsFrom(input: Readonly<Record<string, unknown>>): ProposedEdit[] {
	const list = Array.isArray(input.edits) ? input.edits : [input];
	const edits: ProposedEdit[] = [];
	for (const entry of list) {
		const edit = record(entry);
		const oldText = typeof edit.oldText === "string" ? edit.oldText : null,
			newText = typeof edit.newText === "string" ? edit.newText : null;
		if (oldText === null && newText === null) continue;
		edits.push({ oldText: oldText ?? "", newText: newText ?? "" });
	}
	return edits;
}

const COMMAND_TOOLS = new Set(["bash", "run_script", "verify", "safe_exec", "git"]);
const EDIT_TOOLS = new Set(["edit", "artifact"]);
const PATH_TOOLS = new Set(["read", "ls", "grep", "find", "code_nav"]);

/**
 * Keyed on `item.title`, which is the canonical Clio tool name; `toolKind` is only the coarse ACP
 * hint and is the fallback. A tool this build has never seen produces a readable `none` rather than
 * an empty body, because an approval card that shows nothing is the bug being fixed.
 */
export function gatedPreview(call: GatedCall | undefined): GatedPreview {
	if (call === undefined)
		return {
			kind: "none",
			label: "What is being approved",
			note: "This request is not linked to a call in this conversation.",
		};
	const input = record(call.rawInput);
	const name = call.title ?? call.toolKind ?? "tool";
	if (COMMAND_TOOLS.has(name)) {
		const raw = text(input.command) ?? text(input.script);
		if (raw === null) {
			const operation = text(input.op) ?? text(input.id);
			if (operation !== null)
				return {
					kind: "summary",
					label: name === "git" ? "Git operation" : "Operation",
					summary: clampText(operation, 1, 256).text,
				};
			return { kind: "none", label: "Command", note: "Clio Coder reported no command for this call." };
		}
		const clamped = clampText(raw, PREVIEW_MAX_LINES, COMMAND_MAX_CHARS);
		return { kind: "command", label: "Command", command: clamped.text, truncated: clamped.truncated };
	}
	if (EDIT_TOOLS.has(name)) {
		const path = text(input.path) ?? "a file Clio Coder did not name";
		const edits = editsFrom(input);
		if (edits.length === 0) return { kind: "path", label: "File", path };
		let truncated = false;
		const budget = Math.max(1, Math.floor(PREVIEW_MAX_LINES / edits.length));
		const clamped = edits.map((edit) => {
			const before = clampText(edit.oldText, budget, PREVIEW_MAX_CHARS),
				after = clampText(edit.newText, budget, PREVIEW_MAX_CHARS);
			truncated = truncated || before.truncated || after.truncated;
			return { oldText: before.text, newText: after.text };
		});
		return { kind: "edits", label: "Proposed · not yet applied", path, edits: clamped, truncated };
	}
	if (name === "write") {
		const path = text(input.path) ?? "a file Clio Coder did not name";
		const content = text(input.content);
		if (content === null) return { kind: "path", label: "File", path };
		const clamped = clampText(content, PREVIEW_MAX_LINES, PREVIEW_MAX_CHARS);
		return {
			kind: "contents",
			label: "Proposed new contents",
			path,
			contents: clamped.text,
			truncated: clamped.truncated,
		};
	}
	if (name === "web_fetch") {
		const url = text(input.url);
		if (url === null) return { kind: "none", label: "Address", note: "Clio Coder reported no address for this fetch." };
		const clamped = clampText(url, 1, 512);
		try {
			const parsed = new URL(url);
			return {
				kind: "host",
				label: "Requested URL",
				host: parsed.host,
				url: `${parsed.host}${parsed.pathname}`,
				requestedUrl: clamped.text,
				truncated: clamped.truncated,
			};
		} catch {
			return {
				kind: "host",
				label: "Requested URL",
				host: clamped.text,
				url: clamped.text,
				requestedUrl: clamped.text,
				truncated: clamped.truncated,
			};
		}
	}
	if (name === "dispatch") {
		const agent = text(input.agent) ?? text(input.recipe) ?? "an unnamed agent";
		const task = text(input.task);
		const preview = task === null ? "no task preview" : clampText(task, 1, 160).text;
		return { kind: "summary", label: "Dispatch", summary: `${agent} · ${preview}` };
	}
	if (PATH_TOOLS.has(name)) {
		const path = text(input.path) ?? text(input.pattern) ?? text(input.glob);
		if (path !== null) return { kind: "path", label: "Path", path: clampText(path, 1, 512).text };
	}
	const locations = formatLocations(call.locations);
	if (locations.length > 0) return { kind: "path", label: "Path", path: locations.join(", ") };
	return {
		kind: "none",
		label: "What is being approved",
		note: `Clio Coder reported no reviewable input for ${name}.`,
	};
}
