import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { shellLikeChain } from "../../core/shell-argv.js";
import type { DeclaredCheck } from "./catalog.js";
import { discoverDeclaredChecksAtRoot } from "./discovery.js";
import { resolveVerifyCall, verifyResolutionArgv } from "./resolve.js";
import { parsePackageJson, shellLikeArgv } from "./toolchain.js";
import { discoverToolchainChecks } from "./toolchain-checks.js";

export interface TestFileCheck {
	check: DeclaredCheck;
	argv: string[];
	/** Context the operator needs to read the result, such as a run made outside npm. */
	detail?: string;
}

function isTestFile(filename: string): boolean {
	return /(?:^|\/)test[^/]*\.py$|(?:^|\/)test_[^/]+\.[^/]+$|[._](?:test|spec)\.[^/]+$|(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$|(?:^|\/)tests\/.*\.rs$/u.test(
		filename,
	);
}

// `node --test` with no positional also discovers JavaScript and TypeScript under any test/ directory without a
// test suffix. Jest and vitest apply their own testMatch, so this rule only selects node and tsx runners.
function isNodeTestDirectoryFile(filename: string): boolean {
	return (
		/(?:^|\/)test\/(?:[^/]+\/)*[^/]+\.(?:[cm]?js|[cm]?ts)$/u.test(filename) &&
		!/\.d\.[cm]?ts$/u.test(filename) &&
		!/(?:^|\/)node_modules\//u.test(filename)
	);
}

type OptionArity = 0 | 1 | "variadic";

// Options that can drop an explicitly named file or its tests while the run still passes; the targeted run strips
// them. Scope options stay: jest --runTestsByPath runs a named path regardless of --testPathPattern(s), and a path
// outside jest --selectProjects/--ignoreProjects/--testPathIgnorePatterns or vitest --project/--root/--dir/--exclude
// makes the runner exit 1 with "no tests found". --passWithNoTests stays: it only changes the result for a file the
// runner would not run at all, which the pre-fix append reported the same way.
const NODE_SELECTORS: Record<string, OptionArity> = {
	"--test-name-pattern": 1,
	"--test-skip-pattern": 1,
	"--test-shard": 1,
	"--test-only": 0,
};
const JEST_SELECTORS: Record<string, OptionArity> = {
	"-t": 1,
	"--testNamePattern": 1,
	"--shard": 1,
	"-o": 0,
	"--onlyChanged": 0,
	"--changedSince": 1,
	"--lastCommit": 0,
	"-f": 0,
	"--onlyFailures": 0,
	"--findRelatedTests": "variadic",
};
const VITEST_SELECTORS: Record<string, OptionArity> = {
	"-t": 1,
	"--testNamePattern": 1,
	"--shard": 1,
	"--changed": "variadic",
};
// Selector flags of every runner, found in raw script text so expansions, assignments and shell wrappers cannot
// hide one from a shape this module does not parse.
const RAW_SELECTOR = new RegExp(
	`(?<=^|[\\s'"{(=,;&|]|:-)(${[...new Set([NODE_SELECTORS, JEST_SELECTORS, VITEST_SELECTORS].flatMap(Object.keys))].join(
		"|",
	)})(?=$|[\\s'"=});&|])`,
	"u",
);
const RAW_RUNNER = /(?:^|[^\w-])(?:jest|vitest)(?:$|[^\w-])|--test(?:$|[\s'"=])/u;

// Node options known to take a value, so the next word is that value rather than a positional test pattern.
// Version-dependent options such as --experimental-default-type (removed in node 24, which then refuses the whole
// script) and --experimental-policy are on neither list, so their scripts keep the pre-fix behavior.
const NODE_VALUE_OPTIONS = new Set([
	"--import",
	"--require",
	"-r",
	"--loader",
	"--experimental-loader",
	"--env-file",
	"--env-file-if-exists",
	"--test-reporter",
	"--test-reporter-destination",
	"--test-coverage-include",
	"--test-coverage-exclude",
	"--test-coverage-lines",
	"--test-coverage-branches",
	"--test-coverage-functions",
	"--test-concurrency",
	"--test-timeout",
	"--test-global-setup",
	"--test-isolation",
	"--test-name-pattern",
	"--test-skip-pattern",
	"--test-shard",
	"--title",
	"--report-dir",
	"--report-directory",
	"--report-filename",
	"--cpu-prof-dir",
	"--cpu-prof-name",
	"--heap-prof-dir",
	"--heap-prof-name",
	"--diagnostic-dir",
	"--redirect-warnings",
	"--conditions",
	"-C",
	"--input-type",
	"--watch-path",
	"--unhandled-rejections",
	"--disable-warning",
	"--stack-trace-limit",
	"--tsconfig",
]);
// Node options known to take no value, so the next word can still be a positional test pattern.
const NODE_BOOLEAN_OPTIONS = new Set([
	"--test",
	"--test-only",
	"--test-force-exit",
	"--test-update-snapshots",
	"--experimental-test-coverage",
	"--experimental-test-module-mocks",
	"--experimental-test-snapshots",
	"--experimental-test-isolation",
	"--experimental-strip-types",
	"--experimental-transform-types",
	"--experimental-vm-modules",
	"--experimental-detect-module",
	"--experimental-require-module",
	"--experimental-wasm-modules",
	"--experimental-import-meta-resolve",
	"--enable-source-maps",
	"--expose-gc",
	"--watch",
	"--preserve-symlinks",
	"--preserve-symlinks-main",
	"--trace-warnings",
	"--trace-deprecation",
	"--trace-uncaught",
	"--trace-exit",
	"--throw-deprecation",
	"--pending-deprecation",
	"--no-deprecation",
	"--no-warnings",
	"--frozen-intrinsics",
	"--abort-on-uncaught-exception",
	"--zero-fill-buffers",
	"--inspect",
	"--inspect-brk",
	"--inspect-wait",
	"--cpu-prof",
	"--heap-prof",
]);

/** Drop selectors from a runner argv. Variadic values stop at the next option; dropping a positional only narrows. */
function withoutSelectors(
	argv: string[],
	selectors: Record<string, OptionArity>,
	clusters: boolean,
): { kept: string[]; removed: string[] } {
	const kept: string[] = [];
	const removed: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") {
			kept.push(...argv.slice(index));
			break;
		}
		// yargs and cac read `-ot foo` as `-o -t foo`.
		const flags = clusters && /^-[A-Za-z]{2,}$/u.test(token) ? [...token.slice(1)].map((flag) => `-${flag}`) : [token];
		for (const [position, flag] of flags.entries()) {
			const [name = flag, inline] = flag.split(/=(.*)/su);
			const arity = Object.hasOwn(selectors, name) ? selectors[name] : undefined;
			if (arity === undefined) {
				kept.push(flag);
				continue;
			}
			removed.push(name);
			if (inline !== undefined || arity === 0 || position < flags.length - 1) continue;
			if (arity === 1) index += 1;
			else while (index + 1 < argv.length && !(argv[index + 1] ?? "").startsWith("-")) index += 1;
		}
	}
	return { kept, removed };
}

const GLOB_CHARACTER = /[*?[\]{}]/u;

function globPattern(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index] ?? "";
		if (glob.startsWith("**/", index)) {
			source += "(?:.*/)?";
			index += 2;
		} else if (glob.startsWith("**", index)) {
			source += ".*";
			index += 1;
		} else if (character === "*") source += "[^/]*";
		else if (character === "?") source += "[^/]";
		else if (character === "{") source += "(?:";
		else if (character === "}") source += ")";
		else if (character === ",") source += "|";
		else source += character.replace(/[.+^$()|\\[\]]/gu, "\\$&");
	}
	return new RegExp(`^${source}$`, "u");
}

/**
 * Whether `node --test` with these arguments runs `absolute`, or "ambiguous" when an option is neither a known value
 * nor a known boolean, so the next word could be either and the caller keeps the pre-fix behavior. Any positional,
 * present on disk or not, replaces the default discovery, so the file must equal one or match its glob. A directory
 * positional discovers nothing: node 22 through 26 fail it with "Cannot find module".
 */
function nodeRunsFile(argv: string[], cwd: string, absolute: string): boolean | "ambiguous" {
	const positionals: string[] = [];
	let operands = false;
	for (let index = argv.indexOf("--test") + 1; index > 0 && index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (!operands && token === "--") operands = true;
		else if (!operands && token.startsWith("-")) {
			if (token.includes("=") || NODE_BOOLEAN_OPTIONS.has(token)) continue;
			if (!NODE_VALUE_OPTIONS.has(token)) return "ambiguous";
			index += 1;
		} else if (token.includes("$")) {
			// An unexpanded variable may hold options or patterns, so it is never read as a file positional.
			return "ambiguous";
		} else positionals.push(token);
	}
	// Without type stripping node's default discovery skips TypeScript files.
	if (argv.includes("--no-experimental-strip-types") && /\.[cm]?ts$/u.test(absolute)) return false;
	if (positionals.length === 0) return true;
	const relative = path.relative(cwd, absolute).split(path.sep).join("/");
	return positionals.some((positional) => {
		if (GLOB_CHARACTER.test(positional)) return globPattern(positional.replace(/^\.\//u, "")).test(relative);
		return absolute === path.resolve(cwd, positional);
	});
}

type JavaScriptRunner = "node" | "jest" | "vitest";

function executableName(word: string): string {
	return path.basename(word).replace(/\.(?:exe|cmd)$/u, "");
}

function javascriptRunner(argv: string[]): JavaScriptRunner | null {
	const executable = executableName(argv[0] ?? "");
	if ((executable === "node" || executable === "tsx") && argv.includes("--test")) return "node";
	return executable === "jest" || executable === "vitest" ? executable : null;
}

/** Where a runner starts inside any command, wrapped or not, so its selectors can be found in shapes not handled. */
function runnerStart(words: string[]): { index: number; runner: JavaScriptRunner } | null {
	for (const [index, word] of words.entries()) {
		const name = executableName(word).replace(/\.[cm]?js$/u, "");
		if (name === "jest" || name === "vitest") return { index, runner: name };
		if ((name === "node" || name === "tsx") && words.indexOf("--test", index) > index) return { index, runner: "node" };
	}
	return null;
}

function selectorsFor(runner: JavaScriptRunner): Record<string, OptionArity> {
	return runner === "node" ? NODE_SELECTORS : runner === "jest" ? JEST_SELECTORS : VITEST_SELECTORS;
}

const RUNNER_NAMES = new Set(["node", "tsx", "jest", "vitest"]);

interface UnwrappedRunner {
	/** Wrappers that set the runner's environment (cross-env, env, dotenv), kept for a direct run. */
	prefix: string[];
	/** The bin locator (npx, npm exec, pnpm exec, yarn), kept only when no local binary exists, as under Yarn PnP. */
	locator: string[];
	argv: string[];
}

/** Peel the wrapper shapes this module fully understands; anything else keeps its wrapper and is not a runner. */
function unwrapRunner(argv: string[]): UnwrappedRunner {
	const prefix: string[] = [];
	let locator: string[] = [];
	for (;;) {
		const executable = executableName(argv[0] ?? "");
		let rest: string[] | undefined;
		if (executable === "cross-env" || executable === "env") {
			let index = 1;
			while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) index += 1;
			if (index > 1) {
				prefix.push(...argv.slice(0, index));
				rest = argv.slice(index);
			}
		} else if (executable === "dotenv" && argv.includes("--")) {
			prefix.push(...argv.slice(0, argv.indexOf("--") + 1));
			rest = argv.slice(argv.indexOf("--") + 1);
		} else if (["npx", "npm", "pnpm", "yarn"].includes(executable)) {
			let index: number | undefined;
			if (executable === "npx") index = 1;
			else if (["exec", "x"].includes(argv[1] ?? "") && executable !== "yarn") index = 2;
			else if (["exec", "run"].includes(argv[1] ?? "") && executable === "yarn") index = 2;
			else if (executable === "pnpm" && argv[1] === "dlx") index = 2;
			else if (executable !== "npm" && RUNNER_NAMES.has(argv[1] ?? "")) index = 1;
			if (index !== undefined) {
				for (; (argv[index] ?? "").startsWith("-"); index += 1) {
					if (argv[index] === "--") {
						index += 1;
						break;
					}
					if (["-p", "--package"].includes(argv[index] ?? "")) index += 1;
				}
				locator = executable === "npm" ? [...argv.slice(0, index), "--"] : argv.slice(0, index);
				rest = argv.slice(index);
				// `npx jest -- -t x` hands everything after the wrapper's `--` to the runner.
				const separator = rest.indexOf("--");
				if (separator > 0) rest = [...rest.slice(0, separator), ...rest.slice(separator + 1)];
			}
		}
		if (rest === undefined || rest.length === 0) return { prefix, locator, argv };
		argv = rest;
	}
}

/** The project-local binary npm would put first on PATH, or null when none is installed inside the workspace. */
function localBinary(workspaceRoot: string, from: string, executable: string): string | null {
	if (executable.includes("/") || executable === "node" || executable === "env") return executable;
	if (path.relative(workspaceRoot, from).startsWith("..")) return null;
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", ".bin", executable);
		if (existsSync(candidate)) return candidate;
		if (dir === workspaceRoot || path.dirname(dir) === dir) return null;
	}
}

/** Commands of a script the shell parser refuses, split at operators so their runner selectors can still be seen. */
function looseSegments(script: string): Array<{ assignments: string[]; argv: string[]; text: string }> {
	return script
		.split(/&&|\|\||[;|&\n]/u)
		.map((text) => ({
			assignments: [],
			argv: text
				.trim()
				.split(/\s+/u)
				.map((word) => word.replace(/^['"]|['"]$/gu, "")),
			text,
		}))
		.filter((segment) => segment.argv.length > 0 && segment.argv[0] !== "");
}

/**
 * Values assigned to shell variables anywhere in a package script, by name. An expansion makes the script one the
 * shell parser refuses, so this reads the raw text; a value stops at a quote's end or at ;, & or |. `set --` assigns
 * the positional parameters read through $@ and $*.
 */
function scriptAssignments(script: string): Map<string, string[]> {
	const values = new Map<string, string[]>();
	const add = (name: string, value: string): void => {
		values.set(name, [...(values.get(name) ?? []), value]);
	};
	for (const match of script.matchAll(/(?<=^|[\s;&|(])([A-Za-z_]\w*)=('[^']*'|"[^"]*"|[^\s;&|]*)/gu)) {
		add(match[1] ?? "", match[2] ?? "");
	}
	for (const match of script.matchAll(/(?<=^|[\s;&|(])set\s+--\s+([^;&|\n]*)/gu)) {
		add("@", match[1] ?? "");
		add("*", match[1] ?? "");
	}
	return values;
}

/** The assigned values a runner's own words expand through $NAME or ${NAME...}; only those can reach the runner. */
function referencedValues(words: string[], values: Map<string, string[]>): string {
	const text = words.join(" ");
	return [...values]
		.filter(([name]) =>
			new RegExp(`\\$\\{?${name === "*" ? "\\*" : name === "@" ? "@" : `${name}(?!\\w)`}`, "u").test(text),
		)
		.flatMap(([, assigned]) => assigned)
		.join(" ");
}

const DIRECT_RUN_DETAIL =
	"ran directly outside npm, so npm's environment, .npmrc node-options and pre/post scripts were not applied";

// `ignored` marks a runner that would not run a test/ directory file, so the file is not a changed test here.
type Runner = { argv: string[]; detail?: string } | { refusal: string } | { ignored: true } | null;

/**
 * Governing rule: a shape this module fully handles runs the changed file with its selectors stripped; any other
 * shape keeps the pre-fix behavior (the npm-run append or the note) unless a test selector appears in one of its
 * runner commands, where a pass could hide the changed file, so it fails closed.
 */
function javascriptRunnerArgv(
	workspaceRoot: string,
	root: string,
	check: DeclaredCheck,
	filename: string,
	nodeOnly: boolean,
): Runner {
	const packageScript = check.source.kind === "package.json";
	const label = `${packageScript ? "package script" : "check"} "${check.id}"`;
	let segments: Array<{ assignments: string[]; argv: string[]; text: string }> = [
		{ assignments: [], argv: check.command, text: check.command.join(" ") },
	];
	let parsed = true;
	let raw = check.command.join(" ");
	if (packageScript) {
		const pkg = parsePackageJson(check.source.path, workspaceRoot);
		const script = pkg.ok ? pkg.scripts[check.id] : null;
		if (typeof script !== "string") return null;
		raw = script;
		const chain = shellLikeChain(script, { allowAssignments: true, rejectComments: true });
		parsed = !(chain instanceof Error);
		segments = chain instanceof Error ? looseSegments(script) : chain;
	} else if (check.kind !== "command") return null;
	const cwd = path.resolve(root, check.cwd);
	const absolute = path.resolve(root, filename);
	const shapeRefusal = (selector: string): Runner => ({
		refusal: `${label} filters tests with ${selector} in a command shape that cannot be run with only this file`,
	});
	const assigned = packageScript ? scriptAssignments(raw) : new Map<string, string[]>();
	const runners = segments.flatMap((segment) => {
		// A known wrapper's own `--` (npm exec jest -- -t x) must not hide the runner's selectors behind it.
		const peeled = unwrapRunner(segment.argv).argv;
		const start = runnerStart(peeled);
		if (start === null) return [];
		const words = peeled.slice(start.index);
		const { removed } = withoutSelectors(words, selectorsFor(start.runner), start.runner !== "node");
		// The raw scan covers only this runner's words and the values of variables those words expand, so a -f or
		// --shard of rm, tar or codecov elsewhere in the chain, or in an assignment no runner reads, is not a selector.
		const scanned = `${referencedValues(words, assigned)} ${words.join(" ")}`;
		return [{ runner: start.runner, words, removed, rawSelector: RAW_SELECTOR.exec(scanned)?.[1] }];
	});
	// Only a script with no identifiable runner command (sh -c, an expansion in the command word) is scanned whole.
	const rawSelector =
		runners.length > 0
			? runners.find((entry) => entry.rawSelector !== undefined)?.rawSelector
			: RAW_RUNNER.test(raw)
				? RAW_SELECTOR.exec(raw)?.[1]
				: undefined;
	if (runners.length === 0) {
		// A runner hidden behind sh -c or an expansion is not handled; a selector in the text still fails closed.
		if (rawSelector === undefined || nodeOnly) return null;
		return shapeRefusal(rawSelector);
	}
	const filters = [...new Set(runners.flatMap((entry) => entry.removed))];
	// A test/ file without a test suffix is a changed test only for a node runner whose discovery reaches it. When an
	// option makes that ambiguous, a selector still fails closed; only without one does the pre-fix silence apply.
	if (nodeOnly) {
		const reach = runners
			.filter((entry) => entry.runner === "node")
			.map((entry) => nodeRunsFile(entry.words, cwd, absolute));
		if (!reach.includes(true)) {
			const shown = filters.length > 0 ? filters.join(", ") : rawSelector;
			if (reach.includes("ambiguous") && shown !== undefined) {
				return shapeRefusal(shown);
			}
			return { ignored: true };
		}
	}
	const last = segments.at(-1);
	const unwrapped = last === undefined ? null : unwrapRunner(last.argv);
	const runner = unwrapped === null ? null : javascriptRunner(unwrapped.argv);
	const handled =
		parsed &&
		unwrapped !== null &&
		runner !== null &&
		(filters.length === 0 || segments.length === 1) &&
		!(nodeOnly && runner !== "node");
	if (!handled) {
		const shown = filters.length > 0 ? filters.join(", ") : rawSelector;
		if (shown !== undefined) {
			return shapeRefusal(shown);
		}
		return nodeOnly ? { ignored: true } : null;
	}
	const { kept } = withoutSelectors(unwrapped.argv, selectorsFor(runner), runner !== "node");
	const file = `./${path.relative(cwd, absolute).split(path.sep).join("/")}`;
	const flags = runner === "jest" ? ["--runTestsByPath"] : runner === "vitest" && !kept.includes("run") ? ["--run"] : [];
	const separator = kept.indexOf("--");
	const insertAt = separator < 0 ? kept.length : separator;
	const targeted = [...kept.slice(0, insertAt), ...flags, ...kept.slice(insertAt), file];
	if (!packageScript) return { argv: [...unwrapped.prefix, ...unwrapped.locator, ...targeted] };
	if (filters.length === 0) {
		const args = [...flags, file];
		// The check is already resolved; rediscovering from root would contain the read at the package root.
		const resolved = verifyResolutionArgv(
			{ kind: "package", check, packageRoot: path.dirname(check.source.path) },
			{ args },
		);
		return resolved === null ? null : { argv: resolved };
	}
	// `npm run <script> -- file` can only append, so a script whose own selector would exclude the changed file runs
	// its parsed runner directly. That drops npm's environment and pre/post hooks, which a targeted changed-test run
	// does not need; the evidence says so.
	const wrapper: string[] = [];
	if (unwrapped.prefix.length > 0) {
		const binary = localBinary(workspaceRoot, cwd, unwrapped.prefix[0] ?? "");
		if (binary === null) {
			return {
				refusal: `${label} filters tests with ${filters.join(", ")}, and its wrapper binary "${unwrapped.prefix[0]}" is not installed under node_modules/.bin`,
			};
		}
		wrapper.push(binary, ...unwrapped.prefix.slice(1));
	}
	let executable: string[];
	const binary = localBinary(workspaceRoot, cwd, targeted[0] ?? "");
	if (binary !== null) executable = [binary];
	// Yarn Plug'n'Play and pnpm-only layouts have no node_modules/.bin; their locator still finds the runner.
	else if (unwrapped.locator.length > 0) executable = [...unwrapped.locator, targeted[0] ?? ""];
	else {
		return {
			refusal: `${label} filters tests with ${filters.join(", ")}, and its runner binary "${targeted[0]}" is not installed under node_modules/.bin (Yarn Plug'n'Play or a missing install)`,
		};
	}
	const environment = last !== undefined && last.assignments.length > 0 ? ["env", ...last.assignments] : [];
	return { argv: [...environment, ...wrapper, ...executable, ...targeted.slice(1)], detail: DIRECT_RUN_DETAIL };
}

function declaredRunner(root: string, workspaceRoot: string, check: DeclaredCheck, filename: string): string[] | null {
	const packageScript = check.source.kind === "package.json";
	let argv = check.command;
	if (packageScript) {
		const pkg = parsePackageJson(check.source.path, workspaceRoot);
		const script = pkg.ok ? pkg.scripts[check.id] : null;
		if (typeof script !== "string") return null;
		const parsed = shellLikeArgv(script);
		if (parsed instanceof Error) return null;
		argv = parsed;
	} else if (check.kind !== "command") return null;
	filename = `./${path.relative(path.resolve(root, check.cwd), path.resolve(root, filename)).split(path.sep).join("/")}`;
	let args: string[];
	if (filename.endsWith(".py") && argv.includes("pytest")) args = [filename];
	else if (filename.endsWith(".py") && argv.includes("unittest")) {
		// unittest accepts a per-file discovery pattern even when tests/ is not an importable package.
		if (packageScript) return null;
		argv = argv.slice(0, argv.indexOf("unittest") + 1);
		args = ["discover", "-s", path.dirname(filename), "-p", path.basename(filename)];
	} else return null;
	if (!packageScript) return [...argv, ...args];
	// The check is already resolved; rediscovering from root would contain the read at the package root, not the workspace.
	return verifyResolutionArgv({ kind: "package", check, packageRoot: path.dirname(check.source.path) }, { args });
}

/** Resolve changed tests from the same project declarations verify uses, without guessing an installed runner. */
export function resolveTestFileChecks(
	workspaceRoot: string,
	mutatedPaths: ReadonlyArray<string>,
): { checks: TestFileCheck[]; notes: string[]; refusals: string[] } {
	workspaceRoot = path.resolve(workspaceRoot);
	const checks: TestFileCheck[] = [];
	const notes: string[] = [];
	// A changed test the declared runner cannot be made to run fails the check rather than passing silently.
	const refusals: string[] = [];
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
		const nodeOnly = !isTestFile(relative);
		if (nodeOnly && !isNodeTestDirectoryFile(relative)) continue;
		let root = path.dirname(absolute);
		while (
			root !== workspaceRoot &&
			!["package.json", "pyproject.toml", "go.mod", "Cargo.toml"].some((manifest) => existsSync(path.join(root, manifest)))
		) {
			root = path.dirname(root);
		}
		const local = `./${path.relative(root, absolute).split(path.sep).join("/")}`;
		const discovery = discoverDeclaredChecksAtRoot(root, undefined, workspaceRoot);
		const declared = discovery.ok ? discovery.sources.flatMap((source) => source.checks) : [];
		let resolved: TestFileCheck | undefined;
		let refusal: string | undefined;
		let ignored = false;
		for (const check of declared) {
			if (/\.[cm]?[jt]sx?$/u.test(local)) {
				const runner = javascriptRunnerArgv(workspaceRoot, root, check, local, nodeOnly);
				if (runner !== null && "refusal" in runner) {
					refusal ??= `Changed test ${relative} was not run: the project's ${runner.refusal}, so a targeted run cannot guarantee this file runs. Add a plain unfiltered test script or a check gate that runs it; do not edit or loosen the existing script to pass this check.`;
				} else if (runner !== null && "ignored" in runner) ignored = true;
				else if (runner !== null) {
					resolved = { check, argv: runner.argv, ...(runner.detail === undefined ? {} : { detail: runner.detail }) };
					break;
				}
				continue;
			}
			const argv = declaredRunner(root, workspaceRoot, check, local);
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
		if (resolved === undefined && refusal !== undefined) refusals.push(refusal);
		else if (resolved === undefined && !ignored) {
			notes.push(
				`Changed test ${relative}: no recognizable project runner; retained the declared check only for this file.`,
			);
		}
		if (resolved === undefined) continue;
		const cwd = path.relative(workspaceRoot, path.resolve(root, resolved.check.cwd)).split(path.sep).join("/");
		resolved = { ...resolved, check: { ...resolved.check, cwd: cwd || "." } };
		const identity = JSON.stringify([resolved.check.cwd, resolved.argv]);
		if (!seen.has(identity)) checks.push(resolved);
		seen.add(identity);
	}
	return { checks, notes, refusals };
}
