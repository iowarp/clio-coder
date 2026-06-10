import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { clioConfigDir } from "../../../core/xdg.js";
import { type InstallSkillResult, installSkill } from "./install.js";

export interface MarketplaceSkill {
	name: string;
	description: string;
	sourceUrl: string;
}

export type MarketplaceStatus = "installed" | "installable" | "unavailable";

export interface MarketplaceDiscoveryResult {
	status: MarketplaceStatus;
	skills: MarketplaceSkill[];
	diagnostic?: string;
}

function isMarketplaceSkill(value: unknown): value is MarketplaceSkill {
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

function defaultIndexPath(): string | null {
	try {
		return path.join(clioConfigDir(), "skill-marketplace.json");
	} catch {
		return null;
	}
}

export function discoverMarketplaceSkills(
	indexPath = process.env.CLIO_SKILL_MARKETPLACE_INDEX || defaultIndexPath(),
): MarketplaceDiscoveryResult {
	if (!indexPath || !existsSync(indexPath)) {
		return { status: "unavailable", skills: [], diagnostic: "no local skill marketplace index configured" };
	}
	try {
		const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
		const rawSkills = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { skills?: unknown }).skills)
				? (parsed as { skills: unknown[] }).skills
				: [];
		const skills = rawSkills.filter(isMarketplaceSkill).map((skill) => ({
			name: skill.name.trim(),
			description: skill.description.trim(),
			sourceUrl: skill.sourceUrl.trim(),
		}));
		return { status: skills.length > 0 ? "installable" : "unavailable", skills };
	} catch (err) {
		return {
			status: "unavailable",
			skills: [],
			diagnostic: err instanceof Error ? err.message : String(err),
		};
	}
}

export function getMarketplaceSkills(): MarketplaceSkill[] {
	return discoverMarketplaceSkills().skills;
}

export async function installMarketplaceSkill(
	name: string,
	options: { scope?: "user" | "project"; cwd?: string; configDir?: string } = {},
): Promise<InstallSkillResult> {
	const skill = getMarketplaceSkills().find((entry) => entry.name === name);
	if (!skill) throw new Error(`Skill ${name} is not available in the local marketplace index`);
	return installSkill({
		source: skill.sourceUrl,
		scope: options.scope ?? "project",
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.configDir ? { configDir: options.configDir } : {}),
		force: true,
	});
}
