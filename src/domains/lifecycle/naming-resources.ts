import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { fsyncDirectory } from "../../core/safe-resource-write.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { normalizedSkillHash, stripProvenanceFrontmatter } from "../resources/skills/content-hash.js";

const LEGACY_SKILL_NAMES = [
	["clio-dev", "clio-coder-dev"],
	["clio-test", "clio-coder-test"],
] as const;

export type NamingResourceStatus = "absent" | "canonical-present" | "modified" | "renamable" | "renamed";

export interface NamingResourceReport {
	kind: "skill";
	legacyPath: string;
	canonicalPath: string;
	status: NamingResourceStatus;
	detail: string;
}

export interface NamingResourceOptions {
	cwd?: string;
	configDir?: string;
	packageRoot?: string;
	fix?: boolean;
}

function canonicalizeNamingText(text: string): string {
	return text
		.replaceAll("clio-dev", "clio-coder-dev")
		.replaceAll("clio-test", "clio-coder-test")
		.replace(/^clio:/gmu, "clio-coder:")
		.replace(/^(\s*source:\s*)clio\s*$/gmu, "$1clio-coder");
}

function installedHash(raw: string): string | null {
	const match = raw.match(/^\s*installed-hash:\s*["']?([0-9a-f]{64})["']?\s*$/mu);
	return match?.[1] ?? null;
}

function regularFiles(root: string, current = root): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(current, entry.name);
		if (entry.isDirectory()) out.push(...regularFiles(root, full));
		else if (entry.isFile()) out.push(path.relative(root, full));
		else return [];
	}
	return out;
}

function provesUnmodifiedShippedCopy(legacyDir: string, canonicalBundleDir: string): boolean {
	let legacyFiles: string[];
	let canonicalFiles: string[];
	try {
		legacyFiles = regularFiles(legacyDir);
		canonicalFiles = regularFiles(canonicalBundleDir);
	} catch {
		return false;
	}
	if (legacyFiles.length === 0 || legacyFiles.join("\0") !== canonicalFiles.join("\0")) return false;
	for (const relative of legacyFiles) {
		const legacyRaw = readFileSync(path.join(legacyDir, relative), "utf8");
		const canonicalRaw = readFileSync(path.join(canonicalBundleDir, relative), "utf8");
		if (relative === "SKILL.md") {
			const recordedHash = installedHash(legacyRaw);
			if (recordedHash === null || recordedHash !== normalizedSkillHash(legacyRaw)) return false;
			if (canonicalizeNamingText(stripProvenanceFrontmatter(legacyRaw)) !== stripProvenanceFrontmatter(canonicalRaw))
				return false;
			continue;
		}
		if (canonicalizeNamingText(legacyRaw) !== canonicalRaw) return false;
	}
	return true;
}

function rewriteStagedCopy(stage: string, canonicalBundleDir: string): void {
	const canonicalSkillHash = normalizedSkillHash(readFileSync(path.join(canonicalBundleDir, "SKILL.md"), "utf8"));
	for (const relative of regularFiles(stage)) {
		const file = path.join(stage, relative);
		let next = canonicalizeNamingText(readFileSync(file, "utf8"));
		if (relative === "SKILL.md") {
			next = next.replace(/^(\s*installed-hash:\s*).+$/mu, `$1"${canonicalSkillHash}"`);
		}
		writeFileSync(file, next, "utf8");
	}
}

let resourceSwapSequence = 0;

function migrateProvenSkill(legacyDir: string, canonicalDir: string, canonicalBundleDir: string): void {
	const suffix = `${process.pid}-${++resourceSwapSequence}`;
	const stage = `${canonicalDir}.clio-coder-naming-stage-${suffix}`;
	const backup = `${legacyDir}.clio-coder-naming-backup-${suffix}`;
	mkdirSync(path.dirname(canonicalDir), { recursive: true });
	cpSync(legacyDir, stage, { recursive: true });
	try {
		rewriteStagedCopy(stage, canonicalBundleDir);
		renameSync(legacyDir, backup);
		try {
			renameSync(stage, canonicalDir);
		} catch (error) {
			renameSync(backup, legacyDir);
			throw error;
		}
		rmSync(backup, { recursive: true, force: true });
		fsyncDirectory(path.dirname(canonicalDir));
	} catch (error) {
		rmSync(stage, { recursive: true, force: true });
		throw error;
	}
}

function existingDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/** Inspect only the selected user root and current project; never scan arbitrary repositories. */
export function inspectInstalledNamingResources(options: NamingResourceOptions = {}): NamingResourceReport[] {
	const cwd = options.cwd ?? process.cwd();
	const configDir = options.configDir ?? resolveClioDirs().config;
	const packageRoot = options.packageRoot ?? resolvePackageRoot();
	const roots = [path.join(configDir, "skills"), path.join(cwd, ".clio-coder", "skills")];
	const reports: NamingResourceReport[] = [];
	for (const root of roots) {
		for (const [legacyName, canonicalName] of LEGACY_SKILL_NAMES) {
			const legacyPath = path.join(root, legacyName);
			const canonicalPath = path.join(root, canonicalName);
			if (!existingDirectory(legacyPath)) {
				reports.push({ kind: "skill", legacyPath, canonicalPath, status: "absent", detail: "legacy skill absent" });
				continue;
			}
			if (existsSync(canonicalPath)) {
				reports.push({
					kind: "skill",
					legacyPath,
					canonicalPath,
					status: "canonical-present",
					detail: "canonical skill already exists; legacy copy left untouched",
				});
				continue;
			}
			const canonicalBundleDir = path.join(packageRoot, "skills", "meta", canonicalName);
			if (!existingDirectory(canonicalBundleDir) || !provesUnmodifiedShippedCopy(legacyPath, canonicalBundleDir)) {
				reports.push({
					kind: "skill",
					legacyPath,
					canonicalPath,
					status: "modified",
					detail: "frontmatter/provenance/hash do not prove an unmodified shipped copy; left untouched",
				});
				continue;
			}
			if (options.fix) migrateProvenSkill(legacyPath, canonicalPath, canonicalBundleDir);
			reports.push({
				kind: "skill",
				legacyPath,
				canonicalPath,
				status: options.fix ? "renamed" : "renamable",
				detail: options.fix
					? "proven unmodified shipped copy renamed and canonicalized"
					: "proven unmodified shipped copy can be renamed by doctor --fix",
			});
		}
	}
	return reports;
}

export interface ModelOverlayNamingInspection {
	path: string;
	legacyFile: boolean;
	legacyMetadataKeys: number;
}

export interface SkillMetadataNamingInspection {
	path: string;
	legacyMetadataKey: boolean;
}

function collectSkillFiles(root: string, current = root): string[] {
	if (!existingDirectory(current)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const full = path.join(current, entry.name);
		if (entry.isDirectory()) out.push(...collectSkillFiles(root, full));
		else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
	}
	return out;
}

/** Read-only inventory of released skill metadata keys in selected Clio Coder roots. */
export function inspectSkillMetadataNaming(
	options: Pick<NamingResourceOptions, "cwd" | "configDir"> = {},
): SkillMetadataNamingInspection[] {
	const cwd = options.cwd ?? process.cwd();
	const configDir = options.configDir ?? resolveClioDirs().config;
	const roots = [path.join(configDir, "skills"), path.join(cwd, ".clio-coder", "skills")];
	return roots.flatMap((root) =>
		collectSkillFiles(root).map((file) => ({
			path: file,
			legacyMetadataKey: /^clio:\s*(?:#.*)?$/mu.test(readFileSync(file, "utf8")),
		})),
	);
}

function countLegacyModelMetadata(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((count, entry) => count + countLegacyModelMetadata(entry), 0);
	if (typeof value !== "object" || value === null) return 0;
	const record = value as Record<string, unknown>;
	return (
		(Object.hasOwn(record, "clio") ? 1 : 0) +
		Object.values(record).reduce<number>((count, entry) => count + countLegacyModelMetadata(entry), 0)
	);
}

/** Read-only overlay inventory. User catalog files are never silently rewritten. */
export function inspectModelOverlayNaming(
	options: Pick<NamingResourceOptions, "cwd" | "configDir"> = {},
): ModelOverlayNamingInspection[] {
	const cwd = options.cwd ?? process.cwd();
	const configDir = options.configDir ?? resolveClioDirs().config;
	const roots = [path.join(configDir, "model-catalog.d"), path.join(cwd, ".clio-coder", "model-catalog.d")];
	const inspections: ModelOverlayNamingInspection[] = [];
	for (const root of roots) {
		if (!existingDirectory(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))) continue;
			const file = path.join(root, entry.name);
			let legacyMetadataKeys = 0;
			try {
				legacyMetadataKeys = countLegacyModelMetadata(parseYaml(readFileSync(file, "utf8")));
			} catch {
				// The catalog loader owns the parse diagnostic; naming still reports the filename.
			}
			inspections.push({
				path: file,
				legacyFile: entry.name === "clio-local-coding-targets.yaml",
				legacyMetadataKeys,
			});
		}
	}
	return inspections;
}
