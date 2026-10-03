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

export const LIMITATION_REASONS = ["no-runner", "blocked", "out-of-scope", "environment", "other"] as const;

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

export const limitationTool: ToolSpec = {
	name: ToolNames.Limitation,
	description:
		"Record what this turn could not verify and why: call it once before your final reply when you changed files but could not run validation. The receipt stands in for validation evidence at the finish gate.",
	parameters: Type.Object({
		scope: Type.String({ description: "What could not be verified." }),
		reason: StringEnum(LIMITATION_REASONS, {
			description:
				"no-runner: no runner exists; blocked: a gate or denial stopped the check; out-of-scope: the task excluded it; environment: it cannot run here; other.",
		}),
		paths: Type.Optional(Type.Array(Type.String(), { description: "Paths left unverified." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	// Small models write the reason as prose ("safety posture restricts git"),
	// fail validation, repeat it, and then invent a report file in the task
	// worktree instead. Keep the prose in scope and file it under the closest
	// category so the one call that records the limitation lands.
	prepareArguments(args) {
		const reason = args.reason;
		if (typeof reason !== "string" || isLimitationReason(reason)) return args;
		const text = reason.trim();
		if (isLimitationReason(text)) return { ...args, reason: text };
		const scope = trimString(args.scope);
		return {
			...args,
			scope: scope === null ? text : text.length > 0 ? `${scope} (${text})` : scope,
			reason: /\b(block|den(y|ied)|permission|policy|safety|approval)/iu.test(text) ? "blocked" : "other",
		};
	},
	async run(args): Promise<ToolResult> {
		const scope = trimString(args.scope);
		if (scope === null) return { kind: "error", message: "limitation: scope is required" };
		if (!isLimitationReason(args.reason)) {
			return { kind: "error", message: `limitation: reason must be one of ${LIMITATION_REASONS.join(", ")}` };
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
