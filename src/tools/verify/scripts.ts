import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { declaredVerificationScripts, VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import type { ToolResult } from "../registry.js";
import { runVectorTool } from "../safe-exec.js";

/**
 * verify(check=<script>): run one declared package.json verification script
 * through npm with no shell, and verify() with no check: list what is
 * declared. Internal module of the verify tool. The listing shape is grouped
 * by source so later check providers (Makefile, justfile, pixi) can add their
 * own groups without changing the surface.
 */

export interface DeclaredCheckSource {
	kind: "package.json";
	path: string;
	checks: string[];
}

export function declaredCheckSources(cwd: string): DeclaredCheckSource[] {
	const pkgPath = path.join(cwd, "package.json");
	if (!existsSync(pkgPath)) return [];
	const pkg = parsePackageJson(pkgPath);
	if (!pkg.ok) return [];
	return [{ kind: "package.json", path: pkgPath, checks: declaredVerificationScripts(pkg.scripts) }];
}

export function listChecks(cwdArg: string | undefined): ToolResult {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(cwdArg, process.cwd());
	} catch (err) {
		return { kind: "error", message: `verify: ${err instanceof Error ? err.message : String(err)}` };
	}
	const sources = declaredCheckSources(cwd);
	const lines: string[] = [];
	if (sources.length === 0 || sources.every((source) => source.checks.length === 0)) {
		lines.push("No declared verification checks found (no package.json verification scripts).");
	} else {
		lines.push("Declared verification checks:");
		for (const source of sources) {
			lines.push(`${source.kind}:`);
			for (const check of source.checks) lines.push(`- ${check}`);
		}
	}
	lines.push(
		"",
		'Run one with verify(check="<name>"). verify(check="frontend", path=<file>) validates an HTML/CSS/JS artifact.',
	);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: { sources: sources.map((source) => ({ ...source })) },
	};
}

export async function runScriptCheck(
	check: string,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined, process.cwd());
	} catch (err) {
		return { kind: "error", message: `verify: ${err instanceof Error ? err.message : String(err)}` };
	}
	const pkgPath = path.join(cwd, "package.json");
	if (!existsSync(pkgPath)) return { kind: "error", message: `verify: package.json not found in ${cwd}` };
	const pkg = parsePackageJson(pkgPath);
	if (!pkg.ok) return { kind: "error", message: `verify: ${pkg.reason}` };
	if (!Object.hasOwn(pkg.scripts, check)) {
		const declared = declaredVerificationScripts(pkg.scripts);
		const list = declared.length > 0 ? declared.join(", ") : "(none)";
		return {
			kind: "error",
			message: `verify: package.json has no '${check}' script. Declared verification checks: ${list}.`,
		};
	}
	const extraArgs = Array.isArray(args.args)
		? args.args.filter((entry): entry is string => typeof entry === "string")
		: [];
	const vector = ["run", check];
	if (extraArgs.length > 0) vector.push("--", ...extraArgs);
	return runVectorTool("verify", "npm", vector, { ...args, cwd }, options);
}

export { VERIFICATION_SCRIPT_FAMILY_HINT };

function parsePackageJson(
	pkgPath: string,
): { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string } {
	try {
		const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: "package.json root must be an object" };
		}
		const scripts = (parsed as Record<string, unknown>).scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
			return { ok: false, reason: "package.json has no scripts object" };
		}
		return { ok: true, scripts: scripts as Record<string, unknown> };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}
