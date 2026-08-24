import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { declaredVerificationScripts, VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import type { ToolResult } from "../registry.js";
import { runVectorTool } from "../safe-exec.js";
import {
	type DeclaredCheck,
	type DeclaredCheckSource,
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	packageDeclaredCheck,
	resolveProjectVerifierExecutionCwd,
} from "./catalog.js";

/**
 * Package scripts and the project catalog meet here as one canonical check
 * projection. Project checks retain their admitted argv/cwd/timeout exactly;
 * package scripts keep the established npm argument-widening behavior.
 */

export type DeclaredCheckDiscoveryResult = { ok: true; sources: DeclaredCheckSource[] } | { ok: false; reason: string };

export interface DeclaredProjectEntry {
	id: string;
	command: string[];
	path: string;
	detail: string;
	kind: "package-script" | "just-recipe" | "make-target";
}

function repositoryRelativeCwd(workspaceRoot: string, resolved: string): string {
	const relative = path.relative(workspaceRoot, resolved);
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function packageTag(id: string): string[] {
	const separator = id.search(/[:.-]/u);
	return [separator === -1 ? id : id.slice(0, separator)];
}

function packageCheckSource(packageRoot: string, workspaceRoot: string): DeclaredCheckSource | null {
	const packagePath = path.join(packageRoot, "package.json");
	if (!existsSync(packagePath)) return null;
	const pkg = parsePackageJson(packagePath);
	if (!pkg.ok) return null;
	const cwd = repositoryRelativeCwd(workspaceRoot, packageRoot);
	const checks = declaredVerificationScripts(pkg.scripts).map((id) =>
		packageDeclaredCheck(id, packagePath, cwd, packageTag(id)),
	);
	return { kind: "package.json", path: packagePath, checks };
}

/** Discover every exact project-declared entry without promoting it to a verifier check. */
export function discoverDeclaredProjectEntriesAtRoot(workspaceRoot: string): DeclaredProjectEntry[] {
	const entries: DeclaredProjectEntry[] = [];
	const packagePath = path.join(workspaceRoot, "package.json");
	if (existsSync(packagePath)) {
		const pkg = parsePackageJson(packagePath);
		if (pkg.ok) {
			for (const name of Object.keys(pkg.scripts).sort()) {
				if (typeof pkg.scripts[name] !== "string") continue;
				entries.push({
					id: name,
					command: ["npm", "run", name],
					path: "package.json",
					detail: `package.json script '${name}'`,
					kind: "package-script",
				});
			}
		}
	}
	for (const relative of ["justfile", "Justfile"] as const) {
		const filePath = path.join(workspaceRoot, relative);
		if (!existsSync(filePath)) continue;
		const text = readFileSync(filePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:[^:=\n]*)?:\s*(?:#.*)?$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith("_")) continue;
			entries.push({
				id: name,
				command: ["just", name],
				path: relative,
				detail: `just recipe '${name}'`,
				kind: "just-recipe",
			});
		}
		break;
	}
	const makePath = path.join(workspaceRoot, "Makefile");
	if (existsSync(makePath)) {
		const text = readFileSync(makePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=])[^\n]*$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith(".")) continue;
			entries.push({
				id: name,
				command: ["make", name],
				path: "Makefile",
				detail: `Makefile target '${name}'`,
				kind: "make-target",
			});
		}
	}
	return entries;
}

function providerCollision(sources: ReadonlyArray<DeclaredCheckSource>): string | null {
	const seen = new Map<string, DeclaredCheck>();
	for (const source of sources) {
		for (const check of source.checks) {
			const prior = seen.get(check.id);
			if (prior !== undefined) {
				return (
					`duplicate declared check id '${check.id}' from ` +
					`${prior.source.kind} (${prior.source.path}) and ${check.source.kind} (${check.source.path})`
				);
			}
			seen.set(check.id, check);
		}
	}
	return null;
}

export function discoverDeclaredChecksAtRoot(
	workspaceRoot: string,
	cwdArg: string | undefined,
): DeclaredCheckDiscoveryResult {
	let packageRoot: string;
	try {
		packageRoot = resolveSafeCwd(cwdArg, workspaceRoot);
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	const sources: DeclaredCheckSource[] = [];
	const packageSource = packageCheckSource(packageRoot, workspaceRoot);
	if (packageSource !== null) sources.push(packageSource);
	const projectCatalog = loadProjectVerifierCatalog(workspaceRoot);
	if (!projectCatalog.ok) return projectCatalog;
	if (projectCatalog.source !== null) sources.push(projectCatalog.source);
	const collision = providerCollision(sources);
	if (collision !== null) return { ok: false, reason: collision };
	return { ok: true, sources };
}

export function discoverDeclaredChecks(cwdArg: string | undefined): DeclaredCheckDiscoveryResult {
	return discoverDeclaredChecksAtRoot(process.cwd(), cwdArg);
}

function clonedSources(sources: ReadonlyArray<DeclaredCheckSource>): DeclaredCheckSource[] {
	return sources.map((source) => ({
		kind: source.kind,
		path: source.path,
		checks: source.checks.map((check) => ({
			...check,
			command: [...check.command],
			tags: [...check.tags],
			source: { ...check.source },
		})),
	}));
}

export function listChecks(cwdArg: string | undefined): ToolResult {
	const discovery = discoverDeclaredChecks(cwdArg);
	if (!discovery.ok) return { kind: "error", message: `verify: ${discovery.reason}` };
	const lines: string[] = [];
	if (discovery.sources.length === 0 || discovery.sources.every((source) => source.checks.length === 0)) {
		lines.push(
			`No declared verification checks found (no package.json verification scripts or ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} entries).`,
			"Run `clio-coder verifiers author` to inspect declared project tooling, preview exact argv checks, and create the catalog after confirmation.",
		);
	} else {
		lines.push("Declared verification checks:");
		for (const source of discovery.sources) {
			lines.push(source.kind === "package.json" ? "package.json:" : `${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}:`);
			for (const check of source.checks) {
				const tags = check.tags.length > 0 ? ` [${check.tags.join(", ")}]` : "";
				lines.push(`- ${check.id}${tags}: ${check.description}`);
			}
		}
	}
	lines.push(
		"",
		'Run one with verify(check="<id>"). verify(check="frontend", path=<file>) validates an HTML/CSS/JS artifact.',
	);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: { sources: clonedSources(discovery.sources) },
	};
}

function withDeclaredEvidence(result: ToolResult, check: DeclaredCheck): ToolResult {
	return {
		...result,
		details: {
			...result.details,
			action: "verify",
			check: check.id,
			source: { ...check.source },
			description: check.description,
			declaredCommand: [...check.command],
			declaredCwd: check.cwd,
			declaredTimeoutMs: check.timeoutMs,
			tags: [...check.tags],
		},
	};
}

export async function runProjectCheck(check: DeclaredCheck, options?: { signal?: AbortSignal }): Promise<ToolResult> {
	const [file, ...vector] = check.command;
	if (file === undefined) return { kind: "error", message: `verify: declared check '${check.id}' has empty argv` };
	const cwd = resolveProjectVerifierExecutionCwd(check.cwd, process.cwd());
	if (cwd instanceof Error) return { kind: "error", message: `verify: ${cwd.message}` };
	const result = await runVectorTool("verify", file, vector, { cwd, timeout_ms: check.timeoutMs }, options);
	return withDeclaredEvidence(result, check);
}

export async function runScriptCheck(
	check: string,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined, process.cwd());
	} catch (error) {
		return { kind: "error", message: `verify: ${error instanceof Error ? error.message : String(error)}` };
	}
	const packagePath = path.join(cwd, "package.json");
	if (!existsSync(packagePath)) return { kind: "error", message: `verify: package.json not found in ${cwd}` };
	const pkg = parsePackageJson(packagePath);
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
	packagePath: string,
): { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string } {
	try {
		const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: "package.json root must be an object" };
		}
		const scripts = (parsed as Record<string, unknown>).scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
			return { ok: false, reason: "package.json has no scripts object" };
		}
		return { ok: true, scripts: scripts as Record<string, unknown> };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
