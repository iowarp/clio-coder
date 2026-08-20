#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
] as const;

const SNAPSHOT_SCHEMA_VERSION = 1;

export interface PiSurfaceEntryPoint {
	declaration: string;
	exports: Record<string, string>;
}

export interface PiSurfacePackage {
	version: string;
	entryPoints: Record<string, PiSurfaceEntryPoint>;
}

export interface PiSurfaceSnapshot {
	schemaVersion: number;
	packages: Record<string, PiSurfacePackage>;
}

export interface PiSurfaceImports {
	[specifier: string]: ReadonlyArray<string>;
}

export interface PiSurfaceComparison {
	errors: string[];
	infos: string[];
}

interface PackageJson {
	version: string;
	types?: string;
	exports?: Record<string, unknown>;
}

function filesUnder(dir: string, suffix: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(absolute);
		}
	};
	walk(dir);
	return found.sort();
}

function piPackageForSpecifier(specifier: string): (typeof PI_PACKAGES)[number] | null {
	for (const packageName of PI_PACKAGES) {
		if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return packageName;
	}
	return null;
}

function entryPointForSpecifier(packageName: string, specifier: string): string {
	return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

function collectClioPiImports(root: string): Map<string, Set<string>> {
	const imports = new Map<string, Set<string>>();
	for (const absolute of filesUnder(join(root, "src"), ".ts")) {
		const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
		for (const statement of source.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
				const specifier = statement.moduleSpecifier.text;
				if (piPackageForSpecifier(specifier) === null) continue;
				const names = imports.get(specifier) ?? new Set<string>();
				const clause = statement.importClause;
				if (clause?.name) names.add("default");
				if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add("*");
				if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements) names.add((element.propertyName ?? element.name).text);
				}
				imports.set(specifier, names);
				continue;
			}
			if (
				ts.isExportDeclaration(statement) &&
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier)
			) {
				const specifier = statement.moduleSpecifier.text;
				if (piPackageForSpecifier(specifier) === null) continue;
				const names = imports.get(specifier) ?? new Set<string>();
				if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
					for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
				} else {
					names.add("*");
				}
				imports.set(specifier, names);
			}
		}
	}
	return imports;
}

function packageJson(root: string, packageName: string): PackageJson {
	const path = join(root, "node_modules", ...packageName.split("/"), "package.json");
	return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function typesTarget(value: unknown): string | null {
	if (typeof value === "string" && value.endsWith(".d.ts")) return value;
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.types === "string") return record.types;
	for (const condition of ["import", "default", "node"]) {
		const found = typesTarget(record[condition]);
		if (found !== null) return found;
	}
	return null;
}

function declarationTarget(packageName: string, pkg: PackageJson, entryPoint: string): string {
	if (entryPoint === "." && pkg.exports === undefined && pkg.types) return pkg.types;
	const exportsMap = pkg.exports;
	if (!exportsMap) throw new Error(`${packageName} does not declare exports for ${entryPoint}`);
	const direct = typesTarget(exportsMap[entryPoint]);
	if (direct !== null) return direct;
	for (const [pattern, value] of Object.entries(exportsMap)) {
		const star = pattern.indexOf("*");
		if (star < 0) continue;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (!entryPoint.startsWith(prefix) || !entryPoint.endsWith(suffix)) continue;
		const replacement = entryPoint.slice(prefix.length, entryPoint.length - suffix.length);
		const target = typesTarget(value);
		if (target !== null) return target.replace("*", replacement);
	}
	throw new Error(`${packageName} does not expose a declaration entry point for ${entryPoint}`);
}

function normalizedDeclaration(printer: ts.Printer, declaration: ts.Declaration): string {
	return printer
		.printNode(ts.EmitHint.Unspecified, declaration, declaration.getSourceFile())
		.replaceAll(/\s+/g, " ")
		.trim();
}

function signatureHash(checker: ts.TypeChecker, exported: ts.Symbol, exportName: string): string {
	let target = exported;
	const seen = new Set<ts.Symbol>();
	while ((target.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(target)) {
		seen.add(target);
		target = checker.getAliasedSymbol(target);
	}
	const declarations = target.getDeclarations() ?? exported.getDeclarations() ?? [];
	const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
	const signature = declarations
		.map((declaration) => normalizedDeclaration(printer, declaration))
		.sort()
		.join("\n");
	if (signature.length === 0) throw new Error(`cannot resolve a declaration for export ${exportName}`);
	return createHash("sha256").update(`${exportName}\n${signature}`).digest("hex");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildPiSurfaceSnapshot(root: string): {
	snapshot: PiSurfaceSnapshot;
	imports: PiSurfaceImports;
} {
	const clioImports = collectClioPiImports(root);
	const declarations = new Map<string, { packageName: string; entryPoint: string; relativePath: string }>();
	for (const packageName of PI_PACKAGES) {
		const pkg = packageJson(root, packageName);
		const specifiers = new Set<string>([packageName]);
		for (const specifier of clioImports.keys()) {
			if (piPackageForSpecifier(specifier) === packageName) specifiers.add(specifier);
		}
		for (const specifier of specifiers) {
			const entryPoint = entryPointForSpecifier(packageName, specifier);
			const relativePath = declarationTarget(packageName, pkg, entryPoint).replace(/^\.\//, "");
			const absolute = join(root, "node_modules", ...packageName.split("/"), relativePath);
			if (!existsSync(absolute) || !statSync(absolute).isFile()) {
				throw new Error(`${specifier} declaration does not exist at ${relative(root, absolute)}`);
			}
			declarations.set(absolute, { packageName, entryPoint, relativePath });
		}
	}

	const program = ts.createProgram([...declarations.keys()], {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true,
		types: ["node"],
	});
	const checker = program.getTypeChecker();
	const packages = new Map<string, PiSurfacePackage>();
	for (const packageName of PI_PACKAGES) {
		packages.set(packageName, { version: packageJson(root, packageName).version, entryPoints: {} });
	}
	for (const [absolute, declaration] of declarations) {
		const source = program.getSourceFile(absolute);
		const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
		if (!moduleSymbol) throw new Error(`TypeScript could not load ${relative(root, absolute)}`);
		const exported = checker.getExportsOfModule(moduleSymbol);
		const hashes = new Map<string, string>();
		for (const symbol of exported) {
			const name = symbol.getName();
			hashes.set(name, signatureHash(checker, symbol, name));
		}
		const pkg = packages.get(declaration.packageName);
		if (!pkg) throw new Error(`internal error: missing package ${declaration.packageName}`);
		pkg.entryPoints[declaration.entryPoint] = {
			declaration: declaration.relativePath.split(sep).join("/"),
			exports: sortedRecord(hashes),
		};
	}
	for (const pkg of packages.values()) pkg.entryPoints = sortedRecord(Object.entries(pkg.entryPoints));

	return {
		snapshot: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, packages: sortedRecord(packages) },
		imports: sortedRecord([...clioImports].map(([specifier, names]) => [specifier, [...names].sort()] as const)),
	};
}

function importedNames(imports: PiSurfaceImports, packageName: string, entryPoint: string): ReadonlyArray<string> {
	const specifier = entryPoint === "." ? packageName : `${packageName}${entryPoint.slice(1)}`;
	return imports[specifier] ?? [];
}

export function comparePiSurfaceSnapshots(
	baseline: PiSurfaceSnapshot,
	current: PiSurfaceSnapshot,
	imports: PiSurfaceImports,
): PiSurfaceComparison {
	const errors: string[] = [];
	const infos: string[] = [];
	for (const packageName of PI_PACKAGES) {
		const beforePackage = baseline.packages[packageName];
		const afterPackage = current.packages[packageName];
		if (!beforePackage || !afterPackage) {
			errors.push(`${packageName}: package is missing from ${!beforePackage ? "the snapshot" : "the installed surface"}`);
			continue;
		}
		if (beforePackage.version !== afterPackage.version) {
			infos.push(`${packageName}: version ${beforePackage.version} -> ${afterPackage.version}`);
		}
		const entryPoints = new Set([...Object.keys(beforePackage.entryPoints), ...Object.keys(afterPackage.entryPoints)]);
		for (const entryPoint of [...entryPoints].sort()) {
			const before = beforePackage.entryPoints[entryPoint]?.exports ?? {};
			const after = afterPackage.entryPoints[entryPoint]?.exports ?? {};
			const imported = importedNames(imports, packageName, entryPoint);
			const importedSet = new Set(imported.includes("*") ? Object.keys(before) : imported);
			for (const name of importedSet) {
				if (!(name in after)) {
					errors.push(`${packageName}${entryPoint === "." ? "" : entryPoint.slice(1)}: imported export ${name} was removed`);
				} else if (before[name] !== undefined && before[name] !== after[name]) {
					errors.push(
						`${packageName}${entryPoint === "." ? "" : entryPoint.slice(1)}: imported export ${name} changed signature`,
					);
				}
			}
			for (const name of Object.keys(after).sort()) {
				if (!(name in before)) {
					infos.push(`${packageName}${entryPoint === "." ? "" : entryPoint.slice(1)}: new export ${name}`);
				}
			}
		}
	}
	return { errors, infos };
}

export function readPiSurfaceSnapshot(path: string): PiSurfaceSnapshot {
	const snapshot = JSON.parse(readFileSync(path, "utf8")) as PiSurfaceSnapshot;
	if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new Error(`unsupported Pi surface snapshot schema ${String(snapshot.schemaVersion)}`);
	}
	return snapshot;
}

function main(): void {
	const scriptPath = fileURLToPath(import.meta.url);
	const root = resolve(dirname(scriptPath), "..");
	const snapshotPath = join(root, "docs", "pi-surface.json");
	const { snapshot: current, imports } = buildPiSurfaceSnapshot(root);
	if (process.argv.includes("--write")) {
		writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
		process.stdout.write(`pi-surface: wrote ${relative(root, snapshotPath)}\n`);
		return;
	}
	const baseline = readPiSurfaceSnapshot(snapshotPath);
	const comparison = comparePiSurfaceSnapshots(baseline, current, imports);
	for (const info of comparison.infos) process.stdout.write(`pi-surface: info: ${info}\n`);
	for (const error of comparison.errors) process.stderr.write(`pi-surface: error: ${error}\n`);
	if (comparison.errors.length > 0) process.exitCode = 1;
	else if (comparison.infos.length === 0)
		process.stdout.write("pi-surface: installed declarations match the snapshot\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
