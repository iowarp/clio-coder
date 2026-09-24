import type { ToolResult, ToolSpec } from "../registry.js";
import { runFrontendCheck } from "./frontend.js";
import { resolveVerifyCall } from "./resolve.js";
import { listChecks, runProjectCheck, runScriptCheck, runToolchainCheck } from "./scripts.js";
import { prepareVerifyArguments, verifyToolSurface } from "./surface.js";

/**
 * The verify tool: one EXECUTE entry point for declared verification.
 * verify() lists canonical checks, verify(check=<id>) runs a package script,
 * an exact project-catalog vector, or a check derived from the repository's
 * toolchain and CI files via safe-exec, and verify(check="frontend",
 * path=<file>) validates an HTML/CSS/JS artifact without shell access.
 * resolveVerifyCall is shared with the safety policy engine, so the command
 * admitted is the command run.
 */

export const verifyTool: ToolSpec = {
	...verifyToolSurface,
	async run(rawArgs, options): Promise<ToolResult> {
		const args = prepareVerifyArguments(rawArgs);
		const resolution = resolveVerifyCall(process.cwd(), args);
		switch (resolution.kind) {
			case "list":
				return listChecks(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined);
			case "frontend":
				return runFrontendCheck(args, options);
			case "catalog":
				return runProjectCheck(resolution.check, options);
			case "package": {
				const result = await runScriptCheck(resolution.check.id, args, options);
				return {
					...result,
					details: { ...result.details, check: resolution.check.id, source: { ...resolution.check.source } },
				};
			}
			case "toolchain":
				return runToolchainCheck(resolution.check, resolution.argv, args, options);
			case "unresolved":
				return { kind: "error", message: `verify: ${resolution.message}` };
		}
	},
};
