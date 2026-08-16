import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PendingSkillRequest } from "../../../core/skill-activation.js";
import { type ToolName, ToolNames } from "../../../core/tool-names.js";
import { clioConfigDir } from "../../../core/xdg.js";
import { enabledExtensionResourceRoots } from "../../extensions/index.js";
import type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "../collision.js";
import { readRootEntries, splitYamlFrontmatter, stringField } from "../common-loader.js";
import { normalizedSkillHash } from "./content-hash.js";
import { getMarketplaceSkills } from "./marketplace.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Hard ceiling on a SKILL.md. Above this the file is a payload rather than a
 * document: `loadSkills` runs on every `context(scope="skills")` call and reads
 * and hashes each file whole, so an oversized one is a cost paid per tool call
 * for content no model will ever be shown.
 */
const MAX_SKILL_BYTES = 1024 * 1024;

/**
 * Bytes of skill body the activation path can actually deliver. Mirrors
 * `OBSERVE_SELF_CAPS.contextSkills`, which lives in the tool substrate and must
 * not be imported from a domain; `contracts/skills` asserts the two agree so
 * the mirror cannot drift. A skill over this still loads, because truncation is
 * the activation path's job, but validation says so: an author whose workflow
 * is silently cut in half at runtime has no other way to find out.
 */
export const SKILL_ACTIVATION_BODY_CAP_BYTES = 50 * 1024;

/** Frontmatter keys with first-class meaning; everything else lands in metadata. */
const CORE_FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"disable-model-invocation",
	"allowed-tools",
	"disallowed-tools",
]);

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
	/**
	 * sha256 of the SKILL.md with install-lifecycle provenance frontmatter
	 * stripped. This is the hash pinned in a catalog registry.yaml, so an
	 * installed copy compares equal to its audited source regardless of
	 * install timestamps.
	 */
	normalizedHash: string;
	/** Directory or file subject the skill was discovered under. */
	pathSubject: string;
	/** Whether the skill is model-visible by default (compat project roots are not). */
	trusted: boolean;
	/** Collision precedence; higher wins. */
	precedence: number;
	/**
	 * Tools the skill workflow declares it needs (`allowed-tools` frontmatter).
	 * The harness intersects this with host policy after activation; a skill can
	 * narrow its surface but never grant tools the host would not allow.
	 */
	allowedTools?: ReadonlyArray<string>;
	/** Tools the skill workflow declares it must not use (`disallowed-tools`). */
	disallowedTools?: ReadonlyArray<string>;
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
	/**
	 * Directory every discovered skill must resolve inside. A skill root says
	 * what a repository or an operator's machine offers, so a symlink out of it
	 * would let a cloned repository offer content it does not contain, under
	 * paths that still read as repository-local. `.clio-coder/skills` is trusted
	 * unconditionally, so the escape needs no opt-in to reach the model.
	 *
	 * The anchor is the workspace for a project root and the home directory for
	 * a user root, matching `assertWriteBoundaryInsideRoot`: a monorepo may
	 * share one skills tree across checkouts, but nothing may reach outside the
	 * tree the operator is working in.
	 *
	 * Undefined disables the check. An extension root is laid out by a package
	 * manager that symlinks by design, and an explicit skill path names its own
	 * target, so neither has a containing scope to be measured against.
	 */
	containment?: string;
}

export interface SkillList {
	items: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export interface SkillExpansionOptions {
	/** Working directory used for marketplace catalog discovery. */
	cwd?: string;
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

/**
 * Whether project-scope compatibility roots are model-visible. Prompts share
 * this gate with skills: both substitute another agent's project file into
 * Clio's context, so one opt-in covers both.
 */
export function projectCompatTrusted(explicit?: boolean): boolean {
	if (explicit === true) return true;
	return process.env.CLIO_CODER_TRUST_PROJECT_SKILLS === "1";
}

/**
 * Discovery roots, lowest to highest precedence:
 *  1. package/extension skills
 *  2. shared user compat roots (~/.agents, ~/.claude, ~/.codex, ~/.copilot, ~/.config/opencode)
 *  3. Clio user root (<config>/skills)
 *  4. project compat roots (.agents, .claude, .codex, .github, .opencode), trusted only on opt-in
 *  5. Clio project root (.clio-coder/skills)
 */
export function defaultSkillRoots(input: LoadSkillsInput = {}): SkillRoot[] {
	const cwd = input.cwd ?? process.cwd();
	const home = input.home ?? homedir();
	const configDir = input.configDir ?? clioConfigDirSafe();
	const trustProject = projectCompatTrusted(input.trustProjectCompatRoots);
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
		containment: home,
	});
	roots.push({
		path: path.join(home, ".claude", "skills"),
		scope: "user",
		source: "claude",
		origin: "claude-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
		containment: home,
	});
	roots.push({
		path: path.join(home, ".codex", "skills"),
		scope: "user",
		source: "codex",
		origin: "codex-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
		containment: home,
	});
	roots.push({
		path: path.join(home, ".config", "opencode", "skills"),
		scope: "user",
		source: "opencode",
		origin: "opencode-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
		containment: home,
	});
	roots.push({
		path: path.join(home, ".copilot", "skills"),
		scope: "user",
		source: "copilot",
		origin: "copilot-user",
		precedence: SKILL_PRECEDENCE.userCompat,
		trusted: true,
		containment: home,
	});

	if (configDir) {
		roots.push({
			path: path.join(configDir, "skills"),
			scope: "user",
			source: "clio",
			origin: "config",
			precedence: SKILL_PRECEDENCE.user,
			trusted: true,
			containment: home,
		});
	}

	roots.push({
		path: path.join(cwd, ".agents", "skills"),
		scope: "project",
		source: "agents",
		origin: "agents-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
		containment: cwd,
	});
	roots.push({
		path: path.join(cwd, ".claude", "skills"),
		scope: "project",
		source: "claude",
		origin: "claude-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
		containment: cwd,
	});
	roots.push({
		path: path.join(cwd, ".codex", "skills"),
		scope: "project",
		source: "codex",
		origin: "codex-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
		containment: cwd,
	});
	roots.push({
		path: path.join(cwd, ".opencode", "skills"),
		scope: "project",
		source: "opencode",
		origin: "opencode-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
		containment: cwd,
	});
	roots.push({
		path: path.join(cwd, ".github", "skills"),
		scope: "project",
		source: "copilot",
		origin: "copilot-project",
		precedence: SKILL_PRECEDENCE.projectCompat,
		trusted: trustProject,
		containment: cwd,
	});

	roots.push({
		path: path.join(cwd, ".clio-coder", "skills"),
		scope: "project",
		source: "clio",
		origin: "project",
		precedence: SKILL_PRECEDENCE.project,
		trusted: true,
		containment: cwd,
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

/**
 * Parse a frontmatter tool list. Two spellings are the same declaration and
 * both appear in the roots Clio discovers: a YAML sequence, which every skill
 * Clio ships uses, and one comma-separated scalar, which is what the
 * compatibility roots under `.claude` and `.agents` carry. Reading only the
 * sequence dropped the scalar form silently, so a skill that asked to be
 * confined to four tools ran with the whole surface and no word about it.
 */
function rawToolListField(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
	const raw = frontmatter[key];
	const entries =
		typeof raw === "string"
			? raw.split(",")
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: null;
	if (entries === null) return undefined;
	const tools = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	return tools.length > 0 ? [...new Set(tools)] : undefined;
}

const TOOL_NAMES_BY_LOWERCASE = new Map(Object.values(ToolNames).map((name) => [name.toLowerCase(), name]));

interface ResolvedToolList {
	/** Declared names Clio recognizes, which are the ones narrowing can enforce. */
	tools: ToolName[];
	/** Declared names that are no tool Clio has. */
	unrecognized: string[];
}

/**
 * Resolve declared tool names against the tools Clio actually has. Case is
 * normalized because `Bash` and `bash` are the same tool named by two
 * harnesses; nothing else is mapped, because an alias table would let a
 * declaration mean a tool its author never wrote.
 */
function resolveDeclaredTools(declared: ReadonlyArray<string>): ResolvedToolList {
	const tools: ToolName[] = [];
	const unrecognized: string[] = [];
	for (const entry of declared) {
		const resolved = TOOL_NAMES_BY_LOWERCASE.get(entry.toLowerCase());
		if (resolved === undefined) unrecognized.push(entry);
		else if (!tools.includes(resolved)) tools.push(resolved);
	}
	return { tools, unrecognized };
}

/**
 * The tool surface one frontmatter key declares, reduced to what Clio can
 * enforce and reported where it cannot.
 *
 * `allowed-tools` is workflow scoping, not a security boundary: the host
 * admission in `tools/registry.ts` has already decided what this run may call,
 * and narrowing only ever subtracts from it. So an allow-list naming no tool
 * Clio has is not a declaration to enforce as "nothing is permitted"; it is a
 * declaration written for another harness, and honoring it literally would
 * block every call for a reason the operator never chose. It narrows nothing
 * and says so. A denial is kept whenever it resolves, because a denial that
 * fails open is the one direction that matters.
 */
function declaredToolSurface(
	frontmatter: Record<string, unknown>,
	key: string,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): ToolName[] | undefined {
	const declared = rawToolListField(frontmatter, key);
	if (declared === undefined) return undefined;
	const { tools, unrecognized } = resolveDeclaredTools(declared);
	if (unrecognized.length > 0) {
		diagnostics.push({
			type: "warning",
			message: `${key} names ${unrecognized.length === 1 ? "a tool" : "tools"} Clio does not have: ${unrecognized.join(", ")}`,
			path: filePath,
		});
	}
	if (tools.length === 0 && key === "allowed-tools") {
		diagnostics.push({
			type: "warning",
			message:
				"allowed-tools names no tool Clio has, so it narrows nothing; declare Clio tool names to confine this skill",
			path: filePath,
		});
		return undefined;
	}
	return tools.length > 0 ? tools : undefined;
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
	// Provenance lives nested under the reserved `clio:` block; the flat
	// top-level keys remain readable for already-installed copies stamped
	// before the nested form existed.
	const clioRaw = frontmatter.clio;
	const clio =
		clioRaw !== null && typeof clioRaw === "object" && !Array.isArray(clioRaw)
			? (clioRaw as Record<string, unknown>)
			: undefined;
	const field = (...keys: string[]): string | null => {
		for (const key of keys) {
			if (clio) {
				const nested = stringField(clio, key);
				if (nested !== null) return nested;
			}
		}
		for (const key of keys) {
			const flat = stringField(frontmatter, key);
			if (flat !== null) return flat;
		}
		return null;
	};
	const installUrl = field("source-url", "sourceUrl", "install-url");
	const registryId = field("registry-id", "registryId");
	const registryUrl = field("registry-url", "registryUrl");
	const installedAt = field("installed-at", "installedAt");
	const updatedAt = field("updated-at", "updatedAt");
	const installedHash = field("installed-hash", "installedHash");
	const auditRaw = field("audit");
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

function pathIsInside(candidate: string, anchor: string): boolean {
	return candidate === anchor || candidate.startsWith(anchor + path.sep);
}

/**
 * The directory this root's skills must resolve inside, canonicalized once so
 * every later comparison is against real paths on both sides.
 *
 * A root the operator placed outside its own declared scope anchors to itself:
 * an XDG config dir on another volume is where the operator put their skills,
 * not an escape, and anchoring it at home would reject every skill under it.
 */
function containmentAnchor(root: SkillRoot): string | null {
	if (root.containment === undefined) return null;
	const anchor = canonicalizePath(root.containment);
	const rootReal = canonicalizePath(root.path);
	return pathIsInside(rootReal, anchor) ? anchor : rootReal;
}

/**
 * Refuse a discovered entry whose real path leaves the root's containing
 * scope. Rejection rather than a warning, because the escape is invisible in
 * every path the operator is later shown: `filePath` and `baseDir` both keep
 * the symlink's own location, so a loaded escaped skill reads as ordinary
 * repository content while its body and its resource tree come from somewhere
 * the repository never contained.
 */
function escapesContainment(fullPath: string, anchor: string | null, diagnostics: ResourceDiagnostic[]): boolean {
	if (anchor === null) return false;
	const resolved = canonicalizePath(fullPath);
	if (pathIsInside(resolved, anchor)) return false;
	diagnostics.push({
		type: "warning",
		message: `skill path resolves to ${resolved}, outside ${anchor}; a skill root may not leave its scope through a symlink`,
		path: fullPath,
	});
	return true;
}

function loadSkillFile(
	filePath: string,
	root: SkillRoot,
): { candidate: SkillCandidate | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let bytes: Buffer;
	try {
		bytes = readFileSync(filePath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			candidate: null,
			diagnostics: [{ type: "warning", message: `skill file could not be read: ${reason}`, path: filePath }],
		};
	}
	if (bytes.byteLength > MAX_SKILL_BYTES) {
		return {
			candidate: null,
			diagnostics: [
				{
					type: "warning",
					message: `skill file is ${bytes.byteLength} bytes, over the ${MAX_SKILL_BYTES}-byte limit for a SKILL.md`,
					path: filePath,
				},
			],
		};
	}
	// A SKILL.md becomes model-visible instructions, so it has to be text. utf8
	// decoding never throws: it substitutes U+FFFD, which would turn a binary
	// file into a document of replacement characters that loads and says
	// nothing. Round-tripping is the check that catches it, and a NUL byte is
	// called out separately because that is what a binary file looks like.
	const raw = bytes.toString("utf8");
	if (bytes.includes(0) || !Buffer.from(raw, "utf8").equals(bytes)) {
		return {
			candidate: null,
			diagnostics: [
				{
					type: "warning",
					message: "skill file is not valid UTF-8 text; a SKILL.md is a document, not a binary payload",
					path: filePath,
				},
			],
		};
	}
	if (bytes.byteLength > SKILL_ACTIVATION_BODY_CAP_BYTES) {
		diagnostics.push({
			type: "warning",
			message: `skill file is ${bytes.byteLength} bytes; activation delivers at most ${SKILL_ACTIVATION_BODY_CAP_BYTES}, so the model will not be shown the rest`,
			path: filePath,
		});
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
	const allowedTools = declaredToolSurface(parsed.frontmatter, "allowed-tools", filePath, diagnostics);
	const disallowedTools = declaredToolSurface(parsed.frontmatter, "disallowed-tools", filePath, diagnostics);
	const skill: Skill = {
		name,
		description,
		filePath,
		baseDir,
		content: parsed.body.trim(),
		sourceInfo,
		disableModelInvocation: booleanField(parsed.frontmatter, "disable-model-invocation"),
		...(allowedTools ? { allowedTools } : {}),
		...(disallowedTools ? { disallowedTools } : {}),
		source: root.source ?? "clio",
		scope,
		hash: sha256(raw),
		normalizedHash: normalizedSkillHash(raw),
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
	anchor: string | null = containmentAnchor(root),
): SkillCandidate[] {
	if (!existsSync(dir)) return [];
	if (escapesContainment(dir, anchor, diagnostics)) return [];
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
		const skillPath = path.join(dir, skillEntry.name);
		if (escapesContainment(skillPath, anchor, diagnostics)) return [];
		const loaded = loadSkillFile(skillPath, root);
		diagnostics.push(...loaded.diagnostics);
		return loaded.candidate ? [loaded.candidate] : [];
	}

	const candidates: SkillCandidate[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() || (entry.isSymbolicLink() && existsSync(path.join(fullPath, "SKILL.md")))) {
			candidates.push(...collectSkills(root, fullPath, diagnostics, false, anchor));
			continue;
		}
		if (!includeRootFiles || (!entry.isFile() && !entry.isSymbolicLink()) || !isSkillMarkdownFile(entry.name)) continue;
		if (escapesContainment(fullPath, anchor, diagnostics)) continue;
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
		// A directory without its own SKILL.md may be a catalog of skill
		// packages (for example a repo-level skills/ folder); load every
		// immediate child package so validation and registry tooling can
		// operate on the whole catalog with one path.
		const packages = collectSkills(root, resolved, diagnostics, false);
		if (packages.length > 0) return packages;
		diagnostics.push({
			type: "warning",
			message: `explicit skill path is not a SKILL.md file, skill directory, or catalog of skill packages: ${resolved}`,
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

/** Skills the model may see in context(scope=skills) listings and load by name. */
export function modelVisibleSkills(skills: ReadonlyArray<Skill>): Skill[] {
	return skills.filter((skill) => skill.trusted && !skill.disableModelInvocation);
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
	options: SkillExpansionOptions = {},
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
		const marketplaceSkill = getMarketplaceSkills(options.cwd ? { cwd: options.cwd } : {}).find((s) => s.name === name);
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
