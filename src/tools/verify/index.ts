import { isVerificationScriptName } from "../../core/verification-scripts.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { runFrontendCheck } from "./frontend.js";
import { listChecks, runScriptCheck, VERIFICATION_SCRIPT_FAMILY_HINT } from "./scripts.js";
import { prepareVerifyArguments, verifyToolSurface } from "./surface.js";

/**
 * The verify tool: one EXECUTE entry point for declared verification.
 * verify() lists declared checks, verify(check=<script>) runs a package.json
 * verification script via the safe-exec spine, verify(check="frontend",
 * path=<file>) validates an HTML/CSS/JS artifact without shell access.
 */

export const verifyTool: ToolSpec = {
	...verifyToolSurface,
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
