import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface ReleaseManifest {
	requiredFiles: string[];
	requiredPrefixes: string[];
}

function readJson<T>(relative: string): T {
	return JSON.parse(readFileSync(join(root, relative), "utf8")) as T;
}

const manifest = readJson<ReleaseManifest>("scripts/release-manifest.json");
const packageFiles = readJson<{ files: string[] }>("package.json").files;

/**
 * Whether the package.json `files` allowlist ships `path`. Covers the three
 * pattern shapes the allowlist actually uses: an exact path, a bare directory
 * that npm expands recursively, and a `**`/`*` glob. Negations are skipped
 * here and asserted separately.
 */
function shippedBy(path: string): boolean {
	for (const pattern of packageFiles) {
		if (pattern.startsWith("!")) continue;
		if (pattern === path) return true;
		if (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -2))) return true;
		if (!pattern.includes("*") && path.startsWith(`${pattern}/`)) return true;
		const star = pattern.indexOf("*");
		if (star !== -1 && !pattern.includes("**")) {
			const [dir, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
			if (path.startsWith(dir) && path.endsWith(suffix) && !path.slice(dir.length).includes("/")) return true;
		}
	}
	return false;
}

/**
 * Whether the allowlist ships anything at all beneath directory `dir`. A
 * directory resource is satisfied two ways: a pattern covers the whole tree
 * (`src/domains/prompts/fragments/**` covers `.../fragments/wiki`), or a
 * pattern selects individual members of it (`docs/*.md` ships part of `docs`).
 */
function shipsUnder(dir: string): boolean {
	if (shippedBy(`${dir}/probe`)) return true;
	return packageFiles.some((pattern) => !pattern.startsWith("!") && pattern.startsWith(`${dir}/`));
}

/**
 * npm packs these regardless of the `files` allowlist, so a runtime resolver
 * reading one is always satisfied and the allowlist has nothing to say about it.
 */
const NPM_IMPLICIT_FILES = new Set(["package.json"]);

/**
 * Source files that call `resolvePackageRoot()` for the root directory itself
 * rather than to build a path into it. Each is a directory handed to another
 * process or scanner, not a packaged resource, so the `files` allowlist has no
 * entry to check. A new call site outside this set must resolve to a literal
 * path, which keeps a resolver from reaching a tree nobody remembered to ship.
 */
const ROOT_ONLY_RESOLVERS = new Set([
	// Runs `git rev-parse HEAD` with the package root as cwd.
	"src/domains/eval/provenance.ts",
	// Hands the root to the component scanner, which walks whatever is present.
	"src/cli/components.ts",
]);

const PATH_JOINERS = new Set(["join", "resolve"]);

interface PackageRootUse {
	file: string;
	line: number;
	/** Literal path below the package root, or null when no literal segment resolved. */
	path: string | null;
}

function typescriptSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...typescriptSources(abs));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(abs);
	}
	return out;
}

function isPathJoiner(expression: ts.Expression): boolean {
	if (ts.isIdentifier(expression)) return PATH_JOINERS.has(expression.text);
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
		return PATH_JOINERS.has(expression.name.text);
	}
	return false;
}

function isPackageRootCall(node: ts.Node): node is ts.CallExpression {
	return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "resolvePackageRoot";
}

/**
 * Every path a source file reaches through `resolvePackageRoot()`, read off the
 * syntax tree rather than by regex so multi-line joins, `path.join` versus a
 * bare `join`, and the `const root = resolvePackageRoot()` indirection all
 * resolve. Literal segments accumulate until the first dynamic argument, so
 * `join(root, "src", "prompts", \`${name}.md\`)` yields the directory. A join
 * whose very first path argument is dynamic yields null: the resolver reaches
 * something the allowlist cannot be checked against from the syntax alone.
 */
function packageRootUses(absolute: string): { joined: PackageRootUse[]; rootOnly: boolean } {
	const text = readFileSync(absolute, "utf8");
	const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.ESNext, true);
	const file = relative(root, absolute).replaceAll("\\", "/");

	const stringConstants = new Map<string, string>();
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
				stringConstants.set(declaration.name.text, declaration.initializer.text);
			}
		}
	}

	const aliases = new Set<string>();
	const collectAliases = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (isPackageRootCall(node.initializer)) aliases.add(node.name.text);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			isPackageRootCall(node.right)
		) {
			aliases.add(node.left.text);
		}
		ts.forEachChild(node, collectAliases);
	};
	collectAliases(source);

	const isRootExpression = (expression: ts.Expression): boolean =>
		isPackageRootCall(expression) || (ts.isIdentifier(expression) && aliases.has(expression.text));

	const joined: PackageRootUse[] = [];
	let rootOnly = false;
	const collectUses = (node: ts.Node): void => {
		if (isPackageRootCall(node)) {
			const parent = node.parent;
			const joinedHere =
				(ts.isCallExpression(parent) && isPathJoiner(parent.expression) && parent.arguments[0] === node) ||
				ts.isVariableDeclaration(parent) ||
				ts.isBinaryExpression(parent);
			if (!joinedHere) rootOnly = true;
		}
		if (
			ts.isCallExpression(node) &&
			isPathJoiner(node.expression) &&
			node.arguments.length > 0 &&
			isRootExpression(node.arguments[0] as ts.Expression)
		) {
			const segments: string[] = [];
			for (const argument of node.arguments.slice(1)) {
				if (ts.isStringLiteral(argument)) segments.push(argument.text);
				else if (ts.isIdentifier(argument) && stringConstants.has(argument.text)) {
					segments.push(stringConstants.get(argument.text) as string);
				} else break;
			}
			joined.push({
				file,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				path: segments.length > 0 ? segments.join("/").replaceAll(/\/+/g, "/") : null,
			});
		}
		ts.forEachChild(node, collectUses);
	};
	collectUses(source);
	return { joined, rootOnly };
}

/** Paths git refuses to track. Generated runtime state lives here. */
function gitIgnored(paths: ReadonlyArray<string>): Set<string> {
	if (paths.length === 0) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "--", ...paths], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(out.split("\n").filter((line) => line.length > 0));
	} catch {
		// `git check-ignore` exits 1 when nothing matched, which is the clean case.
		return new Set();
	}
}

describe("contracts/packaging", () => {
	it("ships every file the release gate requires", () => {
		const missing = manifest.requiredFiles.filter((file) => !shippedBy(file));
		strictEqual(missing.join(", "), "", `release gate requires files the package.json allowlist does not ship`);
	});

	it("ships every resource tree the release gate requires", () => {
		const missing = manifest.requiredPrefixes.filter((prefix) => !shippedBy(`${prefix}probe`));
		strictEqual(missing.join(", "), "", `release gate requires trees the package.json allowlist does not ship`);
	});

	/**
	 * The root cause of the CLIO.md packaging defect. A gitignored path is
	 * generated runtime state: npm packs from the working tree, so shipping one
	 * publishes whatever the release machine happened to generate, and requiring
	 * one fails the gate on a clean checkout. Neither is a thing a release can do.
	 */
	it("neither ships nor requires gitignored generated state", () => {
		const candidates = [...new Set([...manifest.requiredFiles, ...packageFiles.filter((f) => !f.startsWith("!"))])];
		const ignored = gitIgnored(candidates.filter((path) => !path.includes("*")));
		// dist/ is gitignored by design: it is a build output the tarball must carry.
		const offenders = [...ignored].filter((path) => path !== "dist" && !path.startsWith("dist/"));
		strictEqual(offenders.join(", "), "", "gitignored generated state on the publish path");
	});

	it("requires only source-tracked files that exist in the checkout", () => {
		const absent = manifest.requiredFiles
			.filter((file) => !file.startsWith("dist/"))
			.filter((file) => !existsSync(join(root, file)));
		strictEqual(absent.join(", "), "", "release gate requires files absent from the checkout");
	});

	/**
	 * The general form of the `clio docs` packaging defect. `resolvePackageRoot()`
	 * returns the installed package root, so every path built on it is a claim
	 * that the tarball carries that path. The release manifest lists a handful of
	 * those claims by hand and drifts the moment someone drops an entry from
	 * either side. This reads the claims out of `src/` instead, so the allowlist
	 * is checked against what the code actually reaches for.
	 */
	it("ships every path src/ resolves from the installed package root", () => {
		const unshipped: string[] = [];
		const unclassified: string[] = [];
		for (const absolute of typescriptSources(join(root, "src"))) {
			const text = readFileSync(absolute, "utf8");
			if (!text.includes("resolvePackageRoot")) continue;
			const { joined, rootOnly } = packageRootUses(absolute);
			const file = relative(root, absolute).replaceAll("\\", "/");
			if (rootOnly && !ROOT_ONLY_RESOLVERS.has(file)) unclassified.push(file);
			for (const use of joined) {
				if (use.path === null) continue;
				if (NPM_IMPLICIT_FILES.has(use.path)) continue;
				const looksLikeFile = /\.[A-Za-z0-9]+$/.test(use.path);
				const shipped = looksLikeFile ? shippedBy(use.path) : shipsUnder(use.path);
				if (!shipped) unshipped.push(`${use.file}:${use.line} resolves ${use.path}`);
			}
		}
		strictEqual(
			unshipped.join("; "),
			"",
			"src/ resolves paths from the package root that the package.json allowlist does not ship",
		);
		strictEqual(
			unclassified.join(", "),
			"",
			"resolvePackageRoot() used as a bare directory outside ROOT_ONLY_RESOLVERS; resolve a literal path or record why the root itself is the resource",
		);
	});

	/**
	 * The scanner above is only as good as its reach. If it stops finding call
	 * sites because an import was renamed or the helper moved, it would report a
	 * clean bill of health over nothing at all.
	 */
	it("keeps the package-root scanner pointed at real call sites", () => {
		const files = typescriptSources(join(root, "src")).filter((absolute) =>
			readFileSync(absolute, "utf8").includes("resolvePackageRoot("),
		);
		ok(files.length >= 10, `expected the package-root scanner to reach the known call sites, saw ${files.length}`);
		const resolved = files.flatMap((absolute) => packageRootUses(absolute).joined.filter((use) => use.path !== null));
		ok(resolved.length >= 10, `expected literal package-root paths to resolve, saw ${resolved.length}`);
	});

	it("keeps the release gate reading the shared manifest rather than its own copy", () => {
		const gate = readFileSync(join(root, "scripts/check-release.mjs"), "utf8");
		ok(gate.includes("release-manifest.json"), "check-release.mjs must read the shared manifest");
	});
});
