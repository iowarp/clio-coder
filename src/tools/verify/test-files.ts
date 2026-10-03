import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import type { DeclaredCheck } from "./catalog.js";
import { discoverDeclaredChecksAtRoot } from "./discovery.js";
import { resolveVerifyCall, verifyResolutionArgv } from "./resolve.js";
import { parsePackageJson, shellLikeArgv } from "./toolchain.js";
import { discoverToolchainChecks } from "./toolchain-checks.js";

export interface TestFileCheck {
	check: DeclaredCheck;
	argv: string[];
}

function isTestFile(filename: string): boolean {
	return /(?:^|\/)test[^/]*\.py$|(?:^|\/)test_[^/]+\.[^/]+$|[._](?:test|spec)\.[^/]+$|(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$|(?:^|\/)tests\/.*\.rs$/u.test(
		filename,
	);
}

function declaredRunner(root: string, check: DeclaredCheck, filename: string): string[] | null {
	const packageScript = check.source.kind === "package.json";
	let argv = check.command;
	if (packageScript) {
		const pkg = parsePackageJson(check.source.path);
		const script = pkg.ok ? pkg.scripts[check.id] : null;
		if (typeof script !== "string") return null;
		const parsed = shellLikeArgv(script);
		if (parsed instanceof Error) return null;
		argv = parsed;
	} else if (check.kind !== "command") return null;
	filename = `./${path.relative(path.resolve(root, check.cwd), path.resolve(root, filename)).split(path.sep).join("/")}`;
	const javascript = /\.[cm]?[jt]sx?$/u.test(filename);
	const executable = path.basename(argv[0] ?? "").replace(/\.exe$/u, "");
	const node = executable === "node" && argv.includes("--test");
	const jest = executable === "jest";
	const vitest = executable === "vitest";
	const tsx = executable === "tsx" && argv.includes("--test");
	let args: string[];
	if (javascript && (node || jest || vitest || tsx)) {
		args = [...(jest ? ["--runTestsByPath"] : vitest && !argv.includes("run") ? ["--run"] : []), filename];
	} else if (filename.endsWith(".py") && argv.includes("pytest")) args = [filename];
	else if (filename.endsWith(".py") && argv.includes("unittest")) {
		// unittest accepts a per-file discovery pattern even when tests/ is not an importable package.
		if (packageScript) return null;
		argv = argv.slice(0, argv.indexOf("unittest") + 1);
		args = ["discover", "-s", path.dirname(filename), "-p", path.basename(filename)];
	} else return null;
	if (!packageScript) return [...argv, ...args];
	return verifyResolutionArgv(resolveVerifyCall(root, { check: check.id, cwd: check.cwd, args }), { args });
}

/** Resolve changed tests from the same project declarations verify uses, without guessing an installed runner. */
export function resolveTestFileChecks(
	workspaceRoot: string,
	mutatedPaths: ReadonlyArray<string>,
): { checks: TestFileCheck[]; notes: string[] } {
	workspaceRoot = path.resolve(workspaceRoot);
	const checks: TestFileCheck[] = [];
	const notes: string[] = [];
	const seen = new Set<string>();
	for (const filename of mutatedPaths) {
		let absolute: string;
		try {
			absolute = resolveSafeCwd(filename, workspaceRoot);
			if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
			resolveSafeCwd(realpathSync(absolute), realpathSync(workspaceRoot));
		} catch {
			// Paths outside the workspace cannot be test inputs.
			continue;
		}
		const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
		if (!isTestFile(relative)) continue;
		let root = path.dirname(absolute);
		while (
			root !== workspaceRoot &&
			!["package.json", "pyproject.toml", "go.mod", "Cargo.toml"].some((manifest) => existsSync(path.join(root, manifest)))
		) {
			root = path.dirname(root);
		}
		const local = `./${path.relative(root, absolute).split(path.sep).join("/")}`;
		const discovery = discoverDeclaredChecksAtRoot(root, undefined);
		const declared = discovery.ok ? discovery.sources.flatMap((source) => source.checks) : [];
		let resolved: TestFileCheck | undefined;
		for (const check of declared) {
			const argv = declaredRunner(root, check, local);
			if (argv !== null) {
				resolved = { check, argv };
				break;
			}
		}
		if (resolved === undefined) {
			for (const check of discoverToolchainChecks(root)) {
				let args: string[];
				if (relative.endsWith(".py") && check.id === "python-pytest") args = [local];
				else if (relative.endsWith(".py") && check.id === "python-unittest") {
					args = ["discover", "-s", path.dirname(local), "-p", path.basename(local)];
				} else if (relative.endsWith("_test.go") && check.id === "go-test") args = [path.dirname(local)];
				else if (relative.endsWith(".rs") && check.id === "cargo-test") args = [];
				else continue;
				const resolution = resolveVerifyCall(root, { check: check.id, args });
				const argv = verifyResolutionArgv(resolution, { args });
				if (argv !== null) {
					resolved = { check, argv };
					break;
				}
			}
		}
		if (resolved === undefined) {
			notes.push(
				`Changed test ${relative}: no recognizable project runner; retained the declared check only for this file.`,
			);
			continue;
		}
		const cwd = path.relative(workspaceRoot, path.resolve(root, resolved.check.cwd)).split(path.sep).join("/");
		resolved = { ...resolved, check: { ...resolved.check, cwd: cwd || "." } };
		const identity = JSON.stringify([resolved.check.cwd, resolved.argv]);
		if (!seen.has(identity)) checks.push(resolved);
		seen.add(identity);
	}
	return { checks, notes };
}
