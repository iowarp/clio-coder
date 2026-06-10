import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { clioConfigDir } from "../../../core/xdg.js";
import { loadSkills, type Skill } from "./loader.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLONE_TIMEOUT_MS = 60_000;

/**
 * Top-level frontmatter keys owned by the install lifecycle. Stripped before
 * hashing so upstream and installed copies compare on content, not provenance.
 */
const PROVENANCE_KEYS = new Set([
	"source-url",
	"sourceUrl",
	"install-url",
	"registry-id",
	"registryId",
	"registry-url",
	"registryUrl",
	"installed-at",
	"installedAt",
	"updated-at",
	"updatedAt",
	"installed-hash",
	"installedHash",
	"audit",
]);

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

export function parseSkillSourceSpec(source: string): SkillSourceSpec | null {
	const trimmed = source.trim();
	if (trimmed.length === 0) return null;
	const browser = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+?)\/?$/);
	if (browser?.[1] && browser[2] && browser[3] && browser[4]) {
		return {
			kind: "github",
			cloneUrl: `https://github.com/${browser[1]}/${browser[2]}.git`,
			branch: browser[3],
			filePath: browser[4],
			original: trimmed,
		};
	}
	const raw = trimmed.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+?)\/?$/);
	if (raw?.[1] && raw[2] && raw[3] && raw[4]) {
		return {
			kind: "github",
			cloneUrl: `https://github.com/${raw[1]}/${raw[2]}.git`,
			branch: raw[3],
			filePath: raw[4],
			original: trimmed,
		};
	}
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
	const expanded = trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(2)) : trimmed;
	return { kind: "local", path: path.resolve(expanded), original: trimmed };
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

interface FrontmatterRegion {
	/** Raw text before the frontmatter lines (opening delimiter inclusive). */
	head: string;
	lines: string[];
	/** Raw text from the closing delimiter to the end. */
	tail: string;
}

function frontmatterRegion(rawText: string): FrontmatterRegion | null {
	const opening = rawText.match(/^---\r?\n/);
	if (!opening) return null;
	const closeRegex = /\r?\n---(?:\r?\n|$)/g;
	closeRegex.lastIndex = opening[0].length;
	const closing = closeRegex.exec(rawText);
	if (!closing) return null;
	const frontmatterText = rawText.slice(opening[0].length, closing.index);
	return {
		head: opening[0],
		lines: frontmatterText.split(/\r?\n/),
		tail: rawText.slice(closing.index),
	};
}

function isProvenanceLine(line: string): boolean {
	const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):/);
	return match?.[1] !== undefined && PROVENANCE_KEYS.has(match[1]);
}

/** Remove install-lifecycle frontmatter lines so content compares across copies. */
export function stripProvenanceFrontmatter(rawText: string): string {
	const region = frontmatterRegion(rawText);
	if (!region) return rawText;
	const kept = region.lines.filter((line) => !isProvenanceLine(line));
	return `${region.head}${kept.join("\n")}${region.tail}`;
}

/** Content hash of a SKILL.md, ignoring provenance frontmatter. */
export function normalizedSkillHash(rawText: string): string {
	return sha256(stripProvenanceFrontmatter(rawText));
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

/** Replace any provenance frontmatter with the recorded install lifecycle fields. */
export function injectProvenanceFrontmatter(rawText: string, fields: ProvenanceFields): string {
	const region = frontmatterRegion(rawText);
	if (!region) throw new Error("skill file is missing YAML frontmatter");
	const kept = region.lines.filter((line) => !isProvenanceLine(line));
	const added = [
		`source-url: ${yamlQuote(fields.sourceUrl)}`,
		`installed-at: ${yamlQuote(fields.installedAt)}`,
		...(fields.updatedAt ? [`updated-at: ${yamlQuote(fields.updatedAt)}`] : []),
		`installed-hash: ${yamlQuote(fields.installedHash)}`,
		// Audit is a human decision; installs always land unreviewed.
		"audit: unknown",
	];
	return `${region.head}${[...kept, ...added].join("\n")}${region.tail}`;
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
		return { skillDir: resolveSkillDir(path.join(tmp, spec.filePath)), cleanup };
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

export function installSkill(input: InstallSkillInput): InstallSkillResult {
	const spec = parseSkillSourceSpec(input.source);
	if (!spec) throw new Error(`unsupported skill source: ${input.source}`);
	const cwd = input.cwd ?? process.cwd();
	const scope = input.scope ?? "project";

	const fetched = fetchSource(spec);
	try {
		const { skill, warnings } = validateSourceSkill(fetched.skillDir);
		const name = (input.name ?? skill.name).trim();
		if (name.length === 0 || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
			throw new Error(`invalid skill name "${name}": use lowercase letters, numbers, and single hyphens`);
		}

		const dest = path.join(destinationRoot(scope, cwd, input.configDir), name);
		if (existsSync(dest)) {
			if (input.force !== true) throw new Error(`skill already installed at ${dest} (use --force to overwrite)`);
			rmSync(dest, { recursive: true, force: true });
		}
		copySkillDir(fetched.skillDir, dest);

		const sourceRaw = readFileSync(skill.filePath, "utf8");
		const installedHash = normalizedSkillHash(sourceRaw);
		const destFile = path.join(dest, "SKILL.md");
		writeFileSync(
			destFile,
			injectProvenanceFrontmatter(sourceRaw, {
				sourceUrl: spec.original,
				installedAt: new Date().toISOString(),
				installedHash,
			}),
			"utf8",
		);

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

		const dest = skill.baseDir;
		rmSync(dest, { recursive: true, force: true });
		copySkillDir(fetched.skillDir, dest);
		writeFileSync(
			path.join(dest, "SKILL.md"),
			injectProvenanceFrontmatter(remoteRaw, {
				sourceUrl,
				installedAt: skill.provenance?.installedAt ?? new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				installedHash: remoteHash,
			}),
			"utf8",
		);
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
