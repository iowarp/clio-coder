import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

export function resolveSelfDevMode(options: { cliDev?: boolean } = {}): SelfDevMode | null {
	let source: SelfDevActivationSource | null = null;
	if (options.cliDev === true) source = "--dev";
	else if (process.env.CLIO_DEV === "1") source = "CLIO_DEV=1";
	else if (process.env.CLIO_SELF_DEV === "1") source = "CLIO_SELF_DEV=1";
	if (!source) return null;

	const repoRoot = resolveRepoRoot(process.cwd()) ?? resolveRepoRoot();
	if (!repoRoot) return null;

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
		restartRequired: rel.startsWith("src/engine/"),
	};
}

export function evaluateSelfDevBashCommand(command: string): string | null {
	const checks: Array<{ pattern: RegExp; reason: string }> = [
		{ pattern: /(?:^|[;&|]\s*)git\s+push\b/, reason: "self-dev: git push is blocked" },
		{ pattern: /\bgit\b[^;&|]*\s--force(?:-with-lease)?\b/, reason: "self-dev: git force flags are blocked" },
		{ pattern: /\bgit\b[^;&|]*\s-f(?:\s|$)/, reason: "self-dev: git force shorthand is blocked" },
		{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "self-dev: git reset --hard is blocked" },
		{ pattern: /\bgit\s+clean\b[^;&|]*\s-[A-Za-z]*f[A-Za-z]*\b/, reason: "self-dev: git clean with force is blocked" },
		{ pattern: /\bgit\s+checkout\s+--(?:\s|$)/, reason: "self-dev: destructive git checkout syntax is blocked" },
		{ pattern: /\bgh\s+pr\s+merge\b/, reason: "self-dev: hosted PR merge commands are blocked" },
	];
	for (const check of checks) {
		if (check.pattern.test(command)) return check.reason;
	}
	return null;
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
		"6. If src/engine/ changes, tell the user the running Clio process needs a restart.",
		"7. Run npm run ci successfully before proposing merge or handoff.",
		"8. Treat OpenAI Codex OAuth as the preferred provider path for self-development when it is configured.",
	].join("\n");
}
