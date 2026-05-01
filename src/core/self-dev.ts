import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { getCachedDefaultRulePacks } from "../domains/safety/rule-pack-loader.js";
import { clioConfigDir } from "./xdg.js";

export const DEV_FILE_NAME = "CLIO-dev.md";

export function devSupplementCandidates(repoRoot: string): string[] {
	return [join(repoRoot, DEV_FILE_NAME), join(clioConfigDir(), DEV_FILE_NAME)];
}

export type SelfDevActivationSource = "--dev" | "CLIO_DEV=1" | "CLIO_SELF_DEV=1";

export interface SelfDevMode {
	enabled: true;
	source: SelfDevActivationSource;
	repoRoot: string;
	cwd: string;
	branch: string | null;
	dirtySummary: string;
	engineWritesAllowed: boolean;
}

export type SelfDevPathDecision =
	| { allowed: true; absolutePath: string; relativePath: string; restartRequired: boolean }
	| { allowed: false; absolutePath: string; relativePath: string; reason: string };

const SELF_DEV_RESTART_ROOT_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.tests.json",
	"tsup.config.ts",
	"biome.json",
	".gitignore",
	"damage-control-rules.yaml",
]);

const SELF_DEV_HOT_TOOL_FILES = new Set([
	"src/tools/bash.ts",
	"src/tools/edit.ts",
	"src/tools/glob.ts",
	"src/tools/grep.ts",
	"src/tools/ls.ts",
	"src/tools/read.ts",
	"src/tools/web-fetch.ts",
	"src/tools/write-plan.ts",
	"src/tools/write-review.ts",
	"src/tools/write.ts",
	"src/tools/codewiki/entry-points.ts",
	"src/tools/codewiki/find-symbol.ts",
	"src/tools/codewiki/where-is.ts",
]);

export function resolveRepoRoot(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
	let cursor = resolve(start);
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(cursor, "package.json")) && existsSync(join(cursor, "src"))) {
			return cursor;
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return null;
}

function readGit(repoRoot: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function readBranch(repoRoot: string): string | null {
	const branch = readGit(repoRoot, ["branch", "--show-current"]);
	return branch && branch.length > 0 ? branch : null;
}

function readDirtySummary(repoRoot: string): string {
	const status = readGit(repoRoot, ["status", "--short"]);
	if (!status) return "clean";
	const lines = status.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) return "clean";
	const sample = lines.slice(0, 6).join("; ");
	const suffix = lines.length > 6 ? `; plus ${lines.length - 6} more` : "";
	return `${lines.length} changed path(s): ${sample}${suffix}`;
}

/**
 * Returns the activation source the user signalled, or null when no
 * dev-mode signal is present. Used by the orchestrator to detect "user
 * intended dev mode but the gate failed" and exit 1 instead of
 * silently continuing.
 */
export function selfDevActivationSource(options: { cliDev?: boolean } = {}): SelfDevActivationSource | null {
	if (options.cliDev === true) return "--dev";
	if (process.env.CLIO_DEV === "1") return "CLIO_DEV=1";
	if (process.env.CLIO_SELF_DEV === "1") return "CLIO_SELF_DEV=1";
	return null;
}

export function resolveSelfDevMode(options: { cliDev?: boolean } = {}): SelfDevMode | null {
	const source = selfDevActivationSource(options);
	if (!source) return null;

	const repoRoot = resolveRepoRoot(process.cwd()) ?? resolveRepoRoot();
	if (!repoRoot) return null;

	const candidates = devSupplementCandidates(repoRoot);
	if (!candidates.some((path) => existsSync(path))) {
		process.stderr.write(
			`clio --dev: requires ${DEV_FILE_NAME} at ${candidates[0]} or ${candidates[1]}; create one to enable dev mode\n`,
		);
		return null;
	}

	process.env.CLIO_DEV = "1";
	process.env.CLIO_SELF_DEV = "1";

	return {
		enabled: true,
		source,
		repoRoot,
		cwd: process.cwd(),
		branch: readBranch(repoRoot),
		dirtySummary: readDirtySummary(repoRoot),
		engineWritesAllowed: process.env.CLIO_DEV_ALLOW_ENGINE_WRITES === "1",
	};
}

function repoRelative(
	repoRoot: string,
	target: string,
): { absolutePath: string; relativePath: string; inside: boolean } {
	const absolutePath = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
	const rawRelative = relative(repoRoot, absolutePath);
	const inside = rawRelative.length === 0 || (!rawRelative.startsWith("..") && !isAbsolute(rawRelative));
	const relativePath = rawRelative.split(sep).join("/");
	return { absolutePath, relativePath, inside };
}

function isProtectedBranch(branch: string | null): boolean {
	return branch === null || branch === "main" || branch === "master" || branch === "trunk";
}

function selfDevRestartRequired(rel: string): boolean {
	if (SELF_DEV_RESTART_ROOT_FILES.has(rel)) return true;
	if (rel.startsWith("src/tools/")) {
		return rel.endsWith(".ts") && !SELF_DEV_HOT_TOOL_FILES.has(rel);
	}
	if (rel.startsWith("src/worker/")) return false;
	return (
		rel.startsWith("src/engine/") ||
		rel.startsWith("src/core/") ||
		rel.startsWith("src/domains/") ||
		rel.startsWith("src/interactive/") ||
		rel.startsWith("src/entry/") ||
		rel.startsWith("src/cli/") ||
		rel.startsWith("src/harness/") ||
		rel.startsWith("src/")
	);
}

export function evaluateSelfDevWritePath(mode: SelfDevMode, target: string): SelfDevPathDecision {
	const resolved = repoRelative(mode.repoRoot, target);
	if (!resolved.inside) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: resolved.relativePath,
			reason: `self-dev: writes outside the Clio repository are blocked: ${target}`,
		};
	}

	const rel = resolved.relativePath;
	if (rel === ".git" || rel.startsWith(".git/")) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: rel,
			reason: "self-dev: direct writes under .git are blocked",
		};
	}
	if (rel.startsWith("tests/fixtures/")) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: rel,
			reason: "self-dev: test fixtures are read-only",
		};
	}
	if (rel.startsWith("docs/.superpowers/boundaries/") || rel.startsWith("docs/boundaries/")) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: rel,
			reason: "self-dev: boundary audit records are read-only",
		};
	}
	if (rel.startsWith("src/engine/") && !mode.engineWritesAllowed) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: rel,
			reason: "self-dev: src/engine writes require CLIO_DEV_ALLOW_ENGINE_WRITES=1 and a restart afterward",
		};
	}
	const currentBranch = readBranch(mode.repoRoot) ?? mode.branch;
	if (rel.startsWith("src/") && isProtectedBranch(currentBranch)) {
		return {
			allowed: false,
			absolutePath: resolved.absolutePath,
			relativePath: rel,
			reason: `self-dev: src writes require a non-main git branch, current branch is ${currentBranch ?? "detached"}`,
		};
	}
	return {
		allowed: true,
		absolutePath: resolved.absolutePath,
		relativePath: rel,
		restartRequired: selfDevRestartRequired(rel),
	};
}

/**
 * Evaluate a bash command against the dev rule pack loaded from
 * damage-control-rules.yaml. Returns the rule description on a match,
 * null when the command is allowed. The rule list lives in the yaml file
 * under packs[id=dev]; this function is a thin lookup over it so adding
 * a new self-dev block is a one-line yaml change.
 */
export function evaluateSelfDevBashCommand(command: string): string | null {
	if (command.length === 0) return null;
	const packs = getCachedDefaultRulePacks();
	for (const rule of packs.dev.rules) {
		if (rule.pattern.test(command)) return rule.description;
	}
	return null;
}

export interface EnsureSelfDevBranchOptions {
	/** Override how the current branch is read. Default uses git rev-parse on the repo. */
	readBranch?: (repoRoot: string) => string | null;
	/** Override how a slug is collected. Default uses node:readline/promises on stdin/stderr. */
	promptSlug?: () => Promise<string | null>;
	/** Override how the new branch is created. Default invokes git switch -c via execFileSync. */
	runGit?: (repoRoot: string, args: string[]) => void;
	/** Override the date stamp used in the new branch name. Default is today's ISO date. */
	now?: () => Date;
}

function defaultPromptSlug(): Promise<string | null> {
	if (!process.stdin.isTTY) return Promise.resolve(null);
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return rl.question("clio --dev: enter a slug for the new selfdev/ branch (blank to cancel): ").then(
		(answer) => {
			rl.close();
			return answer;
		},
		() => {
			rl.close();
			return null;
		},
	);
}

function defaultRunGit(repoRoot: string, args: string[]): void {
	execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function sanitizeSelfDevSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

/**
 * When self-dev resolves on main/master/trunk (or detached HEAD), prompt the
 * user for a slug and create a `selfdev/YYYY-MM-DD-<slug>` branch via
 * `git switch -c`. Returns the input mode unchanged on a non-protected
 * branch. Returns null on cancellation or git failure; the orchestrator
 * surfaces that as an exit-1 boot.
 */
export async function ensureSelfDevBranch(
	mode: SelfDevMode,
	opts: EnsureSelfDevBranchOptions = {},
): Promise<SelfDevMode | null> {
	const readBranchFn = opts.readBranch ?? readBranch;
	const promptSlug = opts.promptSlug ?? defaultPromptSlug;
	const runGit = opts.runGit ?? defaultRunGit;
	const now = opts.now ?? (() => new Date());

	const branch = readBranchFn(mode.repoRoot);
	if (!isProtectedBranch(branch)) {
		return mode;
	}
	if (process.env.CLIO_DEV_ALLOW_PROTECTED_BRANCH === "1") {
		// Opt-out for tests and advanced users that take responsibility for the
		// branch they are on. Mirrors CLIO_DEV_ALLOW_ENGINE_WRITES. The
		// evaluateSelfDevWritePath guard still blocks tool-driven writes under
		// src/ on protected branches, so this only relaxes the boot prompt.
		return mode;
	}

	process.stderr.write(
		`clio --dev: refusing to operate on ${branch ?? "detached HEAD"}; will create a selfdev/ branch\n`,
	);

	let raw: string | null;
	try {
		raw = await promptSlug();
	} catch {
		raw = null;
	}
	if (raw === null) {
		process.stderr.write("clio --dev: cancelled, no slug supplied\n");
		return null;
	}
	const slug = sanitizeSelfDevSlug(raw);
	if (slug.length === 0) {
		process.stderr.write("clio --dev: cancelled, no slug supplied\n");
		return null;
	}
	const date = now().toISOString().slice(0, 10);
	const newBranch = `selfdev/${date}-${slug}`;
	try {
		runGit(mode.repoRoot, ["switch", "-c", newBranch]);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`clio --dev: git switch -c ${newBranch} failed: ${message}\n`);
		return null;
	}
	return { ...mode, branch: newBranch };
}

export function buildSelfDevPrompt(mode: SelfDevMode): string {
	return [
		"# Clio self-development mode",
		"",
		`You are running inside the Clio Coder repository at ${mode.repoRoot}.`,
		`The process current working directory is ${mode.cwd}.`,
		`The active git branch is ${mode.branch ?? "detached"}.`,
		`The current worktree state at boot was ${mode.dirtySummary}.`,
		"",
		"Self-development rules:",
		"1. You may read and edit Clio Coder source files under user supervision.",
		"2. Preserve the engine boundary, worker isolation, and domain independence invariants.",
		"3. Do not push, force, reset hard, clean with force, or bypass git safety rails.",
		"4. Do not write test fixtures or boundary audit records.",
		"5. Do not write src/engine/ unless the user explicitly opted in with CLIO_DEV_ALLOW_ENGINE_WRITES=1.",
		"6. If a write touches restart-required source, tool infrastructure, or root config, tell the user the running Clio process needs a restart.",
		"7. Run npm run ci successfully before proposing merge or handoff.",
		"8. Treat OpenAI Codex OAuth as the preferred provider path for self-development when it is configured.",
	].join("\n");
}
