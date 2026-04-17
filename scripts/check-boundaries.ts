import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Engine + worker + domain isolation enforcement.
 *
 * # Rules
 *
 * Rule 1: only files under src/engine/** may import from @mariozechner/pi-*.
 *         NO EXCEPTIONS. Worker-side pi-mono usage goes through engine-owned
 *         modules such as src/engine/worker-runtime.ts. `import type` from
 *         pi-* is ALSO forbidden outside the engine. Types leak pi-mono
 *         symbol names into domain code and convert a pi-mono rename into a
 *         domain-wide breakage, which is the exact coupling the engine
 *         boundary exists to prevent.
 *
 * Rule 2: src/worker/** never imports from src/domains/**. `import type`
 *         counts. Worker-side code has zero business referencing domain
 *         internals, even for type shapes. Shared types between orchestrator
 *         and worker live in src/contracts/** (to be introduced in Phase 6).
 *
 * Rule 3: src/domains/<x>/** never imports src/domains/<y>/extension.ts for
 *         any y != x. Cross-domain access flows through SafeEventBus or
 *         through the contract exposed from src/domains/<y>/index.ts
 *         (query-only surface). `import type` counts. The contract file is
 *         the documented type surface, so even types must come from
 *         index.ts, not extension.ts.
 *
 * # What IS caught
 *
 * - Static `from "X"` imports (ESM + type-only via the `from` keyword).
 * - Static `import("X")` dynamic imports with quoted string-literal specifiers.
 * - Re-export chains: `export * from "X"` and `export { Foo } from "X"`
 *   (the regex anchors on the `from` keyword, which covers both cases).
 * - Type-only imports: `import type { Foo } from "X"` and `export type { Foo } from "X"`
 *   (same anchoring). Type-only status does NOT grant a cross-boundary carve-out
 *   (see rule rationales above).
 * - Triple-slash directives with string-literal targets:
 *     `/// <reference path="...">`    (relative path, treated like a local import)
 *     `/// <reference types="...">`   (package name, treated like a bare import)
 *
 * # What is NOT caught (intentionally)
 *
 * - Dynamic imports with template literals: `import(`${x}`)`. The specifier
 *   is not known statically, so the script cannot classify it. Any such
 *   call must go through human review; if Phase 2+ ever introduces one,
 *   document it in the audit and add a carve-out or refactor.
 * - Dynamic imports with concatenation: `import("foo" + suffix)`. Same
 *   reasoning applies because there is no static string to inspect.
 * - Indirect imports through `require()` in TS source. Clio is pure ESM
 *   TypeScript; `require` should never appear in src/. If it does, the
 *   script will not flag the specifier, but tsc will reject the call.
 * - JSDoc `@import` and other documentation-only references. These do not
 *   produce runtime code and are rare in Clio; if a future phase adopts
 *   JSDoc-driven typing, revisit this decision.
 *
 * # Exit behavior
 *
 * When run as a script (this file is the entrypoint), exits 1 on any
 * violation with a human-readable report, or logs `boundaries: OK` and
 * exits 0 otherwise. When imported as a module, `runBoundaryCheck` returns
 * the violation list without touching process state.
 */

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

/**
 * Strip block comments and line comments from TS source before scanning for
 * specifiers. Triple-slash directives (`/// <reference ...>`) are NOT stripped
 * because they are semantically meaningful for the reference-directive rule;
 * caller extracts those BEFORE invoking this stripper.
 *
 * This is intentionally a simple regex strip, not a full TS parser. It can be
 * fooled by strings that contain comment markers; in practice Clio sources
 * don't do this, and a real parser is overkill for a boundary gate.
 */
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

	// Static `import ... from "X"` and `export ... from "X"`. Captures the
	// full clause before `from` so we can spot a type-only qualifier.
	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = /\btype\b/.test(clause);
		specifiers.push({ specifier, typeOnly });
	}

	// Dynamic `import("X")` with a quoted string literal specifier. Template
	// literals and concatenation are intentionally not matched (see header).
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

export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");

	const violations: string[] = [];

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			// Rule 1: pi-mono imports outside src/engine/**. No exceptions, including type-only.
			if (specifier.startsWith("@mariozechner/pi-")) {
				if (!inEngine) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} outside src/engine`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);

			// Rule 2: worker importing from domains. Type-only counts.
			if (inWorker && isWithin(resolved, domainsRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule2: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/domains`,
				);
				return;
			}

			// Rule 3: cross-domain extension.ts import. Type-only counts; the contract
			// file (index.ts) is the documented cross-domain type surface.
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

		// Triple-slash reference directives. `types=` targets a bare package
		// name (treat like a static import for rule 1); `path=` targets a
		// relative path (treat like a local import for rules 2 and 3).
		for (const ref of references) {
			if (ref.kind === "types") {
				evaluate(ref.specifier, true, "reference");
			} else {
				// path= is always relative; normalize to ./ prefix if missing
				// so resolveRelativeImport treats it as relative.
				const spec = ref.specifier.startsWith(".") || ref.specifier.startsWith("/") ? ref.specifier : `./${ref.specifier}`;
				evaluate(spec, true, "reference");
			}
		}
	}

	return { violations };
}

function isMain(): boolean {
	if (typeof process === "undefined" || !process.argv[1]) return false;
	try {
		const entryUrl = new URL(`file://${path.resolve(process.argv[1])}`).href;
		return import.meta.url === entryUrl;
	} catch {
		return false;
	}
}

if (isMain()) {
	const projectRoot = process.cwd();
	const { violations } = runBoundaryCheck(projectRoot);
	if (violations.length > 0) {
		console.error("Boundary violations:");
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log("boundaries: OK");
}
