import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { isVerificationScriptName } from "../../core/verification-scripts.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { stringEnum } from "../string-enum.js";
import { BROWSER_MODES, runFrontendCheck } from "./frontend.js";
import { listChecks, runScriptCheck, VERIFICATION_SCRIPT_FAMILY_HINT } from "./scripts.js";

/**
 * The verify tool: one EXECUTE entry point for declared verification.
 * verify() lists declared checks, verify(check=<script>) runs a package.json
 * verification script via the safe-exec spine, verify(check="frontend",
 * path=<file>) validates an HTML/CSS/JS artifact without shell access.
 */

/** Tolerate the weak-model shape of `args` sent as a JSON string. */
function prepareVerifyArguments(args: Record<string, unknown>): Record<string, unknown> {
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

export const verifyTool: ToolSpec = {
	name: ToolNames.Verify,
	description:
		'Run a declared verification check: no arguments lists checks, check=<package.json script> runs it, check="frontend" with path validates an HTML/CSS/JS artifact.',
	parameters: Type.Object({
		check: Type.Optional(
			Type.String({
				description: `Declared script name (${VERIFICATION_SCRIPT_FAMILY_HINT}) or "frontend". Omit to list available checks.`,
			}),
		),
		path: Type.Optional(Type.String({ description: "check=frontend: artifact file under the workspace root." })),
		args: Type.Optional(Type.Array(Type.String(), { description: "Extra arguments passed after --." })),
		browser: Type.Optional(stringEnum(BROWSER_MODES, "check=frontend: headless browser mode (default auto).")),
		cwd: Type.Optional(Type.String({ description: "Working directory." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)." })),
		max_output_bytes: Type.Optional(Type.Number({ description: "Output cap in bytes (default 600000)." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	prepareArguments: prepareVerifyArguments,
	async run(rawArgs, options): Promise<ToolResult> {
		const args = prepareVerifyArguments(rawArgs);
		const check = typeof args.check === "string" ? args.check.trim() : "";
		if (check.length === 0) {
			return listChecks(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined);
		}
		if (check === "frontend") return runFrontendCheck(args, options);
		if (!isVerificationScriptName(check)) {
			return {
				kind: "error",
				message: `verify: '${check}' is not a verification check (${VERIFICATION_SCRIPT_FAMILY_HINT} or "frontend"); run it through bash.`,
			};
		}
		return runScriptCheck(check, args, options);
	},
};
