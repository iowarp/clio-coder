import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PendingSkillRequest } from "../../../core/skill-activation.js";
import { clioConfigDir } from "../../../core/xdg.js";
import { enabledExtensionResourceRoots } from "../../extensions/index.js";
import type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "../collision.js";
import { readRootEntries, splitYamlFrontmatter, stringField } from "../common-loader.js";
import { getMarketplaceSkills } from "./marketplace.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Frontmatter keys with first-class meaning; everything else lands in metadata. */
const CORE_FRONTMATTER_KEYS = new Set(["name", "description", "disable-model-invocation"]);

/**
 * Semantic origin of a skill root. Distinct from {@link ResourceScope}, which
 * only encodes collision precedence tiers shared across resource kinds.
 */
export type SkillSource =
	| "clio"
	| "agents"
	| "claude"
	| "codex"
	| "copilot"
	| "opencode"
	| "extension"
	| "path"
	| "cli";

/** Optional install provenance, captured from frontmatter when present. */
export interface SkillProvenance {
	installUrl?: string;
	registryId?: string;
	registryUrl?: string;
	installedAt?: string;
	updatedAt?: string;
	/** Content hash of the upstream SKILL.md at install time, provenance-stripped. */
	installedHash?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	content: string;
	sourceInfo: ResourceSourceInfo;
	disableModelInvocation: boolean;
	/** Semantic source root (clio, agents, codex, extension, ...). */
	source: SkillSource;
	/** Mirror of sourceInfo.scope for convenient access. */
	scope: ResourceScope;
	/** sha256 of the raw SKILL.md file content. */
	hash: string;
	/** Directory or file subject the skill was discovered under. */
	pathSubject: string;
	/** Whether the skill is model-visible by default (compat project roots are not). */
	trusted: boolean;
	/** Collision precedence; higher wins. */
	precedence: number;
	/** Optional frontmatter fields beyond name/description/disable-model-invocation. */
	metadata: Record<string, unknown>;
	/** Per-skill diagnostics (also aggregated into the list). */
	diagnostics: ResourceDiagnostic[];
	/** Install provenance when the frontmatter records it. */
	provenance?: SkillProvenance;
}

export interface SkillRoot {
	path: string;
	scope: ResourceScope;
	source?: SkillSource;
	/** sourceInfo.source string, e.g. "config", "agents-user", "extension:user:id". */
	origin?: string;
	/** Collision precedence override; defaults are derived from scope. */
	precedence?: number;
	/** Whether discovered skills are model-visible by default. */
	trusted?: boolean;
}

export interface SkillList {
	items: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export interface SkillExpansionOptions {
	/** @deprecated Ignored. Skill invocation is explicit slash/selector only. */
	naturalLanguageTriggers?: boolean;
}

export interface LoadSkillsInput {
	cwd?: string;
	roots?: ReadonlyArray<SkillRoot>;
	/** Override the user home dir used for shared compatibility roots (testing). */
	home?: string;
	/** Override the Clio config dir used for the user skill root (testing). */
	configDir?: string;
	/** Opt in to model-visible project compatibility roots (.agents/.codex). */
	trustProjectCompatRoots?: boolean;
	/** Disable normal root discovery. Explicit skill paths still load. */
	disableDiscovery?: boolean;
	/** One-shot skill files or directories loaded at CLI precedence. */
	explicitSkillPaths?: ReadonlyArray<string>;
}

export type SkillExpansion =
	| {
			expanded: false;
			text: string;
			args: string;
			diagnostics: ResourceDiagnostic[];
	  }
	| {
			expanded: true;
			text: string;
			args: string;
			skill: Skill;
			triggeredBy: "slash-command";
			diagnostics: ResourceDiagnostic[];
	  };

/** Collision precedence tiers; higher wins. */
const SKILL_PRECEDENCE = {
	extension: 10,
	userCompat: 20,
	user: 30,
	projectCompat: 40,
	project: 50,
	cli: 60,
} as const;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function shortHash(value: string): string {
	return value.slice(0, 12);
}

function defaultPrecedenceForScope(scope: ResourceScope): number {
	switch (scope) {
		case "package":
			return SKILL_PRECEDENCE.extension;
		case "user":
			return SKILL_PRECEDENCE.user;
		case "project":
			return SKILL_PRECEDENCE.project;
		case "cli":
			return SKILL_PRECEDENCE.cli;
	}
}

function projectCompatTrusted(input: LoadSkillsInput): boolean {
	if (input.trustProjectCompatRoots === true) return true;
	return process.env.CLIO_TRUST_PROJECT_SKILLS === "1";
}

/**
 * Discovery roots, lowest to highest precedence:
 *  1. package/extension skills
 *  2. shared user compat roots (~/.agents, ~/.claude, ~/.codex, ~/.copilot, ~/.config/opencode)
 *  3. Clio user root (<config>/skills)
 *  4. project compat roots (.agents, .claude, .codex, .github, .opencode), trusted only on opt-in
 *  5. Clio project root (.clio/skills)
 */
export function defaultSkillRoots(input: LoadSkillsInput = {}): SkillRoot[] {
	const cwd = input.cwd ?? process.cwd();
	const home = input.home ?? homedir();
	const configDir = input.configDir ?? clioConfigDirSafe();
	const trustProject = projectCompatTrusted(input);
	const roots: SkillRoot[] = [];

	for (const root of enabledExtensionResourceRoots("skills", cwd)) {
		roots.push({
			path: root.path,
			scope: "package",
			source: "extension",
			origin: root.source,
			precedence: SKILL_PRECEDENCE.extension,
			trusted: true,
		});
	}

	roots.push({
		path: path.join(home, ".agents", "skills"),
		scope: "user",
		source: "agents",
		origin: "agents-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
	});
	roots.push({
		path: path.join(home, ".claude", "skills"),
		scope: "user",
		source: "claude",
		origin: "claude-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
	});
	roots.push({
		path: path.join(home, ".codex", "skills"),
		scope: "user",
		source: "codex",
		origin: "codex-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
	});
	roots.push({
		path: path.join(home, ".config", "opencode", "skills"),
		scope: "user",
		source: "opencode",
		origin: "opencode-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
	});
	roots.push({
		path: path.join(home, ".copilot", "skills"),
		scope: "user",
		source: "copilot",
		origin: "copilot-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
	});

	if (configDir) {
		roots.push({
			path: path.join(configDir, "skills"),
			scope: "user",
			source: "clio",
			origin: "config",
			precedence: SKILL_PRECEDENCE.user,
			trusted: true,
		});
	}

	roots.push({
		path: path.join(cwd, ".agents", "skills"),
		scope: "project",
		source: "agents",
		origin: "agents-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
	});
	roots.push({
		path: path.join(cwd, ".claude", "skills"),
		scope: "project",
		source: "claude",
		origin: "claude-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
	});
	roots.push({
		path: path.join(cwd, ".codex", "skills"),
		scope: "project",
		source: "codex",
		origin: "codex-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
	});
	roots.push({
		path: path.join(cwd, ".opencode", "skills"),
		scope: "project",
		source: "opencode",
		origin: "opencode-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
	});
	roots.push({
		path: path.join(cwd, ".github", "skills"),
		scope: "project",
		source: "copilot",
		origin: "copilot-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
	});

	roots.push({
		path: path.join(cwd, ".clio", "skills"),
		scope: "project",
		source: "clio",
		origin: "project",
		precedence: SKILL_PRECEDENCE.project,
		trusted: true,
	});

	return roots;
}

/** Resolve the Clio config dir without throwing if XDG dirs cannot be created. */
function clioConfigDirSafe(): string | null {
	try {
		return clioConfigDir();
	} catch {
		return null;
	}
}

function splitSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	const split = splitYamlFrontmatter(raw);
	if (!split.ok && split.reason === "missing") {
		throw new Error("skill file is missing YAML frontmatter");
	}
	if (!split.ok && split.reason === "missing closing delimiter") {
		throw new Error("skill file is missing a closing YAML frontmatter delimiter");
	}
	if (!split.ok && split.reason === "must be a YAML object") {
		throw new Error("skill frontmatter must be a YAML object");
	}
	if (!split.ok) throw new Error(`skill frontmatter is ${split.reason}`);
	return split;
}

function booleanField(frontmatter: Record<string, unknown>, key: string): boolean {
	return frontmatter[key] === true;
}

function validationSubject(filePath: string): string {
	return path.basename(filePath) === "SKILL.md" ? path.basename(path.dirname(filePath)) : path.basename(filePath, ".md");
}

function validateNameFormat(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateDescription(description: string | null): string[] {
	if (!description) return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
	}
	return [];
}

function extractMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (CORE_FRONTMATTER_KEYS.has(key)) continue;
		metadata[key] = value;
	}
	return metadata;
}

function extractProvenance(frontmatter: Record<string, unknown>): SkillProvenance | undefined {
	const installUrl =
		stringField(frontmatter, "source-url") ??
		stringField(frontmatter, "sourceUrl") ??
		stringField(frontmatter, "install-url");
	const registryId = stringField(frontmatter, "registry-id") ?? stringField(frontmatter, "registryId");
	const registryUrl = stringField(frontmatter, "registry-url") ?? stringField(frontmatter, "registryUrl");
	const installedAt = stringField(frontmatter, "installed-at") ?? stringField(frontmatter, "installedAt");
	const updatedAt = stringField(frontmatter, "updated-at") ?? stringField(frontmatter, "updatedAt");
	const installedHash = stringField(frontmatter, "installed-hash") ?? stringField(frontmatter, "installedHash");
	const auditRaw = stringField(frontmatter, "audit");
	const audit =
		auditRaw === "pass" || auditRaw === "warn" || auditRaw === "fail" || auditRaw === "unknown" ? auditRaw : undefined;
	if (!installUrl && !registryId && !registryUrl && !installedAt && !updatedAt && !installedHash && !audit)
		return undefined;
	return {
		...(installUrl ? { installUrl } : {}),
		...(registryId ? { registryId } : {}),
		...(registryUrl ? { registryUrl } : {}),
		...(installedAt ? { installedAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
		...(installedHash ? { installedHash } : {}),
		...(audit ? { audit } : {}),
	};
}

interface SkillCandidate {
	skill: Skill;
	canonicalPath: string;
}

function canonicalizePath(filePath: string): string {
	try {
		return realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function loadSkillFile(
	filePath: string,
	root: SkillRoot,
): { candidate: SkillCandidate | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			candidate: null,
			diagnostics: [{ type: "warning", message: `skill file could not be read: ${reason}`, path: filePath }],
		};
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = splitSkillFrontmatter(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { candidate: null, diagnostics: [{ type: "warning", message: reason, path: filePath }] };
	}

	const pathSubject = validationSubject(filePath);
	const frontmatterName = stringField(parsed.frontmatter, "name");
	const name = frontmatterName ?? pathSubject;
	const description = stringField(parsed.frontmatter, "description");

	for (const message of validateDescription(description)) diagnostics.push({ type: "warning", message, path: filePath });
	// Name/path mismatch is informational; cross-harness skill folders often differ.
	if (frontmatterName && frontmatterName !== pathSubject) {
		diagnostics.push({
			type: "warning",
			message: `name "${frontmatterName}" differs from path subject "${pathSubject}"; using frontmatter name`,
			path: filePath,
		});
	}
	for (const message of validateNameFormat(name)) diagnostics.push({ type: "warning", message, path: filePath });

	// Missing description is the only hard rejection; everything else loads with a warning.
	if (!description) return { candidate: null, diagnostics };

	const baseDir = path.dirname(filePath);
	const scope = root.scope;
	const sourceInfo: ResourceSourceInfo = {
		path: filePath,
		scope,
		...(root.origin ? { source: root.origin } : {}),
	};
	const provenance = extractProvenance(parsed.frontmatter);
	const skill: Skill = {
		name,
		description,
		filePath,
		baseDir,
		content: parsed.body.trim(),
		sourceInfo,
		disableModelInvocation: booleanField(parsed.frontmatter, "disable-model-invocation"),
		source: root.source ?? "clio",
		scope,
		hash: sha256(raw),
		pathSubject,
		trusted: root.trusted ?? true,
		precedence: root.precedence ?? defaultPrecedenceForScope(scope),
		metadata: extractMetadata(parsed.frontmatter),
		diagnostics,
		...(provenance ? { provenance } : {}),
	};
	return { candidate: { skill, canonicalPath: canonicalizePath(filePath) }, diagnostics };
}

function isSkillMarkdownFile(entryName: string): boolean {
	return entryName === "SKILL.md" || entryName.endsWith(".md");
}

function collectSkills(
	root: SkillRoot,
	dir: string,
	diagnostics: ResourceDiagnostic[],
	includeRootFiles: boolean,
): SkillCandidate[] {
	if (!existsSync(dir)) return [];
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({ type: "warning", message: `skill root could not be read: ${reason}`, path: dir });
		return [];
	}

	const skillEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
	if (skillEntry) {
		const loaded = loadSkillFile(path.join(dir, skillEntry.name), root);
		diagnostics.push(...loaded.diagnostics);
		return loaded.candidate ? [loaded.candidate] : [];
	}

	const candidates: SkillCandidate[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && existsSync(path.join(fullPath, "SKILL.md")))) {
			candidates.push(...collectSkills(root, fullPath, diagnostics, false));
			continue;
		}
		if (!includeRootFiles || (!entry.isFile() && !entry.isSymbolicLink()) || !isSkillMarkdownFile(entry.name)) continue;
		const loaded = loadSkillFile(fullPath, root);
		diagnostics.push(...loaded.diagnostics);
		if (loaded.candidate) candidates.push(loaded.candidate);
	}
	return candidates;
}

function loadSkillRoot(root: SkillRoot, diagnostics: ResourceDiagnostic[]): SkillCandidate[] {
	const entries = readRootEntries(root, "skill", diagnostics);
	if (entries.length === 0) return [];
	return collectSkills(root, root.path, diagnostics, true);
}

function explicitSkillRoot(filePath: string): SkillRoot {
	return {
		path: filePath,
		scope: "cli",
		source: "path",
		origin: "explicit-path",
		precedence: SKILL_PRECEDENCE.cli,
		trusted: true,
	};
}

function loadExplicitSkillPath(inputPath: string, diagnostics: ResourceDiagnostic[]): SkillCandidate[] {
	const resolved = path.resolve(inputPath);
	const root = explicitSkillRoot(resolved);
	if (!existsSync(resolved)) {
		diagnostics.push({ type: "warning", message: `explicit skill path does not exist: ${resolved}`, path: resolved });
		return [];
	}
	const skillFile =
		path.basename(resolved) === "SKILL.md" || resolved.endsWith(".md") ? resolved : path.join(resolved, "SKILL.md");
	if (!existsSync(skillFile)) {
		diagnostics.push({
			type: "warning",
			message: `explicit skill path is not a SKILL.md file or skill directory: ${resolved}`,
			path: resolved,
		});
		return [];
	}
	const loaded = loadSkillFile(skillFile, root);
	diagnostics.push(...loaded.diagnostics);
	return loaded.candidate ? [loaded.candidate] : [];
}

function dedupeCanonicalSkillPaths(
	candidates: ReadonlyArray<SkillCandidate>,
	diagnostics: ResourceDiagnostic[],
): SkillCandidate[] {
	const byPath = new Map<string, SkillCandidate[]>();
	for (const candidate of candidates) {
		const list = byPath.get(candidate.canonicalPath) ?? [];
		list.push(candidate);
		byPath.set(candidate.canonicalPath, list);
	}
	const winners: SkillCandidate[] = [];
	for (const entries of byPath.values()) {
		if (entries.length === 1) {
			const only = entries[0];
			if (only) winners.push(only);
			continue;
		}
		const sorted = [...entries].sort((a, b) => {
			const delta = a.skill.precedence - b.skill.precedence;
			if (delta !== 0) return delta;
			return a.skill.filePath.localeCompare(b.skill.filePath);
		});
		const winner = sorted[sorted.length - 1];
		if (!winner) continue;
		winners.push(winner);
		for (const loser of sorted.slice(0, -1)) {
			diagnostics.push({
				type: "warning",
				message: `${loser.skill.name} at ${loser.skill.filePath} resolves to the same canonical skill file as ${winner.skill.filePath}; using the higher-precedence entry`,
				path: loser.skill.filePath,
			});
		}
	}
	return winners;
}

/** Resolve name collisions by precedence (higher wins), tiebroken by file path. */
function resolveSkillCollisions(candidates: ReadonlyArray<SkillCandidate>): {
	winners: Skill[];
	diagnostics: ResourceDiagnostic[];
} {
	const byName = new Map<string, SkillCandidate[]>();
	for (const candidate of candidates) {
		const key = candidate.skill.name.trim();
		if (key.length === 0) continue;
		const list = byName.get(key) ?? [];
		list.push(candidate);
		byName.set(key, list);
	}

	const winners: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const [name, entries] of byName.entries()) {
		const sorted = [...entries].sort((a, b) => {
			const delta = a.skill.precedence - b.skill.precedence;
			if (delta !== 0) return delta;
			return a.skill.filePath.localeCompare(b.skill.filePath);
		});
		const winner = sorted[sorted.length - 1];
		if (!winner) continue;
		winners.push(winner.skill);
		for (const loser of sorted.slice(0, -1)) {
			diagnostics.push({
				type: "collision",
				message: `${name} from ${winner.skill.source}/${winner.skill.scope} overrides ${loser.skill.source}/${loser.skill.scope}`,
				path: loser.skill.filePath,
				collision: {
					name,
					winnerPath: winner.skill.filePath,
					loserPath: loser.skill.filePath,
					winnerScope: winner.skill.scope,
					loserScope: loser.skill.scope,
				},
			});
		}
	}
	return { winners, diagnostics };
}

/** Warn on typed `requires: [skill:name, ...]` entries that resolve to no loaded skill. */
function requiresDiagnostics(winners: ReadonlyArray<Skill>): ResourceDiagnostic[] {
	const names = new Set(winners.map((skill) => skill.name));
	const out: ResourceDiagnostic[] = [];
	for (const skill of winners) {
		const requires = skill.metadata.requires;
		if (!Array.isArray(requires)) continue;
		for (const entry of requires) {
			if (typeof entry !== "string" || !entry.startsWith("skill:")) continue;
			const dep = entry.slice("skill:".length).trim();
			if (dep.length === 0 || names.has(dep)) continue;
			out.push({
				type: "warning",
				message: `${skill.name} requires skill "${dep}" which is not available`,
				path: skill.filePath,
			});
		}
	}
	return out;
}

export function loadSkills(input: LoadSkillsInput = {}): SkillList {
	const roots = input.roots ?? (input.disableDiscovery === true ? [] : defaultSkillRoots(input));
	const diagnostics: ResourceDiagnostic[] = [];
	const candidates = [
		...roots.flatMap((root) => loadSkillRoot(root, diagnostics)),
		...(input.explicitSkillPaths ?? []).flatMap((skillPath) => loadExplicitSkillPath(skillPath, diagnostics)),
	];
	const deduped = dedupeCanonicalSkillPaths(candidates, diagnostics);
	const resolved = resolveSkillCollisions(deduped);
	const winners = [...resolved.winners].sort((a, b) => a.name.localeCompare(b.name));
	return {
		items: winners,
		diagnostics: [...diagnostics, ...resolved.diagnostics, ...requiresDiagnostics(winners)],
	};
}

/** Skills the model may see in the catalog and load via read_skill. */
export function modelVisibleSkills(skills: ReadonlyArray<Skill>): Skill[] {
	return skills.filter((skill) => skill.trusted && !skill.disableModelInvocation);
}

function computeCatalogHash(skills: ReadonlyArray<Skill>): string {
	const parts = skills.map((skill) => `${skill.name}:${skill.hash}`).sort();
	return sha256(parts.join("\n"));
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function skillSourceOrigin(skill: Skill): string {
	return skill.sourceInfo.source ?? `${skill.source}-${skill.scope}`;
}

export function formatSkillsCatalogForPrompt(skills: SkillList): string {
	const visible = modelVisibleSkills(skills.items);
	if (visible.length === 0) return "";
	const catalogHash = computeCatalogHash(visible);
	const lines = [
		"# Skills",
		"",
		"Use a skill when its description matches the task. This catalog lists names, sources, and descriptions only; call read_skill to load the full SKILL.md body and resolve referenced files against the returned base_dir. Do not run bundled scripts unless normal Clio tool safety permits the call. When intent is ambiguous, prefer an interview skill before planning; when a plan spans multiple agent runs, slice it into an executable sprint before dispatching.",
		"",
		`<available_skills catalog_hash="${shortHash(catalogHash)}">`,
	];
	for (const skill of visible) {
		lines.push(
			`  <skill name="${escapeXmlAttribute(skill.name)}" scope="${escapeXmlAttribute(skill.scope)}" source="${escapeXmlAttribute(skill.source)}" origin="${escapeXmlAttribute(skillSourceOrigin(skill))}" hash="${shortHash(skill.hash)}">`,
		);
		lines.push(`    <description>${escapeXmlText(skill.description)}</description>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function parseSkillCommand(input: string): { name: string; args: string } | null {
	const trimmed = input.trim();
	const prefix = trimmed.startsWith("/skill:")
		? "/skill:"
		: trimmed.startsWith("/skills:")
			? "/skills:"
			: trimmed.startsWith("/skill ")
				? "/skill "
				: null;
	if (!prefix) return null;
	const rest = trimmed.slice(prefix.length).trim();
	const separator = rest.search(/\s/);
	const name = separator === -1 ? rest : rest.slice(0, separator);
	if (name.length === 0) return null;
	const args = separator === -1 ? "" : rest.slice(separator).trim();
	return { name, args };
}

export function expandSkillInvocationInput(
	input: string,
	skills: SkillList,
	_options: SkillExpansionOptions = {},
): SkillExpansion {
	const command = parseSkillCommand(input);
	if (!command) return { expanded: false, text: input, args: "", diagnostics: skills.diagnostics };
	const skill = skills.items.find((entry) => entry.name === command.name);
	const args = command.args;
	if (!skill) return { expanded: false, text: input, args, diagnostics: skills.diagnostics };
	return {
		expanded: true,
		text: args,
		args,
		skill,
		triggeredBy: "slash-command",
		diagnostics: skills.diagnostics,
	};
}

export function parsePendingSkillRequests(
	input: string,
	skills: SkillList,
	_options: SkillExpansionOptions = {},
): { text: string; pendingSkillRequests: PendingSkillRequest[] } {
	const command = parseSkillCommand(input);
	if (command) {
		const name = command.name;
		const args = command.args;
		const installedSkill = skills.items.find((entry) => entry.name === name);
		if (installedSkill) {
			return {
				text: args,
				pendingSkillRequests: [
					{
						name,
						args,
						source: "slash-command",
						installed: true,
						filePath: installedSkill.filePath,
					},
				],
			};
		}
		// Check the local marketplace/discovery contract. Empty means unavailable/offline.
		const marketplaceSkill = getMarketplaceSkills().find((s) => s.name === name);
		if (marketplaceSkill) {
			return {
				text: args,
				pendingSkillRequests: [
					{
						name,
						args,
						source: "marketplace",
						installed: false,
						marketplaceRef: marketplaceSkill.sourceUrl,
					},
				],
			};
		}
		// Not installed and not in marketplace
		return {
			text: args,
			pendingSkillRequests: [
				{
					name,
					args,
					source: "slash-command",
					installed: false,
				},
			],
		};
	}

	return {
		text: input,
		pendingSkillRequests: [],
	};
}
