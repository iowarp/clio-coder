import { readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import { testRunExecutes } from "../../tools/verify/test-files.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "./execution-plan.js";

export interface FleetCommitPriorResult {
	succeeded: boolean;
	integrityValid: boolean;
	runDigest: string;
	/** Decision refs from the step's run; they become `Clio-Decision:` trailers. */
	decisionRefs?: ReadonlyArray<string>;
}

/**
 * Derive one fleet commit's semantic attribution from scheduler-owned facts.
 * Agent output text is deliberately absent from this input: prose cannot turn
 * into testing or review evidence.
 */
export function deriveFleetCommitAttribution(input: {
	plan: ExecutionPlan;
	step: ExecutionPlanCodeStep;
	priorResults: ReadonlyMap<string, FleetCommitPriorResult>;
	validationFresh: boolean;
	independentReviewFresh: boolean;
}): CommitAttributionEvidence {
	const byId = new Map(input.plan.steps.map((step) => [step.id, step] as const));
	let materiallyAuthored = false;
	let run: CommitAttributionEvidence["run"];
	let decisions: CommitAttributionEvidence["decisions"];
	for (const candidate of input.step.commitFrom ?? []) {
		const source = byId.get(candidate);
		const result = input.priorResults.get(candidate);
		if (
			source?.kind !== "agent" ||
			source.scope !== "workspace" ||
			result?.succeeded !== true ||
			result.integrityValid !== true
		) {
			continue;
		}
		materiallyAuthored = true;
		if (result.decisionRefs !== undefined && result.decisionRefs.length > 0) decisions = [...result.decisionRefs];
		if (/^[0-9a-f]{64}$/u.test(result.runDigest)) {
			run = {
				version: 1,
				algorithm: "sha256",
				digest: result.runDigest,
				integrityValid: true,
				directlyRelevant: true,
			};
		}
		break;
	}
	return {
		materiallyAssisted: materiallyAuthored,
		materiallyAuthored,
		validationSucceeded: input.validationFresh,
		independentReviewPassed: input.independentReviewFresh,
		...(run === undefined ? {} : { run }),
		...(decisions === undefined ? {} : { decisions }),
	};
}

/** Package manifests and package-manager configs: their scripts and settings decide what a check runs. */
const PACKAGE_CONFIG_FILES = new Set([
	"package.json",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	"pnpm-workspace.yaml",
	"bunfig.toml",
	"deno.json",
	"deno.jsonc",
]);
/** Test-runner, compiler and build configs a check reads without naming them, and Python and make equivalents. */
const RUNNER_CONFIG_FILES = new Set([
	"pytest.ini",
	"conftest.py",
	"tox.ini",
	"pyproject.toml",
	"setup.cfg",
	"Makefile",
	"makefile",
	"GNUmakefile",
]);
const RUNNER_CONFIG_PATTERNS = [
	/^(?:vitest|vite|jest|playwright|ava|cypress|karma|babel|mocha)\.(?:config|workspace|setup)(?:\.[\w-]+)?\.(?:[cm]?[jt]sx?|json)$/u,
	/^tsconfig(?:\.[\w-]+)?\.json$/u,
	/^\.(?:mocharc|babelrc|c8rc|nycrc)(?:\.[\w-]+)?$/u,
];
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const SCRIPT_DEPTH = 4;

function isCheckConfigFile(name: string): boolean {
	return (
		PACKAGE_CONFIG_FILES.has(name) ||
		RUNNER_CONFIG_FILES.has(name) ||
		RUNNER_CONFIG_PATTERNS.some((pattern) => pattern.test(name))
	);
}

/** The script a package-manager argv runs (`pnpm test`, `npm run check`), or null for anything else. */
function packageScriptName(argv: ReadonlyArray<string>): string | null {
	const executable = posix.basename((argv[0] ?? "").replaceAll("\\", "/")).replace(/\.(?:cmd|exe)$/iu, "");
	if (!PACKAGE_MANAGERS.has(executable)) return null;
	const rest = argv.slice(1).filter((token) => !token.startsWith("-"));
	const name = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
	return name === undefined || name === "" ? null : name;
}

function readPackageScripts(workspaceRoot: string, dir: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(workspaceRoot, dir, "package.json"), "utf8")) as { scripts?: unknown };
		return typeof manifest.scripts === "object" && manifest.scripts !== null
			? (manifest.scripts as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

interface RanCommand {
	argv: ReadonlyArray<string>;
	cwd: string;
}

/**
 * The repository-relative files a command names, and into `ran` the command and, with `workspaceRoot`, each command
 * its package.json script (with its pre and post scripts, and scripts it runs in turn) runs, whose files count too.
 */
function commandOperands(
	command: RanCommand,
	workspaceRoot: string | undefined,
	operands: Set<string>,
	ran: RanCommand[],
	depth: number,
	seen: Set<string>,
): void {
	ran.push(command);
	for (const [index, token] of command.argv.entries()) {
		const value = token.startsWith("-") ? (token.includes("=") ? token.slice(token.indexOf("=") + 1) : "") : token;
		if (value === "" || /\s/u.test(value) || (index === 0 && !value.includes("/"))) continue;
		const resolved = posix.normalize(posix.join(command.cwd, value));
		if (!resolved.startsWith("../") && !posix.isAbsolute(resolved)) operands.add(resolved);
	}
	if (workspaceRoot === undefined || depth >= SCRIPT_DEPTH) return;
	const name = packageScriptName(command.argv);
	if (name === null) return;
	const scripts = readPackageScripts(workspaceRoot, command.cwd);
	if (scripts === undefined) return;
	for (const script of [`pre${name}`, name, `post${name}`]) {
		const body = scripts[script];
		const key = `${command.cwd}\0${script}`;
		if (typeof body !== "string" || seen.has(key)) continue;
		seen.add(key);
		for (const segment of body.split(/&&|\|\||[;|]/u)) {
			const argv = segment
				.trim()
				.split(/\s+/u)
				.map((token) => token.replace(/^(["'])(.*)\1$/u, "$2"))
				.filter((token) => token !== "");
			if (argv.length > 0) commandOperands({ argv, cwd: command.cwd }, workspaceRoot, operands, ran, depth + 1, seen);
		}
	}
}

/**
 * The check's own files among `changedPaths` (repository-relative), over every command the check step ran: its
 * registered command and each changed-test command a loop check added. They are any package manifest or
 * package-manager config, any runner, compiler or build config (`isCheckConfigFile`), any file a command names, and,
 * given `workspaceRoot`, any file named by the package.json script a package-manager command runs, and any test one of
 * those commands' test runners could execute through its own discovery or path filters (`pnpm test` running
 * `node --test` picks up a test the worker added). A pass over files the worker wrote earns no `Tested-by` trailer.
 * Other files under a directory a command names are the code under check, not the check, so they do not count. A command's `cwd` is repository-relative, or absolute under `workspaceRoot`.
 */
export function changedCheckFiles(
	commands: ReadonlyArray<{ argv: ReadonlyArray<string>; cwd: string }>,
	changedPaths: Iterable<string>,
	workspaceRoot?: string,
): string[] {
	const operands = new Set<string>();
	const ran: RanCommand[] = [];
	const seen = new Set<string>();
	for (const command of commands) {
		let cwd = command.cwd;
		if (isAbsolute(cwd)) {
			if (workspaceRoot === undefined) continue;
			cwd = relative(workspaceRoot, cwd).split(sep).join("/");
			if (cwd.startsWith("..") || isAbsolute(cwd)) continue;
		}
		commandOperands({ argv: command.argv, cwd }, workspaceRoot, operands, ran, 0, seen);
	}
	// Paths resolve against the workspace, or any root when there is none: only their relation to a cwd matters.
	const base = workspaceRoot ?? resolve(sep);
	const executes = (path: string) =>
		ran.some((command) => testRunExecutes(command.argv, resolve(base, command.cwd), resolve(base, path)));
	const hits = new Set<string>();
	for (const path of changedPaths) {
		const segments = path.split("/");
		if (segments.includes("node_modules")) continue;
		if (isCheckConfigFile(segments.at(-1) ?? "") || operands.has(path) || executes(path)) hits.add(path);
	}
	return [...hits].sort();
}

const NO_OP_COMMANDS = new Set(["true", ":"]);
const NO_OP_SCRIPTS = /^\s*(?:true|:|exit\s+0)?\s*;?\s*$/u;

/**
 * A check whose argv cannot fail (`true`, `:`, or a shell running only that) proves nothing, so its pass earns no
 * `Tested-by` trailer. The registry is repository-owned; this only refuses the trivially vacuous forms.
 */
export function isVacuousCheckArgv(argv: ReadonlyArray<string>): boolean {
	const [program, ...rest] = argv;
	if (program === undefined) return true;
	const name = program.split("/").at(-1) ?? program;
	if (NO_OP_COMMANDS.has(name) && rest.length === 0) return true;
	if (["sh", "bash", "dash", "zsh"].includes(name) && rest.length === 2 && rest[0] === "-c")
		return NO_OP_SCRIPTS.test(rest[1] ?? "");
	return false;
}
