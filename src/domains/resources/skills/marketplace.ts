import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { warnLegacyNaming } from "../../../core/naming-compat.js";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { clioConfigDir } from "../../../core/xdg.js";
import {
	type InstallSkillInput,
	type InstallSkillResult,
	installSkillFromSource,
	isSkillName,
	parseSkillSourceSpec,
	type SkillInstallShaping,
} from "./install.js";
import { loadSkills, type Skill } from "./loader.js";

/**
 * Local skill marketplace. Entries come from two real sources only:
 *
 *  1. A catalog directory of actual SKILL.md packages: CLIO_CODER_SKILL_CATALOG_DIR,
 *     else a repo-level skills/ folder in the working tree, else the skills/
 *     catalog the installed clio-coder package carries. Metadata is read from
 *     the packages themselves via the normal skill loader.
 *  2. A JSON index file: CLIO_CODER_SKILL_MARKETPLACE_INDEX, else
 *     <config>/skill-marketplace.json, else the skill-marketplace.json the
 *     package carries. Entries point at installable sources.
 *
 * The package fallbacks are what make a fresh npm install a marketplace at
 * all: before them, an operator outside this repository with no env var set
 * had no catalog and no index, so every bare-name install and every
 * `/skill <name>` for a catalog skill failed. The package catalog is a
 * marketplace source only, never a discovery root; catalog skills stay
 * uninstalled until the operator asks, and install copies them out of the
 * package into a Clio root without touching the network.
 *
 * There is no synthetic or hardcoded marketplace data; an empty result means
 * no marketplace is configured.
 */

export type MarketplaceSkillOrigin = "catalog" | "index";
export type LibraryEntryKind = "skill" | "agent" | "prompt" | "fleet";
export type LibraryRequirementRef = `${LibraryEntryKind}:${string}`;

/**
 * The diagnostic that means "nothing is wrong, nothing is configured". Callers
 * that render an empty state of their own separate it from real failures (an
 * unreadable index, a broken package) by identity rather than by string match.
 */
export const MARKETPLACE_UNCONFIGURED = "no local skill marketplace catalog or index configured";

export interface MarketplaceSkill {
	kind: LibraryEntryKind;
	name: string;
	description: string;
	/** Local path or URL accepted by `clio-coder skills install`. */
	sourceUrl: string;
	version?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
	/** Catalog grouping ("git", "research", ...); absent in a flat catalog. */
	category?: string;
	/** Trigger phrases from the skill's frontmatter, for local promotion matching. */
	triggers?: string[];
	origin: MarketplaceSkillOrigin;
	requires?: LibraryRequirementRef[];
	/**
	 * Remote entry: a package-root-relative directory whose files are copied
	 * over the fetched upstream tree at install. Clio owns only the overlay
	 * (typically a wrapper SKILL.md); the upstream renderer is never vendored.
	 */
	overlay?: string;
	/** Remote entry: top-level upstream members dropped at install. */
	exclude?: string[];
}

export type MarketplaceStatus = "installed" | "installable" | "unavailable";

export interface MarketplaceDiscoveryResult {
	status: MarketplaceStatus;
	skills: MarketplaceSkill[];
	diagnostics: string[];
}

export interface DiscoverMarketplaceOptions {
	/** Working directory used to find a repo-level skills/ catalog. */
	cwd?: string;
	/** Override the JSON index path; null disables the JSON index source. */
	indexPath?: string | null;
	/** Override the catalog directory; null disables catalog discovery. */
	catalogDir?: string | null;
}

/**
 * The catalog directory and index the installed package carries. Resolved
 * lazily and defensively: a source checkout that has not built, or a package
 * root the harness cannot locate, must degrade to "no package catalog" rather
 * than throw out of a listing.
 */
function packageCatalogDir(): string | null {
	try {
		return path.join(resolvePackageRoot(), "skills");
	} catch {
		return null;
	}
}

function packageIndexPath(): string | null {
	try {
		return path.join(resolvePackageRoot(), "skills", "skill-marketplace.json");
	} catch {
		return null;
	}
}

/**
 * Index precedence when no explicit path is given: the operator's config-dir
 * copy beats the package's, so a hand-curated index still wins, and the
 * package's own index is what a fresh install falls back to.
 */
function defaultIndexPath(): string | null {
	try {
		const configured = path.join(clioConfigDir(), "skill-marketplace.json");
		if (existsSync(configured)) return configured;
	} catch {
		// Fall through: no config dir is not "no marketplace" once the package
		// carries an index of its own.
	}
	const bundled = packageIndexPath();
	return bundled && existsSync(bundled) ? bundled : null;
}

function isIndexSkill(value: unknown): value is { name: string; description: string; sourceUrl: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		record.name.trim().length > 0 &&
		typeof record.description === "string" &&
		typeof record.sourceUrl === "string" &&
		record.sourceUrl.trim().length > 0
	);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Non-empty trimmed trigger phrases, or undefined when the field is absent or unusable. */
function optionalTriggerList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const triggers = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return triggers.length > 0 ? triggers : undefined;
}

function indexAudit(value: unknown): MarketplaceSkill["audit"] {
	return value === "pass" || value === "warn" || value === "fail" || value === "unknown" ? value : undefined;
}

function parseMarketplaceIndex(indexPath: string, diagnostics: string[] = []): MarketplaceSkill[] {
	try {
		const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
		const rawSkills = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { skills?: unknown }).skills)
				? (parsed as { skills: unknown[] }).skills
				: [];
		return rawSkills.filter(isIndexSkill).flatMap((skill): MarketplaceSkill[] => {
			const record = skill as unknown as Record<string, unknown>;
			// Version, audit and category are published by `npm run skills:pin`.
			// They are advisory display metadata; an index entry stays installable
			// without them, which is why only name/description/sourceUrl gate.
			const version = optionalString(record.version);
			const audit = indexAudit(record.audit);
			const category = optionalString(record.category);
			const triggers = optionalTriggerList(record.triggers);
			if (record.kind !== undefined && !["skill", "agent", "prompt", "fleet"].includes(String(record.kind))) {
				diagnostics.push(`skill marketplace index entry has unsupported kind: ${skill.name}`);
				return [];
			}
			if (
				record.requires !== undefined &&
				(!Array.isArray(record.requires) || record.requires.some((entry) => typeof entry !== "string"))
			) {
				diagnostics.push(`library_requirement_malformed: ${skill.name}`);
				return [];
			}
			const kind: LibraryEntryKind =
				record.kind === "agent" || record.kind === "prompt" || record.kind === "fleet" ? record.kind : "skill";
			const requires = Array.isArray(record.requires)
				? record.requires.filter((entry): entry is LibraryRequirementRef => typeof entry === "string")
				: undefined;
			const overlay = optionalString(record.overlay);
			if (overlay && (path.isAbsolute(overlay) || overlay.split("/").includes(".."))) {
				diagnostics.push(`skill marketplace index entry has an overlay outside the package: ${skill.name}`);
				return [];
			}
			const exclude = optionalTriggerList(record.exclude);
			return [
				{
					kind,
					name: skill.name.trim(),
					description: skill.description.trim(),
					sourceUrl: skill.sourceUrl.trim(),
					...(version ? { version } : {}),
					...(audit ? { audit } : {}),
					...(category ? { category } : {}),
					...(triggers ? { triggers } : {}),
					...(requires ? { requires } : {}),
					...(overlay ? { overlay } : {}),
					...(exclude ? { exclude } : {}),
					origin: "index" as const,
				},
			];
		});
	} catch (err) {
		diagnostics.push(`skill marketplace index unreadable: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/**
 * True when the directory contains a <pkg>/SKILL.md either immediately (flat
 * catalog) or one category folder down (grouped catalog, e.g.
 * skills/git/ship/SKILL.md). The loader itself recurses arbitrarily;
 * this probe only decides whether a repo-level skills/ folder is a catalog.
 */
function looksLikeSkillCatalog(dir: string): boolean {
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir, { withFileTypes: true }).some((entry) => {
			if (!entry.isDirectory()) return false;
			const child = path.join(dir, entry.name);
			if (existsSync(path.join(child, "SKILL.md"))) return true;
			try {
				return readdirSync(child, { withFileTypes: true }).some(
					(inner) => inner.isDirectory() && existsSync(path.join(child, inner.name, "SKILL.md")),
				);
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function resolveCatalogDir(options: DiscoverMarketplaceOptions): string | null {
	if (options.catalogDir === null) return null;
	if (options.catalogDir) return path.resolve(options.catalogDir);
	const fromEnv = process.env.CLIO_CODER_SKILL_CATALOG_DIR;
	if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
	const repoCatalog = path.join(options.cwd ?? process.cwd(), "skills");
	if (looksLikeSkillCatalog(repoCatalog)) return repoCatalog;
	// The package's own catalog: rows resolve to local files, so a bare-name
	// install copies out of the package and needs no network. From a checkout
	// of this repository the two paths coincide.
	const bundled = packageCatalogDir();
	return bundled && looksLikeSkillCatalog(bundled) ? bundled : null;
}

/**
 * The catalog folder a package sits in, which is the grouping `--category`
 * installs by. A flat catalog has none, and a package outside the catalog dir
 * (which `path.relative` reports with a leading "..") is not grouped by it.
 */
function catalogCategory(catalogDir: string, baseDir: string): string | undefined {
	const rel = path.relative(catalogDir, baseDir);
	const category = path.dirname(rel);
	if (rel.length === 0 || rel.startsWith("..") || category === "." || category.startsWith("..")) return undefined;
	return category;
}

function catalogEntry(skill: Skill, catalogDir: string): MarketplaceSkill {
	const version = typeof skill.metadata.version === "string" ? skill.metadata.version : undefined;
	const category = catalogCategory(catalogDir, skill.baseDir);
	const triggers = optionalTriggerList(skill.metadata.triggers);
	return {
		name: skill.name,
		description: skill.description,
		sourceUrl: skill.baseDir,
		...(version ? { version } : {}),
		...(skill.provenance?.audit ? { audit: skill.provenance.audit } : {}),
		...(category ? { category } : {}),
		...(triggers ? { triggers } : {}),
		origin: "catalog",
		kind: "skill",
	};
}

function catalogSkills(dir: string, diagnostics: string[]): MarketplaceSkill[] {
	const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [dir] });
	for (const diag of list.diagnostics) {
		if (diag.type === "warning" || diag.type === "error") diagnostics.push(diag.message);
	}
	return list.items.map((skill) => catalogEntry(skill, dir));
}

export function discoverMarketplaceSkills(options: DiscoverMarketplaceOptions = {}): MarketplaceDiscoveryResult {
	const diagnostics: string[] = [];
	const skills: MarketplaceSkill[] = [];
	const seen = new Set<string>();

	const indexPath =
		options.indexPath === null ? null : (options.indexPath ?? process.env.CLIO_CODER_SKILL_MARKETPLACE_INDEX ?? null);
	const resolvedIndexPath = indexPath ?? defaultIndexPath();
	const indexSkills =
		options.indexPath !== null && resolvedIndexPath && existsSync(resolvedIndexPath)
			? parseMarketplaceIndex(resolvedIndexPath, diagnostics)
			: [];
	// A remote entry's overlay folder is also a catalog package on disk, but
	// installing that folder alone would land the wrapper without the upstream
	// it wraps. The index entry that names the overlay is the whole skill.
	const overlayNames = new Set(indexSkills.filter((skill) => skill.overlay).map((skill) => skill.name));

	// Catalog packages first: real local files beat index pointers on name collisions.
	const catalogDir = resolveCatalogDir(options);
	if (catalogDir) {
		for (const skill of catalogSkills(catalogDir, diagnostics)) {
			if (seen.has(skill.name) || overlayNames.has(skill.name)) continue;
			seen.add(skill.name);
			skills.push(skill);
		}
	}

	for (const skill of indexSkills) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		skills.push(skill);
	}

	if (skills.length === 0 && diagnostics.length === 0) {
		diagnostics.push(MARKETPLACE_UNCONFIGURED);
	}
	return { status: skills.length > 0 ? "installable" : "unavailable", skills, diagnostics };
}

export function getMarketplaceSkills(options: DiscoverMarketplaceOptions = {}): MarketplaceSkill[] {
	return discoverMarketplaceSkills(options).skills;
}

/**
 * The install shaping a marketplace entry carries, with its overlay resolved
 * to an absolute directory under the package root. An entry with neither
 * field shapes nothing, so the caller can spread the result unconditionally.
 */
export function marketplaceInstallShaping(skill: MarketplaceSkill): SkillInstallShaping {
	const shaping: SkillInstallShaping = {};
	if (skill.overlay) shaping.overlay = path.join(resolvePackageRoot(), skill.overlay);
	if (skill.exclude && skill.exclude.length > 0) shaping.exclude = [...skill.exclude];
	return shaping;
}

/**
 * Recover the shaping for an installed skill by name and recorded source URL,
 * for `updateSkills`. Only a marketplace entry that still points at the same
 * upstream URL applies; a skill installed from a URL the index no longer
 * carries updates bare, as it was installed.
 */
export function resolveMarketplaceShaping(options: DiscoverMarketplaceOptions = {}) {
	return (installed: { name: string; sourceUrl: string }): SkillInstallShaping | undefined => {
		const entry = getMarketplaceSkills(options).find(
			(skill) => skill.name === installed.name && skill.sourceUrl === installed.sourceUrl,
		);
		if (!entry || (!entry.overlay && !entry.exclude)) return undefined;
		return marketplaceInstallShaping(entry);
	};
}

/**
 * The single install entry point for every frontend (headless CLI, TUI
 * pending-skill prompt, skills hub). Source resolution, in precedence order:
 *
 *  1. A GitHub URL installs directly.
 *  2. An existing local path installs directly; paths always beat same-named
 *     marketplace entries.
 *  3. A bare skill name resolves through the local marketplace.
 *
 * Anything else is an error naming both failed interpretations. Overwriting
 * an existing install always requires an explicit `force: true`.
 */
export function installSkill(input: InstallSkillInput): InstallSkillResult {
	const requested = input.source.trim();
	const source = requested === "clio-dev" ? "clio-coder-dev" : requested === "clio-test" ? "clio-coder-test" : requested;
	if (source !== requested) warnLegacyNaming(requested, source);
	const spec = parseSkillSourceSpec(source);
	if (spec?.kind === "local" && isSkillName(source) && !existsSync(spec.path)) {
		const skill = getMarketplaceSkills({ ...(input.cwd ? { cwd: input.cwd } : {}) }).find(
			(entry) => entry.name === source,
		);
		if (!skill) {
			throw new Error(`"${source}" is neither an existing local path nor available in the local marketplace`);
		}
		return installSkillFromSource({ ...input, ...marketplaceInstallShaping(skill), source: skill.sourceUrl });
	}
	return installSkillFromSource({ ...input, source });
}
