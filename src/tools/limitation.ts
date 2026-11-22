import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/**
 * The typed limitation signal the finish contract reads. Calling the tool
 * records a `limitation` tool_call and tool_result pair in the session ledger,
 * and that successful receipt is what `assessFinishContract` accepts in place
 * of validation evidence. The tool is pure: it touches no filesystem and runs
 * no shell, so the receipt itself is its whole effect.
 */

export const LIMITATION_REASONS = [
	"no-runner",
	"blocked",
	"out-of-scope",
	"environment",
	"write-root",
	"other",
] as const;

export type LimitationReason = (typeof LIMITATION_REASONS)[number];

export interface LimitationRecord {
	scope: string;
	reason: LimitationReason;
	paths: string[];
}

function isLimitationReason(value: unknown): value is LimitationReason {
	return typeof value === "string" && (LIMITATION_REASONS as ReadonlyArray<string>).includes(value);
}

function trimString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * A reason that says the run's tools are gone. Once the host withdraws a worker's tools every call is blocked, so a
 * limitation or finish call that runs proves its tools are open and such a reason is false: a luna coder quit at 25 s
 * of a 2 min run reporting "the tool window closed" with no handback fired (M-37).
 */
const TOOLS_GONE_CLAIMS: ReadonlyArray<RegExp> = [
	/\btool[- ]window\s+(?:(?:was|is|has|had)\s+(?:been\s+)?)?(?:closed|withdrawn|ended|expired|gone|shut)\b/iu,
	/\b(?:my|the|your|its|all)\s+tools\s+(?:(?:were|are|have|had|has)\s+(?:been\s+)?|got\s+)?(?:closed|withdrawn|removed|revoked|taken away|cut off|locked|gone|disabled)\b/iu,
	/\btool access\s+(?:(?:was|is|has|had)\s+(?:been\s+)?)?(?:closed|ended|withdrawn|removed|revoked|cut off|gone)\b/iu,
	/\b(?:withdrew|withdrawn|revoked|removed|lost)\s+(?:my|the|your|its|all)\s+(?:tools|tool access)\b/iu,
];

export function claimsToolsGone(text: string): boolean {
	return TOOLS_GONE_CLAIMS.some((pattern) => pattern.test(text));
}

/** The typed refusal of a tools-gone reason, for the limitation and finish tools. */
export const TOOLS_OPEN_REFUSAL =
	"refused (tools_open): the reason says the run's tools are gone, but this call ran, so its tools are open and nothing was recorded. Keep working on the task with your tools; when it is time to hand back, the host asks for your report in its own message.";

function normalizePaths(value: unknown): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const paths: string[] = [];
	for (const item of value) {
		const path = trimString(item);
		if (path === null) return null;
		if (!paths.includes(path)) paths.push(path);
	}
	return paths;
}

const LIMITATION_REASON_MEANINGS: Readonly<Record<LimitationReason, string>> = {
	"no-runner": "no runner exists or no project check applies to this change",
	blocked: "a gate or denial stopped the check",
	"out-of-scope": "the task excluded it",
	environment: "it cannot run here",
	"write-root":
		"the change needs the listed paths, which lie outside your write roots, so stop before editing and the coordinator can widen the roots and continue",
	other: "none of the above",
};

const LIMITATION_REASON_TEXT = LIMITATION_REASONS.map((reason) =>
	reason === "other" ? reason : `${reason}: ${LIMITATION_REASON_MEANINGS[reason]}`,
);

/**
 * Where preparation keeps an off-enum reason's text after filing it under the closest value, so `run` can tell a
 * filed reason from a typed one. Preparation runs on the direct path, again on the gateway path and again in the
 * registry, so the key survives every pass and never doubles the scope.
 */
const OFF_ENUM_REASON = "offEnumReason";

function prepareLimitationArguments(args: Record<string, unknown>): Record<string, unknown> {
	const reason = args.reason;
	if (typeof reason !== "string" || isLimitationReason(reason)) return args;
	const text = reason.trim();
	if (isLimitationReason(text)) return { ...args, reason: text };
	const scope = trimString(args.scope);
	return {
		...args,
		scope: scope === null ? text : text.length > 0 ? `${scope} (${text})` : scope,
		reason: /\b(block|den(y|ied)|permission|policy|safety|approval)/iu.test(text) ? "blocked" : "other",
		[OFF_ENUM_REASON]: text,
	};
}

/**
 * Sessions that already had one off-enum reason refused (row 382). The first refusal teaches the values; a later
 * one is filed so a small model never loops on the refusal. Oldest keys drop first past the cap.
 */
const offEnumRefusedSessions = new Set<string>();
const OFF_ENUM_SESSION_CAP = 1024;

function firstOffEnumReason(sessionKey: string): boolean {
	if (offEnumRefusedSessions.has(sessionKey)) return false;
	if (offEnumRefusedSessions.size >= OFF_ENUM_SESSION_CAP) {
		const oldest = offEnumRefusedSessions.values().next().value;
		if (oldest !== undefined) offEnumRefusedSessions.delete(oldest);
	}
	offEnumRefusedSessions.add(sessionKey);
	return true;
}

function offEnumRefusal(text: string): string {
	const values = LIMITATION_REASONS.map((reason) => `${reason} (${LIMITATION_REASON_MEANINGS[reason]})`).join("; ");
	return `limitation: reason ${JSON.stringify(text)} is not a reason value and nothing was recorded. The reason must be one of: ${values}. Call limitation again with reason set to exactly one of these values and the explanation in scope.`;
}

export const limitationTool: ToolSpec = {
	name: ToolNames.Limitation,
	description:
		"Record a check this turn needed but could not run here, and why: call it once before your final reply, including when you changed files but could not run validation. The receipt stands in for validation evidence at the finish gate.",
	parameters: Type.Object({
		scope: Type.String({ description: "What could not be verified, in one sentence." }),
		reason: StringEnum(LIMITATION_REASONS, {
			description: `${LIMITATION_REASON_TEXT.join("; ")}.`,
		}),
		paths: Type.Optional(
			Type.Array(Type.String(), {
				description: "Repository-relative paths left unverified, or for write-root the paths you need to write.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	// Small models write the reason as prose ("safety posture restricts git"),
	// fail validation, repeat it, and then invent a report file in the task
	// worktree instead. Keep the prose in scope and file it under the closest
	// category so the call passes the schema; run then refuses the first such
	// reason in a session with the reason list (row 382) and files later ones.
	prepareArguments: prepareLimitationArguments,
	async run(rawArgs, options): Promise<ToolResult> {
		const { [OFF_ENUM_REASON]: offEnum, ...args } = prepareLimitationArguments(rawArgs);
		const scope = trimString(args.scope);
		if (scope === null) return { kind: "error", message: "limitation: scope is required" };
		if (claimsToolsGone(scope)) {
			return { kind: "error", message: `limitation: ${TOOLS_OPEN_REFUSAL}`, details: { refusal: "tools_open" } };
		}
		if (!isLimitationReason(args.reason)) {
			return { kind: "error", message: `limitation: reason must be one of ${LIMITATION_REASONS.join(", ")}` };
		}
		if (typeof offEnum === "string" && firstOffEnumReason(options?.sessionId ?? options?.runId ?? "")) {
			return { kind: "error", message: offEnumRefusal(offEnum), details: { refusal: "reason_off_enum" } };
		}
		const paths = normalizePaths(args.paths);
		if (paths === null) return { kind: "error", message: "limitation: paths must be an array of non-empty strings" };
		const limitation: LimitationRecord = { scope, reason: args.reason, paths };
		const pathSuffix = paths.length > 0 ? ` paths=${paths.join(",")}` : "";
		return {
			kind: "ok",
			output: `limitation recorded: ${scope} (reason=${limitation.reason}${pathSuffix})\n`,
			details: { limitation },
		};
	},
};
