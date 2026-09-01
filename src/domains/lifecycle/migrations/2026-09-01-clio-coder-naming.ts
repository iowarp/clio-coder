import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { settingsPath, withSettingsLock } from "../../../core/config.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { inspectInstalledNamingResources, type NamingResourceReport } from "../naming-resources.js";
import type { Migration } from "./index.js";

export const CLIO_CODER_NAMING_MIGRATION_ID = "2026-09-01-clio-coder-naming";
export const CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX = ".pre-clio-coder-naming.bak";

export interface NamingSettingsTransform {
	document: Record<string, unknown>;
	replacements: string[];
	conflicts: string[];
}

export interface NamingSettingsFileReport {
	path: string;
	changed: boolean;
	backupPath: string | null;
	replacements: string[];
	conflicts: string[];
}

export interface ClioCoderNamingMigrationReport {
	migrationId: typeof CLIO_CODER_NAMING_MIGRATION_ID;
	version: 1;
	settings: NamingSettingsFileReport[];
	toolMarkers: unknown[];
	resources: NamingResourceReport[];
	yazi: unknown[];
	mutableState: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visitNamingValues(value: unknown, path: string, replacements: string[], conflicts: string[]): void {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) visitNamingValues(entry, `${path}[${index}]`, replacements, conflicts);
		return;
	}
	if (!isPlainObject(value)) return;

	for (const [key, entry] of Object.entries(value)) {
		const entryPath = path ? `${path}.${key}` : key;
		if (key === "lifecycle" && entry === "clio-managed") {
			value[key] = "clio-coder-managed";
			replacements.push(`${entryPath}: clio-managed -> clio-coder-managed`);
			continue;
		}
		if (key === "toolGovernance" && entry === "clio-policy") {
			value[key] = "clio-coder-policy";
			replacements.push(`${entryPath}: clio-policy -> clio-coder-policy`);
			continue;
		}
		if (key === "keybindings" && isPlainObject(entry)) {
			for (const legacyKey of Object.keys(entry).filter((name) => name.startsWith("clio."))) {
				const canonicalKey = `clio-coder.${legacyKey.slice("clio.".length)}`;
				const legacyPath = `${entryPath}.${legacyKey}`;
				if (Object.hasOwn(entry, canonicalKey)) {
					delete entry[legacyKey];
					conflicts.push(`${legacyPath}: discarded because canonical ${entryPath}.${canonicalKey} wins`);
					continue;
				}
				entry[canonicalKey] = entry[legacyKey];
				delete entry[legacyKey];
				replacements.push(`${legacyPath} -> ${entryPath}.${canonicalKey}`);
			}
		}
		visitNamingValues(entry, entryPath, replacements, conflicts);
	}
}

/** Pure deterministic settings transform shared by upgrade and doctor --fix. */
export function transformNamingSettingsDocument(raw: unknown): NamingSettingsTransform {
	if (!isPlainObject(raw)) throw new Error("Clio Coder naming migration expected a YAML map at the document root");
	const document = structuredClone(raw);
	const replacements: string[] = [];
	const conflicts: string[] = [];
	visitNamingValues(document, "", replacements, conflicts);
	return { document, replacements, conflicts };
}

/**
 * Rewrite one settings file atomically when it contains deterministic released
 * aliases. The caller owns any cross-process lock needed for the selected file.
 */
export function migrateNamingSettingsFile(path: string): NamingSettingsFileReport {
	if (!existsSync(path)) return { path, changed: false, backupPath: null, replacements: [], conflicts: [] };
	let parsed: unknown;
	try {
		parsed = parseYaml(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Clio Coder naming migration could not read and parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const transformed = transformNamingSettingsDocument(parsed);
	const changed = transformed.replacements.length > 0 || transformed.conflicts.length > 0;
	if (!changed) {
		return {
			path,
			changed: false,
			backupPath: null,
			replacements: transformed.replacements,
			conflicts: transformed.conflicts,
		};
	}
	const backupPath = `${path}${CLIO_CODER_NAMING_SETTINGS_BACKUP_SUFFIX}`;
	safeResourceWrite(path, stringifyYaml(transformed.document), {
		encoding: "utf8",
		mode: 0o644,
		backup: { path: backupPath },
	});
	return {
		path,
		changed: true,
		backupPath,
		replacements: transformed.replacements,
		conflicts: transformed.conflicts,
	};
}

export function namingMigrationReportPath(stateDir: string): string {
	return join(stateDir, "migration-reports", `${CLIO_CODER_NAMING_MIGRATION_ID}.json`);
}

const migration: Migration = {
	id: CLIO_CODER_NAMING_MIGRATION_ID,
	async up(stateDir: string): Promise<void> {
		const settings: NamingSettingsFileReport[] = [];
		withSettingsLock(() => settings.push(migrateNamingSettingsFile(settingsPath())));
		const report: ClioCoderNamingMigrationReport = {
			migrationId: CLIO_CODER_NAMING_MIGRATION_ID,
			version: 1,
			settings,
			toolMarkers: [],
			resources: inspectInstalledNamingResources({ fix: true }),
			yazi: [],
			mutableState: [],
		};
		const target = namingMigrationReportPath(stateDir);
		mkdirSync(join(stateDir, "migration-reports"), { recursive: true });
		safeResourceWrite(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
	},
};

export default migration;
