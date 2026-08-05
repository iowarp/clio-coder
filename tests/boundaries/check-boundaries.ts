import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface BoundaryCheckResult {
	violations: string[];
}

const jsSuffixRegex = /\.m?jsx?$/;
const piPackagePrefix = "@earendil-works/pi-";
// Since the 0.83.0 engine-boundary rework, no file outside src/engine/** may
// import @earendil-works/* at all, type-only included. Domains take erased
// engine shapes (EngineModel, Api, Model) from src/engine/types.ts.
const allowedPiTypeImportSpecifiersOutsideEngine = new Set<string>();

function walk(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
			continue;
		}
		if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stripComments(source: string): string {
	let out = source.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/(^|[^:/])\/\/.*$/gm, (_match, prefix) => prefix);
	return out;
}

function extractReferenceDirectives(source: string): { kind: "path" | "types"; specifier: string }[] {
	const directives: { kind: "path" | "types"; specifier: string }[] = [];
	const regex = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']\s*\/?>/gm;
	for (const match of source.matchAll(regex)) {
		const kind = match[1] as "path" | "types";
		const specifier = match[2];
		if (specifier) directives.push({ kind, specifier });
	}
	return directives;
}

interface ExtractedSpecifier {
	specifier: string;
	typeOnly: boolean;
	dynamic: boolean;
}

function isTypeOnlyImportOrExportClause(clause: string): boolean {
	return clause.trim().startsWith("type ");
}

function extractSpecifiers(source: string): ExtractedSpecifier[] {
	const stripped = stripComments(source);
	const specifiers: ExtractedSpecifier[] = [];

	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = isTypeOnlyImportOrExportClause(clause);
		specifiers.push({ specifier, typeOnly, dynamic: false });
	}

	const dynRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of stripped.matchAll(dynRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false, dynamic: true });
	}

	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const tsRewrites: string[] = [];
	if (jsSuffixRegex.test(candidate)) {
		const stripped = candidate.replace(jsSuffixRegex, "");
		tsRewrites.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`);
	}
	const candidates = [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
		...tsRewrites,
	];
	for (const item of candidates) {
		try {
			if (statSync(item).isFile()) return item;
		} catch {
			// skip
		}
	}
	return candidate;
}

/**
 * The chat loop's turn state machine and its single-owner turn modules.
 * Other interactive files (overlays, panels, the composition root in
 * index.ts) legitimately know about entry-level wiring; these do not.
 */
function isChatLoopTurnModule(filePath: string): boolean {
	const base = path.basename(filePath);
	return base === "chat-loop.ts" || (base.startsWith("turn-") && base.endsWith(".ts"));
}

function domainOf(filePath: string, domainsRoot: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

function isAllowedWorkerProviderValueImport(resolved: string, providersDomainRoot: string): boolean {
	const allowedFiles = new Set([
		path.join(providersDomainRoot, "plugins.ts"),
		path.join(providersDomainRoot, "registry.ts"),
		path.join(providersDomainRoot, "runtimes", "builtins.ts"),
	]);
	return allowedFiles.has(resolved);
}

/**
 * Enforce the static isolation rules:
 *   1. Only src/engine/** may import @earendil-works/pi-* at all. Since the
 *      0.83.0 engine-boundary rework there is no type-only exception either:
 *      domains take erased engine shapes from src/engine/types.ts.
 *   2. src/worker/** never value-imports src/domains/** EXCEPT the worker-safe
 *      provider runtime registry, builtin descriptors, and plugin loader used
 *      to rehydrate runtime descriptors from stdin. Type-only imports are
 *      allowed because they erase at compile time.
 *   3. src/domains/<x> never imports src/domains/<y>/extension.ts for y != x.
 *   4. src/tools/** never imports src/interactive/**. The tool substrate is
 *      surface-agnostic: headless, interactive, ACP, and worker runs share it,
 *      so a tool reaching into TUI code would make one surface's presentation
 *      a dependency of every surface's execution.
 *   5. The chat loop's turn modules (src/interactive/turn-*.ts, chat-loop.ts)
 *      never import src/entry/**. Composition flows one way: the entry point
 *      composes the loop, never the reverse.
 */
export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");
	const providersDomainRoot = path.join(domainsRoot, "providers");
	const toolsRoot = path.join(srcRoot, "tools");
	const interactiveRoot = path.join(srcRoot, "interactive");
	const entryRoot = path.join(srcRoot, "entry");

	const violations: string[] = [];

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inTools = isWithin(filePath, toolsRoot);
		const isChatLoopModule = isWithin(filePath, interactiveRoot) && isChatLoopTurnModule(filePath);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			if (specifier.startsWith(piPackagePrefix)) {
				if (!inEngine && !typeOnly) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (value import)`,
					);
				}
				if (!inEngine && typeOnly && !allowedPiTypeImportSpecifiersOutsideEngine.has(specifier)) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (type-only import is not explicitly allowed)`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);

			if (inWorker && isWithin(resolved, domainsRoot)) {
				if (!typeOnly && !isAllowedWorkerProviderValueImport(resolved, providersDomainRoot)) {
					violations.push(
						`rule2: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (worker value imports are limited to provider runtime rehydration modules)`,
					);
				}
				return;
			}

			if (inTools && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule4: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; the tool substrate is surface-agnostic`,
				);
				return;
			}

			if (isChatLoopModule && isWithin(resolved, entryRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule5: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/entry; the entry point composes the chat loop, never the reverse`,
				);
				return;
			}

			if (fromDomain) {
				const toDomain = domainOf(resolved, domainsRoot);
				if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule3: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
					);
				}
			}
		};

		for (const { specifier, typeOnly } of specifiers) {
			evaluate(specifier, typeOnly, "import");
		}

		for (const ref of references) {
			if (ref.kind === "types") {
				evaluate(ref.specifier, true, "reference");
			} else {
				const spec = ref.specifier.startsWith(".") || ref.specifier.startsWith("/") ? ref.specifier : `./${ref.specifier}`;
				evaluate(spec, true, "reference");
			}
		}
	}

	return { violations };
}
