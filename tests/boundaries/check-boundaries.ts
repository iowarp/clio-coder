import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface BoundaryCheckResult {
	violations: string[];
}

const jsSuffixRegex = /\.m?jsx?$/;

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
}

function extractSpecifiers(source: string): ExtractedSpecifier[] {
	const stripped = stripComments(source);
	const specifiers: ExtractedSpecifier[] = [];

	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = /\btype\b/.test(clause);
		specifiers.push({ specifier, typeOnly });
	}

	const dynRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of stripped.matchAll(dynRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false });
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

function domainOf(filePath: string, domainsRoot: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

/**
 * Enforce the three static isolation rules:
 *   1. Only src/engine/** may value-import @mariozechner/pi-*. Type-only imports
 *      are allowed anywhere because types erase at compile time and the
 *      RuntimeDescriptor contract in src/domains/providers inherently surfaces
 *      Model<Api>.
 *   2. src/worker/** never imports src/domains/** EXCEPT src/domains/providers,
 *      which carries the pure-data EndpointDescriptor type and the runtime
 *      registry + built-in descriptors the worker re-hydrates from stdin.
 *   3. src/domains/<x> never imports src/domains/<y>/extension.ts for y != x.
 */
export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");
	const providersDomainRoot = path.join(domainsRoot, "providers");
	const harnessRoot = path.join(srcRoot, "harness");

	const violations: string[] = [];

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inHarness = isWithin(filePath, harnessRoot);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			if (specifier.startsWith("@mariozechner/pi-")) {
				if (!inEngine && !typeOnly) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (value import)`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);

			if (inWorker && isWithin(resolved, domainsRoot) && !isWithin(resolved, providersDomainRoot)) {
				if (!typeOnly) {
					violations.push(
						`rule2: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (value imports outside src/domains/providers are not permitted from the worker)`,
					);
				}
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

			if (inHarness) {
				if (isWithin(resolved, path.join(srcRoot, "engine")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/engine (harness must not import pi-mono engine)`,
					);
					return;
				}
				if (
					isWithin(resolved, domainsRoot) &&
					!typeOnly &&
					!isWithin(resolved, providersDomainRoot)
				) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (harness may only value-import src/core, src/tools/registry.ts, and node)`,
					);
					return;
				}
				if (isWithin(resolved, path.join(srcRoot, "interactive")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/interactive (harness must not reach into the TUI layer)`,
					);
					return;
				}
				if (isWithin(resolved, path.join(srcRoot, "worker")) && !typeOnly) {
					violations.push(
						`rule4: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/worker (harness is orchestrator-only)`,
					);
					return;
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
