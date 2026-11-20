import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";

export const BROWSER_MODES = ["auto", "required", "off"] as const;

/** Tolerate the weak-model shape of `args` sent as a JSON string. */
export function prepareVerifyArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	if (typeof next.args === "string") {
		try {
			const parsed = JSON.parse(next.args) as unknown;
			if (Array.isArray(parsed)) next.args = parsed;
		} catch {
			// Leave the malformed string; runScriptCheck ignores non-arrays.
		}
	}
	return next;
}

/**
 * A call that names no check only lists the declared checks. It runs nothing, so it is never validation evidence; the
 * resolver and every reader of verify outcomes decide a listing through this one predicate.
 */
export function isVerifyListing(args: unknown): boolean {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
	const check = (args as Record<string, unknown>).check;
	return typeof check !== "string" || check.trim().length === 0;
}

export const verifyToolSurface: ToolSurface = {
	name: ToolNames.Verify,
	description:
		'Run a declared or build/CI-derived check; an undeclared id lists them. check="frontend" validates the HTML/CSS/JS artifact at path.',
	parameters: Type.Object({
		check: Type.Optional(
			Type.String({
				description: `Check id, package script (${VERIFICATION_SCRIPT_FAMILY_HINT}), or "frontend"; omit to list.`,
			}),
		),
		path: Type.Optional(Type.String({ description: "frontend: artifact file in the workspace." })),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Extra args: after -- for package scripts, else appended.",
			}),
		),
		browser: Type.Optional(StringEnum(BROWSER_MODES, { description: "frontend: browser mode." })),
		cwd: Type.Optional(Type.String({ description: "Package script cwd." })),
		unsandboxed: Type.Optional(
			Type.Boolean({
				description: "Leave the sandbox only after it failed a check (credentials, unwritable paths); reviewed.",
			}),
		),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms (not declared checks)." })),
		max_output_bytes: Type.Optional(
			Type.Number({
				description: "Returned-text cap.",
			}),
		),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	steerInterruptible: true,
	prepareArguments: prepareVerifyArguments,
};
