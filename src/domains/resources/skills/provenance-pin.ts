/**
 * Local-first skill provenance pinning.
 *
 * `skills/registry.yaml` (regenerated with `npm run skills:pin`) pins the
 * provenance-stripped sha256 of every marketplace skill's SKILL.md. At
 * activation time, a skill carrying marketplace provenance (`registry-id`
 * frontmatter) is compared against the pinned entry on the same normalized
 * hash, so install-lifecycle stamps (`installed-at`, `installed-hash`, ...)
 * never read as drift while any content or registry-identity edit does. A
 * mismatch means the installed content drifted from its audited form. Drift
 * never blocks; skills still pass through the normal tool safety gates. No
 * network, no remote registry, no signing; this is hash comparison against a
 * local manifest.
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
function resolveSkillPinManifestPath(cwd: string): string | null {
	const fromEnv = process.env.CLIO_CODER_SKILL_CATALOG_DIR;
	const catalogDir = fromEnv && fromEnv.trim().length > 0 ? path.resolve(fromEnv.trim()) : path.join(cwd, "skills");
	const manifestPath = path.join(catalogDir, SKILL_PIN_MANIFEST_FILENAME);
	return existsSync(manifestPath) ? manifestPath : null;
}

function loadSkillPinManifest(manifestPath: string): Map<string, SkillPinEntry> | null {
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

/** Which recorded hash the activated content was measured against. */
export type SkillDriftAuthority = "pinned-manifest" | "install-record";

export interface SkillDriftReport {
	verdict: SkillDriftVerdict;
	authority: SkillDriftAuthority;
	/** The hash the content was compared against, for the operator's record. */
	expected: string;
}

/**
 * Compare an activated skill against whatever recorded hash can speak for it.
 *
 * Two independent authorities, tried in that order because they answer
 * different questions. The pinned manifest says what the audited catalog
 * entry's content is, so it wins wherever it has an entry. The skill's own
 * `installed-hash` frontmatter says what this machine wrote at install time,
 * which is the only evidence available for a skill installed straight from a
 * URL, and it catches the case the manifest cannot see at all: content edited
 * on disk after installation.
 *
 * Both compare on the provenance-stripped hash, so install-lifecycle stamps
 * never read as drift while any content or registry-identity edit does. Null
 * means nothing recorded a hash for this skill; drift evidence is opt-in and
 * never a gate, and skills still pass the normal tool safety gates either way.
 */
export function checkSkillDrift(
	skill: { name: string; normalizedHash: string; provenance?: { installedHash?: string } },
	cwd: string,
): SkillDriftReport | null {
	const actual = skill.normalizedHash.toLowerCase();
	const manifestPath = resolveSkillPinManifestPath(cwd);
	const manifest = manifestPath === null ? null : loadSkillPinManifest(manifestPath);
	const pinned = manifest?.get(skill.name);
	if (pinned !== undefined) {
		return {
			verdict: pinned.sha256 === actual ? "match" : "mismatch",
			authority: "pinned-manifest",
			expected: pinned.sha256,
		};
	}
	const recorded = skill.provenance?.installedHash?.trim().toLowerCase();
	if (recorded !== undefined && /^[0-9a-f]{64}$/.test(recorded)) {
		return {
			verdict: recorded === actual ? "match" : "mismatch",
			authority: "install-record",
			expected: recorded,
		};
	}
	return null;
}
