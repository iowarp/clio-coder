import { isVerificationScriptName } from "../../core/verification-scripts.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { runFrontendCheck } from "./frontend.js";
import {
	discoverDeclaredChecks,
	listChecks,
	runProjectCheck,
	runScriptCheck,
	VERIFICATION_SCRIPT_FAMILY_HINT,
} from "./scripts.js";
import { prepareVerifyArguments, verifyToolSurface } from "./surface.js";

/**
 * The verify tool: one EXECUTE entry point for declared verification.
 * verify() lists canonical checks, verify(check=<id>) runs a package script or
 * exact project-catalog vector via safe-exec, and verify(check="frontend",
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
		const discovery = discoverDeclaredChecks(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined);
		if (!discovery.ok) return { kind: "error", message: `verify: ${discovery.reason}` };
		const declared = discovery.sources.flatMap((source) => source.checks).find((candidate) => candidate.id === check);
		if (declared?.source.kind === "project-catalog") return runProjectCheck(declared, options);
		if (!isVerificationScriptName(check)) {
			return {
				kind: "error",
				message: `verify: '${check}' is not a verification check (${VERIFICATION_SCRIPT_FAMILY_HINT} or "frontend"); run it through bash.`,
			};
		}
		return runScriptCheck(check, args, options);
	},
};
