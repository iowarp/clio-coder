import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fsyncDirectory } from "../../../core/safe-resource-write.js";
import { clioConfigDir } from "../../../core/xdg.js";
import { frontmatterRegion, normalizedSkillHash, stripProvenanceLines } from "./content-hash.js";
import { loadSkills, type Skill } from "./loader.js";

export { normalizedSkillHash, stripProvenanceFrontmatter } from "./content-hash.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLONE_TIMEOUT_MS = 60_000;

/** True when the value has the bare skill-name shape (lowercase, hyphenated). */
export function isSkillName(value: string): boolean {
	return value.length > 0 && value.length <= 64 && SKILL_NAME_PATTERN.test(value);
}

export type SkillSourceSpec =
	| { kind: "local"; path: string; original: string }
	| { kind: "github"; cloneUrl: string; branch: string; filePath: string; original: string };

export interface InstallSkillInput {
	source: string;
	scope?: "user" | "project";
	cwd?: string;
	/** Override the destination directory / skill name. */
	name?: string;
	force?: boolean;
	/** Override the Clio config dir used for the user root (testing). */
	configDir?: string;
}

export interface InstallSkillResult {
	name: string;
	scope: "user" | "project";
	/** Installed SKILL.md path. */
	path: string;
	sourceUrl: string;
	installedHash: string;
	warnings: string[];
}

export type SkillUpdateStatus = "up-to-date" | "updated" | "local-changes" | "no-source" | "error";

export interface SkillUpdateReport {
	name: string;
	status: SkillUpdateStatus;
	detail?: string;
}

export interface UpdateSkillsInput {
	cwd?: string;
	configDir?: string;
	/** Update a single skill by name; otherwise requires all=true. */
	name?: string;
	all?: boolean;
	/** Overwrite local modifications. */
	force?: boolean;
}

/**
 * A path inside a cloned repository, and nothing else. The URL pattern's tail
 * is free-form, so `.../blob/main/../../../etc` would join out of the clone
 * directory and install from somewhere on the operator's own disk instead of
 * from the repository they named.
 */
function repoRelativePath(filePath: string): string | null {
	if (path.isAbsolute(filePath) || filePath.includes("\0")) return null;
	const segments = filePath.split("/");
	if (segments.some((segment) => segment === "..")) return null;
	const normalized = path.posix.normalize(filePath);
	if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null;
	return normalized;
}

export function parseSkillSourceSpec(source: string): SkillSourceSpec | null {
	const trimmed = source.trim();
	if (trimmed.length === 0) return null;
	const browser = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+?)\/?$/);
	if (browser?.[1] && browser[2] && browser[3] && browser[4]) {
		const filePath = repoRelativePath(browser[4]);
		if (!filePath) return null;
		return {
			kind: "github",
			cloneUrl: `https://github.com/${browser[1]}/${browser[2]}.git`,
			branch: browser[3],
			filePath,
			original: trimmed,
		};
	}
	const raw = trimmed.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+?)\/?$/);
	if (raw?.[1] && raw[2] && raw[3] && raw[4]) {
		const filePath = repoRelativePath(raw[4]);
		if (!filePath) return null;
		return {
			kind: "github",
			cloneUrl: `https://github.com/${raw[1]}/${raw[2]}.git`,
			branch: raw[3],
			filePath,
			original: trimmed,
		};
	}
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
	const expanded = trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(2)) : trimmed;
	return { kind: "local", path: path.resolve(expanded), original: trimmed };
}

function yamlQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface ProvenanceFields {
	sourceUrl: string;
	installedAt: string;
	updatedAt?: string;
	installedHash: string;
}

/**
 * Replace install-lifecycle frontmatter with the recorded fields, written
 * nested under the reserved `clio:` block (merged into an existing block-style
 * `clio:` mapping when the skill carries one). Registry identity lines
 * (`registry-id`, `registry-url`) are content, not lifecycle, so they survive
 * the install and keep pinned drift checks working on the installed copy.
 *
 * A flow-style `clio: {...}` value cannot take appended block lines, so that
 * rare shape falls back to the legacy flat stamps, which the hash and loader
 * still understand.
 */
function injectProvenanceFrontmatter(rawText: string, fields: ProvenanceFields): string {
	const region = frontmatterRegion(rawText);
	if (!region) throw new Error("skill file is missing YAML frontmatter");
	// Same removal the hash uses, so what is written and what is compared can
	// never disagree about which lines the install lifecycle owns.
	const kept = stripProvenanceLines(region.lines);
	const stamps = [
		`source-url: ${yamlQuote(fields.sourceUrl)}`,
		`installed-at: ${yamlQuote(fields.installedAt)}`,
		...(fields.updatedAt ? [`updated-at: ${yamlQuote(fields.updatedAt)}`] : []),
		`installed-hash: ${yamlQuote(fields.installedHash)}`,
		// Audit is a human decision; installs always land unreviewed.
		"audit: unknown",
	];
	const clioIndex = kept.findIndex((line) => /^clio:/.test(line));
	if (clioIndex >= 0 && !/^clio:\s*$/.test(kept[clioIndex] as string)) {
		return `${region.head}${[...kept, ...stamps].join("\n")}${region.tail}`;
	}
	const nested = stamps.map((line) => `  ${line}`);
	if (clioIndex < 0) {
		return `${region.head}${[...kept, "clio:", ...nested].join("\n")}${region.tail}`;
	}
	let blockEnd = clioIndex + 1;
	while (blockEnd < kept.length) {
		const line = kept[blockEnd] as string;
		if (line.trim().length > 0 && !/^[ \t]/.test(line)) break;
		blockEnd += 1;
	}
	return `${region.head}${[...kept.slice(0, blockEnd), ...nested, ...kept.slice(blockEnd)].join("\n")}${region.tail}`;
}

function resolveSkillDir(target: string): string {
	if (!existsSync(target)) throw new Error(`skill source path does not exist: ${target}`);
	const stat = statSync(target);
	if (stat.isFile()) {
		if (!target.endsWith(".md")) throw new Error(`skill source must be a SKILL.md file or directory: ${target}`);
		return path.dirname(target);
	}
	if (!existsSync(path.join(target, "SKILL.md"))) {
		throw new Error(`skill source directory has no SKILL.md: ${target}`);
	}
	return target;
}

interface FetchedSource {
	skillDir: string;
	cleanup: () => void;
}

function fetchSource(spec: SkillSourceSpec): FetchedSource {
	if (spec.kind === "local") {
		return { skillDir: resolveSkillDir(spec.path), cleanup: () => {} };
	}
	const tmp = mkdtempSync(path.join(tmpdir(), "clio-skill-"));
	const cleanup = (): void => rmSync(tmp, { recursive: true, force: true });
	try {
		execFileSync("git", ["clone", "--depth", "1", "--branch", spec.branch, spec.cloneUrl, tmp], {
			stdio: "pipe",
			timeout: CLONE_TIMEOUT_MS,
		});
		const target = path.join(tmp, spec.filePath);
		// A clone that succeeded but has no skill at that path is the common
		// failure for a published index whose entries moved, or that names a
		// branch the layout has not reached yet. Reporting the temp clone path
		// describes a directory the operator never chose; name the repository,
		// the branch, and the path they can actually check.
		if (!existsSync(target)) {
			throw new Error(
				`${spec.cloneUrl} (branch ${spec.branch}) has no ${spec.filePath}; the source-url may name a path that branch does not carry`,
			);
		}
		return { skillDir: resolveSkillDir(target), cleanup };
	} catch (err) {
		cleanup();
		throw err instanceof Error ? err : new Error(String(err));
	}
}

function copySkillDir(from: string, to: string): void {
	mkdirSync(path.dirname(to), { recursive: true });
	cpSync(from, to, {
		recursive: true,
		filter: (source) => {
			const base = path.basename(source);
			return base !== ".git" && base !== "node_modules";
		},
	});
}

let skillSwapSequence = 0;

/**
 * Replace one skill directory by staged swap rather than destroying it first.
 *
 * `rmSync(dest)` followed by a copy is not recoverable: a copy that fails
 * partway, or a process that dies between the two, leaves the operator with a
 * skill that is half its old self or gone entirely, and the thing destroyed is
 * the only local copy. The staging directory and the backup are siblings of
 * the destination so both renames stay on one filesystem and are therefore
 * atomic, and a failure after the destination moves aside puts it back.
 */
function swapSkillDir(stage: (stagingDir: string) => void, dest: string): void {
	const suffix = `${process.pid}-${++skillSwapSequence}`;
	const staging = `${dest}.clio-staging-${suffix}`;
	const backup = `${dest}.clio-backup-${suffix}`;
	rmSync(staging, { recursive: true, force: true });
	try {
		stage(staging);
	} catch (err) {
		rmSync(staging, { recursive: true, force: true });
		throw err;
	}
	const hadPrevious = existsSync(dest);
	if (hadPrevious) renameSync(dest, backup);
	try {
		renameSync(staging, dest);
	} catch (err) {
		if (hadPrevious) renameSync(backup, dest);
		rmSync(staging, { recursive: true, force: true });
		throw err;
	}
	if (hadPrevious) rmSync(backup, { recursive: true, force: true });
	fsyncDirectory(path.dirname(dest));
}

function destinationRoot(scope: "user" | "project", cwd: string, configDir?: string): string {
	return scope === "user" ? path.join(configDir ?? clioConfigDir(), "skills") : path.join(cwd, ".clio", "skills");
}

/** Validate a fetched skill directory and return its single loaded skill. */
function validateSourceSkill(skillDir: string): { skill: Skill; warnings: string[] } {
	const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [skillDir] });
	const errors = list.diagnostics.filter((diag) => diag.type === "error");
	if (errors.length > 0) {
		throw new Error(`skill source failed validation: ${errors.map((diag) => diag.message).join("; ")}`);
	}
	const skill = list.items[0];
	if (!skill || list.items.length !== 1) {
		throw new Error(`skill source did not resolve to exactly one skill: ${skillDir}`);
	}
	return { skill, warnings: list.diagnostics.map((diag) => diag.message) };
}

/**
 * Install from a concrete source: an existing local path or a GitHub URL.
 * Frontends never call this directly; the public entry point is
 * `installSkill` in marketplace.ts, which adds bare-name resolution on top.
 */
export function installSkillFromSource(input: InstallSkillInput): InstallSkillResult {
	const spec = parseSkillSourceSpec(input.source);
	if (!spec) throw new Error(`unsupported skill source: ${input.source}`);
	const cwd = input.cwd ?? process.cwd();
	const scope = input.scope ?? "project";

	const fetched = fetchSource(spec);
	try {
		const { skill, warnings } = validateSourceSkill(fetched.skillDir);
		const name = (input.name ?? skill.name).trim();
		if (!isSkillName(name)) {
			throw new Error(`invalid skill name "${name}": use lowercase letters, numbers, and single hyphens`);
		}

		const dest = path.join(destinationRoot(scope, cwd, input.configDir), name);
		if (existsSync(dest) && input.force !== true) {
			throw new Error(`skill already installed at ${dest} (use --force to overwrite)`);
		}

		const sourceRaw = readFileSync(skill.filePath, "utf8");
		const installedHash = normalizedSkillHash(sourceRaw);
		const destFile = path.join(dest, "SKILL.md");
		swapSkillDir((staging) => {
			copySkillDir(fetched.skillDir, staging);
			writeFileSync(
				path.join(staging, "SKILL.md"),
				injectProvenanceFrontmatter(sourceRaw, {
					sourceUrl: spec.original,
					installedAt: new Date().toISOString(),
					installedHash,
				}),
				"utf8",
			);
		}, dest);

		// Surface unmet typed requires (and any other warnings) for the installed copy.
		const after = loadSkills({ cwd, ...(scope === "user" && input.configDir ? { configDir: input.configDir } : {}) });
		const installWarnings = after.diagnostics
			.filter((diag) => diag.path && path.resolve(diag.path).startsWith(dest))
			.map((diag) => diag.message);

		return {
			name,
			scope,
			path: destFile,
			sourceUrl: spec.original,
			installedHash,
			warnings: [...warnings, ...installWarnings],
		};
	} finally {
		fetched.cleanup();
	}
}

function managedSkills(cwd: string, configDir?: string): Skill[] {
	const list = loadSkills({ cwd, ...(configDir ? { configDir } : {}) });
	// Only Clio-managed roots are update targets; compat roots belong to other harnesses.
	return list.items.filter((skill) => skill.source === "clio" && (skill.scope === "user" || skill.scope === "project"));
}

function updateOne(skill: Skill, force: boolean): SkillUpdateReport {
	const sourceUrl = skill.provenance?.installUrl;
	if (!sourceUrl) return { name: skill.name, status: "no-source", detail: "no source-url provenance recorded" };
	const spec = parseSkillSourceSpec(sourceUrl);
	if (!spec) return { name: skill.name, status: "error", detail: `unsupported source-url: ${sourceUrl}` };

	const fetched = fetchSource(spec);
	try {
		// The same gate a fresh install passes. Upstream may have moved on to a
		// SKILL.md that no longer loads, and without this an update replaces a
		// working skill with one that fails discovery: the operator is told the
		// skill updated, and it silently stops existing.
		validateSourceSkill(fetched.skillDir);
		const remoteFile = path.join(fetched.skillDir, "SKILL.md");
		const remoteRaw = readFileSync(remoteFile, "utf8");
		const remoteHash = normalizedSkillHash(remoteRaw);
		const localRaw = readFileSync(skill.filePath, "utf8");
		const localHash = normalizedSkillHash(localRaw);
		const recordedHash = skill.provenance?.installedHash ?? null;

		if (remoteHash === localHash) return { name: skill.name, status: "up-to-date" };
		// Without a recorded install hash, a local/remote mismatch is indistinguishable
		// from local edits; stay conservative either way.
		const locallyModified = recordedHash === null || localHash !== recordedHash;
		if (locallyModified && !force) {
			return { name: skill.name, status: "local-changes", detail: "skipped, use --force to overwrite" };
		}

		swapSkillDir((staging) => {
			copySkillDir(fetched.skillDir, staging);
			writeFileSync(
				path.join(staging, "SKILL.md"),
				injectProvenanceFrontmatter(remoteRaw, {
					sourceUrl,
					installedAt: skill.provenance?.installedAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					installedHash: remoteHash,
				}),
				"utf8",
			);
		}, skill.baseDir);
		return { name: skill.name, status: "updated" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { name: skill.name, status: "error", detail: reason };
	} finally {
		fetched.cleanup();
	}
}

export function updateSkills(input: UpdateSkillsInput = {}): SkillUpdateReport[] {
	const cwd = input.cwd ?? process.cwd();
	const skills = managedSkills(cwd, input.configDir);
	if (input.name) {
		const skill = skills.find((entry) => entry.name === input.name);
		if (!skill) return [{ name: input.name, status: "error", detail: "not found in Clio-managed skill roots" }];
		return [updateOne(skill, input.force === true)];
	}
	if (input.all !== true) throw new Error("updateSkills requires a name or all=true");
	return skills.filter((skill) => skill.provenance?.installUrl).map((skill) => updateOne(skill, input.force === true));
}
