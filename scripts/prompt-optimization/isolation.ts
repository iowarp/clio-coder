/**
 * Per-trial isolation: a fresh Clio home and a fresh workspace, every time.
 *
 * State leaking between trials is the failure mode that would quietly invalidate
 * the whole experiment. A session ledger, a workspace code map, a cached
 * compiled prompt, or a remembered skill activation surviving from trial N into
 * trial N+1 makes the second trial cheaper for reasons that have nothing to do
 * with its arm. So each trial gets its own directory tree, and the five
 * `CLIO_CODER_*` roots move in lockstep — the per-root vars beat
 * `CLIO_CODER_HOME`, so setting only the home would silently inherit whatever
 * the operator's shell had.
 *
 * `CLIO_CODER_REQUIRE_HOME_PREFIX=1` turns a leak into a crash rather than a
 * quietly contaminated trial.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { sha256 } from "../../src/domains/prompts/hash.js";
import type { PromptAbPinnedConfig, PromptAbScenario } from "./contract.js";

export interface PromptAbTrialSandbox {
	root: string;
	home: string;
	workspace: string;
	env: NodeJS.ProcessEnv;
	/** Digest of every workspace file as seeded, for mutation detection. */
	baseline: ReadonlyMap<string, string>;
	dispose: () => void;
}

/**
 * Settings written into each trial's isolated config dir.
 *
 * Every trial gets the identical pinned target, so the model, runtime, and
 * endpoint are constants of the experiment rather than whatever the operator's
 * real settings happen to say that afternoon.
 */
function pinnedSettingsYaml(pinned: PromptAbPinnedConfig): string {
	return [
		"version: 2",
		"targets:",
		`  - id: ${pinned.target}`,
		`    runtime: ${pinned.runtime}`,
		`    url: ${pinned.targetUrl}`,
		`    defaultModel: ${pinned.model}`,
		"    wireModels:",
		`      - ${pinned.model}`,
		"chat:",
		`  target: ${pinned.target}`,
		`  model: ${pinned.model}`,
		`  thinkingLevel: ${pinned.thinking}`,
		// Without a fleet block there is no worker target, so dispatch cannot
		// fire at all. Every delegation scenario then failed identically in both
		// arms and measured nothing: `dispatches-scout` was 0-pass across the
		// board, which reads as "neither prompt delegates" when the truth is
		// "the sandbox had nowhere to delegate to". Workers run on the same
		// pinned target as the parent so the comparison stays single-target.
		"fleet:",
		"  nodes: []",
		"  default:",
		`    target: ${pinned.target}`,
		`    model: ${pinned.model}`,
		`    thinkingLevel: ${pinned.thinking}`,
		"  profiles:",
		"    code:",
		`      target: ${pinned.target}`,
		`      model: ${pinned.model}`,
		`      thinkingLevel: ${pinned.thinking}`,
		"",
	].join("\n");
}

export interface CreateSandboxOptions {
	/**
	 * The arm's checkout, used to install the skills a scenario names.
	 *
	 * It must be the arm's own tree rather than a shared one: skill descriptors
	 * are themselves under test, so installing arm A's descriptors into arm B's
	 * trial would silently erase half the treatment.
	 */
	armCheckout: string;
	/** Skill names to install into the trial's config dir, e.g. `clio-coder-dev`. */
	installSkills: readonly string[];
}

export function createPromptAbSandbox(
	scenario: PromptAbScenario,
	pinned: PromptAbPinnedConfig,
	options?: CreateSandboxOptions,
): PromptAbTrialSandbox {
	const root = mkdtempSync(join(tmpdir(), "clio-prompt-ab-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	for (const dir of ["config", "data", "state", "cache"]) mkdirSync(join(home, dir), { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(home, "config", "settings.yaml"), pinnedSettingsYaml(pinned), "utf8");
	if (options !== undefined) installSkillsInto(home, options);

	for (const file of scenario.workspace.files) {
		const target = join(workspace, file.path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, file.content, "utf8");
	}

	return {
		root,
		home,
		workspace,
		env: {
			CLIO_CODER_HOME: home,
			CLIO_CODER_CONFIG_DIR: join(home, "config"),
			CLIO_CODER_DATA_DIR: join(home, "data"),
			CLIO_CODER_STATE_DIR: join(home, "state"),
			CLIO_CODER_CACHE_DIR: join(home, "cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		},
		baseline: digestTree(workspace),
		dispose() {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// A trial that cannot clean its own scratch has already reported
				// whatever went wrong; the run root is collected either way.
			}
		},
	};
}

/**
 * Install the named skills from the arm's checkout into the trial's config dir.
 *
 * A fresh Clio home has no skills at all, so a scenario asking for
 * `/skill clio-coder-dev` could never succeed: `loads-exactly-the-named-skill`
 * was 0-pass in both arms across every trial, which is a gate measuring the
 * empty sandbox rather than either prompt. Skills live at
 * `<config>/skills/<name>/`; in a checkout they are nested by category under
 * `skills/`, so the directory is located by name rather than assumed.
 */
function installSkillsInto(home: string, options: CreateSandboxOptions): void {
	if (options.installSkills.length === 0) return;
	const skillsRoot = join(options.armCheckout, "skills");
	let categories: string[];
	try {
		categories = readdirSync(skillsRoot);
	} catch {
		return;
	}
	for (const name of options.installSkills) {
		for (const category of categories) {
			const source = join(skillsRoot, category, name);
			if (statSync(join(source, "SKILL.md"), { throwIfNoEntry: false }) === undefined) continue;
			const destination = join(home, "config", "skills", name);
			mkdirSync(destination, { recursive: true });
			cpSync(source, destination, { recursive: true });
			break;
		}
	}
}

/** Workspace paths whose content differs from the seeded baseline, plus anything added or removed. */
export function workspaceMutations(sandbox: PromptAbTrialSandbox): string[] {
	const current = digestTree(sandbox.workspace);
	const changed = new Set<string>();
	for (const [path, digest] of current) {
		if (sandbox.baseline.get(path) !== digest) changed.add(path);
	}
	for (const path of sandbox.baseline.keys()) {
		if (!current.has(path)) changed.add(path);
	}
	return [...changed].sort();
}

/**
 * Paths under a scenario's `forbidState` list that now exist.
 *
 * This is how "no `.clio-coder` was written into the foreign project" becomes a
 * counted fact rather than an assumption.
 */
export function forbiddenStatePaths(sandbox: PromptAbTrialSandbox, scenario: PromptAbScenario): string[] {
	return scenario.workspace.forbidState
		.filter((path) => statSync(join(sandbox.workspace, path), { throwIfNoEntry: false }) !== undefined)
		.sort();
}

/**
 * Assert two sandboxes share no directory. Cheap, and it catches the one bug
 * that would invalidate every number the run produces.
 */
export function assertDisjointSandboxes(left: PromptAbTrialSandbox, right: PromptAbTrialSandbox): void {
	if (left.root === right.root) throw new Error(`prompt-ab sandboxes collided at ${left.root}`);
	const inside = (outer: string, inner: string): boolean => {
		const rel = relative(outer, inner);
		return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
	};
	if (inside(left.root, right.root) || inside(right.root, left.root)) {
		throw new Error(`prompt-ab sandbox ${left.root} contains ${right.root}`);
	}
}

/** Copy a directory into a sandbox workspace, used by fixtures too large to inline. */
export function seedFromDirectory(sandbox: PromptAbTrialSandbox, source: string): void {
	cpSync(source, sandbox.workspace, { recursive: true });
}

function digestTree(root: string): Map<string, string> {
	const digests = new Map<string, string>();
	const walk = (dir: string): void => {
		let listing: string[];
		try {
			listing = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of listing) {
			const full = join(dir, name);
			const stats = statSync(full, { throwIfNoEntry: false });
			if (stats === undefined) continue;
			if (stats.isDirectory()) {
				walk(full);
				continue;
			}
			if (!stats.isFile()) continue;
			try {
				digests.set(relative(root, full).split(sep).join("/"), sha256(readFileSync(full, "utf8")));
			} catch {
				digests.set(relative(root, full).split(sep).join("/"), "unreadable");
			}
		}
	};
	walk(root);
	return digests;
}
