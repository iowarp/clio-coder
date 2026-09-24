import { existsSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { declaredVerificationScripts } from "../../core/verification-scripts.js";
import {
	type DeclaredCheck,
	type DeclaredCheckSource,
	loadProjectVerifierCatalog,
	packageDeclaredCheck,
} from "./catalog.js";
import { parsePackageJson } from "./toolchain.js";

/**
 * Package scripts and the project catalog meet here as one canonical check
 * projection. Kept apart from the runners so the safety policy engine can
 * resolve a verify call without loading them.
 */

export type DeclaredCheckDiscoveryResult = { ok: true; sources: DeclaredCheckSource[] } | { ok: false; reason: string };

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
