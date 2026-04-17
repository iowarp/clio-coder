import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Engine + worker + domain isolation enforcement.
 *
 * Rule 1: only files under src/engine/** may import from @mariozechner/pi-*.
 *         NO EXCEPTIONS. Worker-side pi-mono usage goes through engine-owned
 *         modules such as src/engine/worker-runtime.ts.
 * Rule 2: src/worker/** never imports from src/domains/**.
 * Rule 3: src/domains/<x>/** never imports src/domains/<y>/extension.ts or
 *         src/domains/<y>/<x>/extension.ts for any y != x. Cross-domain access
 *         flows through SafeEventBus or through contracts exposed from
 *         src/domains/<y>/index.ts (query-only surface).
 *
 * Exits 1 on any violation with a human-readable report.
 */

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const engineRoot = path.join(srcRoot, "engine");
const workerRoot = path.join(srcRoot, "worker");
const domainsRoot = path.join(srcRoot, "domains");

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

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const regex = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of source.matchAll(regex)) {
		const specifier = match[1] ?? match[2];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const tsRewrites: string[] = [];
	const jsSuffix = /\.m?jsx?$/;
	if (jsSuffix.test(candidate)) {
		const stripped = candidate.replace(jsSuffix, "");
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

function domainOf(filePath: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

const violations: string[] = [];

for (const filePath of walk(srcRoot)) {
	const source = readFileSync(filePath, "utf8");
	const specifiers = extractSpecifiers(source);
	const inEngine = isWithin(filePath, engineRoot);
	const inWorker = isWithin(filePath, workerRoot);
	const fromDomain = domainOf(filePath);

	for (const specifier of specifiers) {
		// Rule 1: pi-mono imports outside src/engine/**. No exceptions.
		if (specifier.startsWith("@mariozechner/pi-")) {
			if (!inEngine) {
				violations.push(
					`rule1: ${path.relative(projectRoot, filePath)} imports ${specifier} outside src/engine`,
				);
			}
			continue;
		}

		if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
		const resolved = resolveRelativeImport(filePath, specifier);

		// Rule 2: worker importing from domains
		if (inWorker && isWithin(resolved, domainsRoot)) {
			violations.push(
				`rule2: ${path.relative(projectRoot, filePath)} imports ${specifier} which resolves inside src/domains`,
			);
			continue;
		}

		// Rule 3: cross-domain extension.ts import
		if (fromDomain) {
			const toDomain = domainOf(resolved);
			if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
				violations.push(
					`rule3: ${path.relative(projectRoot, filePath)} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
				);
			}
		}
	}
}

if (violations.length > 0) {
	console.error("Boundary violations:");
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log("boundaries: OK");
