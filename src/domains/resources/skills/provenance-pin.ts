/**
 * Local-first skill provenance pinning.
 *
 * `skills/registry.yaml` (regenerated with `npm run skills:pin`) pins the
 * sha256 of every marketplace skill's SKILL.md. At activation time, a skill
 * carrying marketplace provenance (`registry-id` frontmatter) is compared
 * against the pinned entry: a mismatch means the installed content drifted
 * from its audited form. Drift never blocks; skills still pass through the
 * normal tool safety gates. No network, no remote registry, no signing; this
 * is hash comparison against a local manifest.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

export const SKILL_PIN_MANIFEST_FILENAME = "registry.yaml";

export interface SkillPinEntry {
	name: string;
	version: string | null;
	sha256: string;
}

export type SkillDriftVerdict = "match" | "mismatch";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the manifest path using the same catalog resolution as the marketplace. */
export function resolveSkillPinManifestPath(cwd: string): string | null {
	const fromEnv = process.env.CLIO_SKILL_CATALOG_DIR;
	const catalogDir = fromEnv && fromEnv.trim().length > 0 ? path.resolve(fromEnv.trim()) : path.join(cwd, "skills");
	const manifestPath = path.join(catalogDir, SKILL_PIN_MANIFEST_FILENAME);
	return existsSync(manifestPath) ? manifestPath : null;
}

export function loadSkillPinManifest(manifestPath: string): Map<string, SkillPinEntry> | null {
	let parsed: unknown;
	try {
		parsed = yaml.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return null;
	}
	if (!isPlainObject(parsed) || !Array.isArray(parsed.skills)) return null;
	const entries = new Map<string, SkillPinEntry>();
	for (const raw of parsed.skills) {
		if (!isPlainObject(raw)) continue;
		const name = typeof raw.name === "string" ? raw.name.trim() : "";
		const sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
		if (name.length === 0 || !/^[0-9a-f]{64}$/.test(sha256)) continue;
		entries.set(name, {
			name,
			version: typeof raw.version === "string" && raw.version.trim().length > 0 ? raw.version.trim() : null,
			sha256,
		});
	}
	return entries;
}

/**
 * Compare an activated skill against the pinned manifest. Returns null when
 * no manifest exists locally or the manifest has no entry for the skill
 * (silent pass: pinning is opt-in evidence, not a gate).
 */
export function checkSkillDrift(skill: { name: string; hash: string }, cwd: string): SkillDriftVerdict | null {
	const manifestPath = resolveSkillPinManifestPath(cwd);
	if (manifestPath === null) return null;
	const manifest = loadSkillPinManifest(manifestPath);
	if (manifest === null) return null;
	const entry = manifest.get(skill.name);
	if (entry === undefined) return null;
	return entry.sha256 === skill.hash.toLowerCase() ? "match" : "mismatch";
}
