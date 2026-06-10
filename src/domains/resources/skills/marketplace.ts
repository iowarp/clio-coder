import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { clioConfigDir } from "../../../core/xdg.js";
import { type InstallSkillResult, installSkill } from "./install.js";
import { loadSkills, type Skill } from "./loader.js";

/**
 * Local skill marketplace. Entries come from two real sources only:
 *
 *  1. A catalog directory of actual SKILL.md packages (for example the
 *     repo-level skills/ folder, or CLIO_SKILL_CATALOG_DIR). Metadata is read
 *     from the packages themselves via the normal skill loader.
 *  2. A JSON index file (CLIO_SKILL_MARKETPLACE_INDEX or
 *     <config>/skill-marketplace.json) whose entries point at installable
 *     sources.
 *
 * There is no synthetic or hardcoded marketplace data; an empty result means
 * no marketplace is configured.
 */

export type MarketplaceSkillOrigin = "catalog" | "index";

export interface MarketplaceSkill {
	name: string;
	description: string;
	/** Local path or URL accepted by `clio skills install`. */
	sourceUrl: string;
	version?: string;
	audit?: "pass" | "warn" | "fail" | "unknown";
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

function indexSkills(indexPath: string, diagnostics: string[]): MarketplaceSkill[] {
	try {
		const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
		const rawSkills = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { skills?: unknown }).skills)
				? (parsed as { skills: unknown[] }).skills
				: [];
		return rawSkills.filter(isIndexSkill).map((skill) => ({
			name: skill.name.trim(),
			description: skill.description.trim(),
			sourceUrl: skill.sourceUrl.trim(),
			origin: "index" as const,
		}));
	} catch (err) {
		diagnostics.push(`skill marketplace index unreadable: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/** True when the directory contains at least one immediate <pkg>/SKILL.md. */
function looksLikeSkillCatalog(dir: string): boolean {
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir, { withFileTypes: true }).some(
			(entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "SKILL.md")),
		);
	} catch {
		return false;
	}
}

function resolveCatalogDir(options: DiscoverMarketplaceOptions): string | null {
	if (options.catalogDir === null) return null;
	if (options.catalogDir) return path.resolve(options.catalogDir);
	const fromEnv = process.env.CLIO_SKILL_CATALOG_DIR;
	if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
	const repoCatalog = path.join(options.cwd ?? process.cwd(), "skills");
	return looksLikeSkillCatalog(repoCatalog) ? repoCatalog : null;
}

function catalogEntry(skill: Skill): MarketplaceSkill {
	const version = typeof skill.metadata.version === "string" ? skill.metadata.version : undefined;
	return {
		name: skill.name,
		description: skill.description,
		sourceUrl: skill.baseDir,
		...(version ? { version } : {}),
		...(skill.provenance?.audit ? { audit: skill.provenance.audit } : {}),
		origin: "catalog",
	};
}

function catalogSkills(dir: string, diagnostics: string[]): MarketplaceSkill[] {
	const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [dir] });
	for (const diag of list.diagnostics) {
		if (diag.type === "warning" || diag.type === "error") diagnostics.push(diag.message);
	}
	return list.items.map(catalogEntry);
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
		options.indexPath === null ? null : (options.indexPath ?? process.env.CLIO_SKILL_MARKETPLACE_INDEX ?? null);
	const resolvedIndexPath = indexPath ?? defaultIndexPath();
	if (options.indexPath !== null && resolvedIndexPath && existsSync(resolvedIndexPath)) {
		for (const skill of indexSkills(resolvedIndexPath, diagnostics)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			skills.push(skill);
		}
	}

	if (skills.length === 0 && diagnostics.length === 0) {
		diagnostics.push("no local skill marketplace catalog or index configured");
	}
	return { status: skills.length > 0 ? "installable" : "unavailable", skills, diagnostics };
}

export function getMarketplaceSkills(options: DiscoverMarketplaceOptions = {}): MarketplaceSkill[] {
	return discoverMarketplaceSkills(options).skills;
}

export async function installMarketplaceSkill(
	name: string,
	options: { scope?: "user" | "project"; cwd?: string; configDir?: string } = {},
): Promise<InstallSkillResult> {
	const skill = getMarketplaceSkills({ ...(options.cwd ? { cwd: options.cwd } : {}) }).find(
		(entry) => entry.name === name,
	);
	if (!skill) throw new Error(`Skill ${name} is not available in the local marketplace`);
	return installSkill({
		source: skill.sourceUrl,
		scope: options.scope ?? "project",
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.configDir ? { configDir: options.configDir } : {}),
		force: true,
	});
}
