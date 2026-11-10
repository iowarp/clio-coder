/**
 * The render-free facts of a main-agent approval ask: the view the terminal
 * card, the transcript row and the approval-state event read, and the
 * size-and-digest facts of a parked `write` or `edit`. They live here, not
 * beside the card, so the ACP server derives the same facts from the same
 * parked call without importing the terminal (hard invariant 6).
 */

import { createHash } from "node:crypto";
import { ToolNames } from "../core/tool-names.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { askAxis } from "../domains/safety/approval-axis.js";
import { describeMainCallConsequences, mainCallExposure } from "../domains/safety/call-consequence.js";
import { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { askUserExposure } from "../tools/ask-user.js";
import type { Edit } from "../tools/edit-diff.js";
import type { PermissionRequiredMeta } from "../tools/registry.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../tools/verify/resolve.js";
import { prepareVerifyArguments } from "../tools/verify/surface.js";
import type { ApprovalRequestView, MutationFacts } from "./approval-request-view.js";

function canonicalJson(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	return "null";
}

/**
 * The identity a decision is bound to. Key order and absent optional fields do
 * not change it, so the same call digests the same way wherever it is read;
 * anything else about the arguments does, which is the point: a call that
 * differs from the previewed one cannot inherit its preview.
 */
function callArgumentsDigest(args: Record<string, unknown> | undefined): string {
	return createHash("sha256")
		.update(canonicalJson(args ?? {}), "utf8")
		.digest("hex")
		.slice(0, 16);
}

/** An `edit` call's edit list, or null when any entry is not an `{oldText, newText}` pair of strings. */
export function readEdits(value: unknown): Edit[] | null {
	if (!Array.isArray(value)) return null;
	const edits: Edit[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (typeof record.oldText !== "string" || typeof record.newText !== "string") return null;
		edits.push({ oldText: record.oldText, newText: record.newText });
	}
	return edits;
}

/**
 * The size-and-digest facts for a parked call, or null when the tool is not a
 * file mutation or its arguments are not the shape this can describe. The card
 * keeps rendering its allowlisted target either way.
 */
export function mutationFacts(tool: string, args: Record<string, unknown> | undefined): MutationFacts | null {
	if (!args || typeof args.path !== "string" || args.path.length === 0) return null;
	if (tool === ToolNames.Write) {
		if (typeof args.content !== "string") return null;
		return {
			kind: "write",
			bytes: Buffer.byteLength(args.content, "utf8"),
			replacements: 1,
			digest: callArgumentsDigest(args),
		};
	}
	if (tool === ToolNames.Edit) {
		const edits = readEdits(args.edits);
		if (edits === null || edits.length === 0) return null;
		const bytes = edits.reduce((total, edit) => total + Buffer.byteLength(edit.newText, "utf8"), 0);
		return { kind: "edit", bytes, replacements: edits.length, digest: callArgumentsDigest(args) };
	}
	return null;
}

/** The registry's axis id (`net:<rule>`, `autonomy:<level>`) as the view's axis, or null when it is neither. */
export function axisViewFromId(axisId: string | undefined, fallbackLevel: string): ApprovalRequestView["axis"] | null {
	if (axisId?.startsWith("net:")) {
		const ruleId = axisId.slice("net:".length);
		return { kind: "net", ruleId: ruleId.length > 0 ? ruleId : "unknown" };
	}
	if (axisId?.startsWith("autonomy:")) {
		const level = axisId.slice("autonomy:".length);
		return { kind: "autonomy", level: level.length > 0 ? level : fallbackLevel };
	}
	return null;
}

/**
 * The rule's reason for a net-axis ask in words: the policy verdict's first reason that is a sentence, else the
 * damage-control match's. A policy can lead with its audit code (`damage-control:truncate-size-zero`), which the
 * card printed as its `why` beside an effect that already said it in words (B05); the code stays on the rule row
 * and in inspection.
 */
function netReasonOf(decision: SafetyDecision): string | undefined {
	if (decision.kind !== "ask") return undefined;
	const reasons = [
		...(decision.policy?.kind === "ask" ? decision.policy.reasons : []),
		...(decision.match?.reason !== undefined ? [decision.match.reason] : []),
	];
	for (const reason of reasons) {
		const words = reasonSentence(reason);
		if (words !== null) return sanitizeCallTargetText(netReasonWords(words));
	}
	return undefined;
}

/** A damage-control match's reason names its rule first (`matched truncate-size-zero: …`); the card keeps the words. */
const MATCHED_RULE_PREFIX = /^matched [\w.:-]+: (?=\S)/u;

/** A reason as words, or null for an audit code: one token with no space in it is never a sentence. */
function reasonSentence(reason: string): string | null {
	const trimmed = reason.trim();
	if (trimmed.length === 0 || !/\s/u.test(trimmed)) return null;
	return trimmed.replace(MATCHED_RULE_PREFIX, "");
}

/**
 * The classifier's write-path codes as the card's `why` row says them. The code
 * itself (`write-path-outside-cwd: /home/…`) is the classifier's audit word, and
 * the card is read by someone deciding, not auditing.
 */
const WRITE_PATH_REASONS: ReadonlyArray<readonly [string, string]> = [
	["write-path-outside-cwd: ", "it writes outside this workspace, to "],
	["write-path-home-escape: ", "it writes through a home-directory path the workspace cannot bound: "],
	["write-path-system-root: ", "it writes under the system directory "],
];

function netReasonWords(reason: string): string {
	for (const [code, words] of WRITE_PATH_REASONS) {
		if (reason.startsWith(code)) return `${words}${reason.slice(code.length)}`;
	}
	return reason;
}

/**
 * The command a verify call will run, resolved the way the tool and the safety
 * scan resolve it, so the card names it beside the check id as the bash card
 * names its command. Absent when the call resolves to nothing runnable.
 */
function resolvedVerifyCommand(call: ClassifierCall): { command: string } | undefined {
	if (call.tool !== ToolNames.Verify || call.args === undefined) return undefined;
	try {
		const args = prepareVerifyArguments(call.args);
		const argv = verifyResolutionArgv(resolveVerifyCall(process.cwd(), args), args);
		return argv === null ? undefined : { command: argv.join(" ") };
	} catch {
		// Resolution reads project files; the card falls back to the check id alone.
		return undefined;
	}
}

/** The approval view of a main-agent ask the registry parked. */
export function mainApprovalRequestView(
	call: ClassifierCall,
	decision: SafetyDecision,
	meta: PermissionRequiredMeta | undefined,
	autonomy: string,
	queueDepth: number | undefined,
): ApprovalRequestView {
	const axisFromMeta = axisViewFromId(meta?.axis, autonomy);
	const axisFromDecision = askAxis(decision);
	const axis =
		axisFromMeta ??
		(axisFromDecision.kind === "net"
			? { kind: "net" as const, ruleId: axisFromDecision.ruleId }
			: { kind: "autonomy" as const, level: autonomy });
	const target = describeCallTarget(call.tool, call.args, resolvedVerifyCommand(call), undefined, "Alt+V shows all");
	const netReason = axis.kind === "net" ? netReasonOf(decision) : undefined;
	// Facts only. The mutation text stays in the inspector the overlay opener
	// gets; this object reaches the transcript row and the approval-state event.
	const mutation = mutationFacts(call.tool, call.args);
	const consequence = describeMainCallConsequences(call);
	return {
		requestId: meta?.requestId ?? "permission-pending",
		tool: call.tool,
		actionClass: decision.classification.actionClass,
		axis,
		origin: { kind: "main" },
		reason:
			decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${decision.classification.actionClass}`,
		...(netReason !== undefined ? { netReason } : {}),
		...(consequence.length > 0 ? { consequence } : {}),
		...(call.tool === ToolNames.Dispatch && decision.kind === "ask"
			? { artifact: { kind: "dispatch-plan" as const, text: decision.rejection.detail } }
			: call.tool === ToolNames.ConfigureClio && decision.kind === "ask"
				? { artifact: { kind: "settings-change" as const, text: decision.rejection.detail } }
				: {}),
		exposure: call.tool === ToolNames.AskUser ? askUserExposure(call.args) : mainCallExposure(call, decision),
		...(target.length > 0 ? { target } : {}),
		...(mutation !== null ? { mutation } : {}),
		...(queueDepth !== undefined && queueDepth > 1 ? { queueDepth } : {}),
	};
}
