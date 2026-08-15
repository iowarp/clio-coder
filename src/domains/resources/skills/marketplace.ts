import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { clioConfigDir } from "../../../core/xdg.js";
import {
	type InstallSkillInput,
	type InstallSkillResult,
	installSkillFromSource,
	isSkillName,
	parseSkillSourceSpec,
} from "./install.js";
import { loadSkills, type Skill } from "./loader.js";

/**
 * Local skill marketplace. Entries come from two real sources only:
 *
 *  1. A catalog directory of actual SKILL.md packages (for example the
 *     repo-level skills/ folder, or CLIO_CODER_SKILL_CATALOG_DIR). Metadata is read
 *     from the packages themselves via the normal skill loader.
 *  2. A JSON index file (CLIO_CODER_SKILL_MARKETPLACE_INDEX or
 *     <config>/skill-marketplace.json) whose entries point at installable
 *     sources.
 *
 * There is no synthetic or hardcoded marketplace data; an empty result means
 * no marketplace is configured.
 */

export type MarketplaceSkillOrigin = "catalog" | "index";

/**
 * The diagnostic that means "nothing is wrong, nothing is configured". Callers
 * that render an empty state of their own separate it from real failures (an
 * unreadable index, a broken package) by identity rather than by string match.
 */
export const MARKETPLACE_UNCONFIGURED = "no local skill marketplace catalog or index configured";

export interface MarketplaceSkill {
	name: string;
	description: string;
	/** Local path or URL accepted by `clio-coder skills install`. */
	sourceUrl: string;
	version?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
	/** Catalog grouping ("git", "research", ...); absent in a flat catalog. */
	category?: string;
	origin: MarketplaceSkillOrigin;
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

function defaultIndexPath(): string | null {
	try {
		return path.join(clioConfigDir(), "skill-marketplace.json");
	} catch {
		return null;
	}
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

function indexAudit(value: unknown): MarketplaceSkill["audit"] {
	return value === "pass" || value === "warn" || value === "fail" || value === "unknown" ? value : undefined;
}

function indexSkills(indexPath: string, diagnostics: string[]): MarketplaceSkill[] {
	try {
		const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
		const rawSkills = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { skills?: unknown }).skills)
				? (parsed as { skills: unknown[] }).skills
				: [];
		return rawSkills.filter(isIndexSkill).map((skill) => {
			const record = skill as unknown as Record<string, unknown>;
			// Version, audit and category are published by `npm run skills:pin`.
			// They are advisory display metadata; an index entry stays installable
			// without them, which is why only name/description/sourceUrl gate.
			const version = optionalString(record.version);
			const audit = indexAudit(record.audit);
			const category = optionalString(record.category);
			return {
				name: skill.name.trim(),
				description: skill.description.trim(),
				sourceUrl: skill.sourceUrl.trim(),
				...(version ? { version } : {}),
				...(audit ? { audit } : {}),
				...(category ? { category } : {}),
				origin: "index" as const,
			};
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
	return looksLikeSkillCatalog(repoCatalog) ? repoCatalog : null;
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
	return {
		name: skill.name,
		description: skill.description,
		sourceUrl: skill.baseDir,
		...(version ? { version } : {}),
		...(skill.provenance?.audit ? { audit: skill.provenance.audit } : {}),
		...(category ? { category } : {}),
		origin: "catalog",
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

	// Catalog packages first: real local files beat index pointers on name collisions.
	const catalogDir = resolveCatalogDir(options);
	if (catalogDir) {
		for (const skill of catalogSkills(catalogDir, diagnostics)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			skills.push(skill);
		}
	}

	const indexPath =
		options.indexPath === null ? null : (options.indexPath ?? process.env.CLIO_CODER_SKILL_MARKETPLACE_INDEX ?? null);
	const resolvedIndexPath = indexPath ?? defaultIndexPath();
	if (options.indexPath !== null && resolvedIndexPath && existsSync(resolvedIndexPath)) {
		for (const skill of indexSkills(resolvedIndexPath, diagnostics)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			skills.push(skill);
		}
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
	const source = input.source.trim();
	const spec = parseSkillSourceSpec(source);
	if (spec?.kind === "local" && isSkillName(source) && !existsSync(spec.path)) {
		const skill = getMarketplaceSkills({ ...(input.cwd ? { cwd: input.cwd } : {}) }).find(
			(entry) => entry.name === source,
		);
		if (!skill) {
			throw new Error(`"${source}" is neither an existing local path nor available in the local marketplace`);
		}
		return installSkillFromSource({ ...input, source: skill.sourceUrl });
	}
	return installSkillFromSource(input);
}
