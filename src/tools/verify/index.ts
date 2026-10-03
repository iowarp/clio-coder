import type { ToolResult, ToolSpec } from "../registry.js";
import { runFrontendCheck } from "./frontend.js";
import { captureQualitySnapshot, loadQualityPolicy, type QualitySnapshot } from "./quality-policy.js";
import { resolveVerifyCall } from "./resolve.js";
import { listChecks, runProjectCheck, runScriptCheck, runToolchainCheck, unavailableCheck } from "./scripts.js";
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
		const root = process.cwd();
		const loaded = loadQualityPolicy(root);
		if (!loaded.ok) return { kind: "error", message: `verify: ${loaded.reason}` };
		const policy = loaded.policy;
		const check = typeof args.check === "string" ? args.check.trim() : "";
		if (!check && policy) {
			const listed = listChecks(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined);
			if (listed.kind === "error") return listed;
			return {
				...listed,
				output: `${listed.output ?? ""}\n\nProject quality policy:\n${policy.rules.map((rule) => `- ${rule.id}: ${rule.paths.join(", ")} requires ${rule.checks.join(", ")}`).join("\n")}`,
				details: { ...listed.details, qualityPolicy: policy },
			};
		}
		const applies = policy?.rules.some((rule) => rule.checks.includes(check)) === true;
		let before: QualitySnapshot | undefined;
		let snapshotError: string | undefined;
		if (
			applies &&
			policy &&
			args.cwd === undefined &&
			(args.args === undefined || (Array.isArray(args.args) && args.args.length === 0))
		) {
			try {
				before = captureQualitySnapshot(root, policy, check);
			} catch (error) {
				snapshotError = error instanceof Error ? error.message : String(error);
			}
		}
		const result = await runResolvedVerify(args, options);
		if (!applies || !policy) return result;
		let stable = false;
		if (before) {
			try {
				const afterPolicy = loadQualityPolicy(root);
				stable =
					afterPolicy.ok &&
					afterPolicy.policy !== null &&
					JSON.stringify(before) === JSON.stringify(captureQualitySnapshot(root, afterPolicy.policy, check));
			} catch (error) {
				snapshotError = error instanceof Error ? error.message : String(error);
			}
		}
		return {
			...result,
			details: {
				...result.details,
				quality: { stable, ...(before ? { snapshot: before } : {}), ...(snapshotError ? { error: snapshotError } : {}) },
			},
		};
	},
};

async function runResolvedVerify(
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
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
		case "unavailable":
			return unavailableCheck(resolution.check);
		case "unresolved":
			return { kind: "error", message: `verify: ${resolution.message}` };
	}
}
