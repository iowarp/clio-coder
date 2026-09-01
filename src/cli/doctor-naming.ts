import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { withSettingsLock } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	migrateNamingSettingsFile,
	transformNamingSettingsDocument,
} from "../domains/lifecycle/migrations/2026-09-01-clio-coder-naming.js";
import {
	inspectInstalledNamingResources,
	inspectModelOverlayNaming,
	inspectSkillMetadataNaming,
} from "../domains/lifecycle/naming-resources.js";

export interface NamingDoctorOptions {
	fix?: boolean;
	cwd?: string;
}

interface SettingsNamingInspection {
	path: string;
	legacy: number;
	conflicts: number;
	error: string | null;
}

const LEGACY_ENVIRONMENT_NAMES = [
	["CLIO_EVAL_RUNNER_STDOUT_FILE", "CLIO_CODER_EVAL_RUNNER_STDOUT_FILE"],
	["CLIO_YAZI_PICK_TOKEN", "CLIO_CODER_YAZI_PICK_TOKEN"],
] as const;

function namingEnvironmentFindings(environment: NodeJS.ProcessEnv = process.env): DoctorFinding[] {
	const present = LEGACY_ENVIRONMENT_NAMES.filter(([legacy]) => Boolean(environment[legacy]?.trim()));
	if (present.length === 0) {
		return [{ ok: true, name: "naming environment", detail: "no legacy Clio Coder environment variables are set" }];
	}
	return present.map(([legacy, canonical]) => ({
		ok: true,
		level: "warn",
		name: "naming environment",
		detail: `${legacy} is deprecated; use ${canonical} (compatibility ends in v0.7.0)`,
	}));
}

function namingResourceFindings(options: NamingDoctorOptions): DoctorFinding[] {
	try {
		const resourceOptions = {
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.fix !== undefined ? { fix: options.fix } : {}),
		};
		const resources = inspectInstalledNamingResources(resourceOptions);
		const legacyResources = resources.filter((entry) => entry.status !== "absent");
		const rootOptions = options.cwd ? { cwd: options.cwd } : {};
		const skillMetadata = inspectSkillMetadataNaming(rootOptions).filter((entry) => entry.legacyMetadataKey);
		const overlays = inspectModelOverlayNaming(rootOptions).filter(
			(entry) => entry.legacyFile || entry.legacyMetadataKeys > 0,
		);
		if (legacyResources.length === 0 && skillMetadata.length === 0 && overlays.length === 0) {
			return [{ ok: true, name: "naming resources", detail: "installed skills and model overlays use canonical names" }];
		}
		const renamed = legacyResources.filter((entry) => entry.status === "renamed").length;
		const renamable = legacyResources.filter((entry) => entry.status === "renamable").length;
		const conflicts = legacyResources.filter(
			(entry) => entry.status === "modified" || entry.status === "canonical-present",
		).length;
		return [
			{
				ok: true,
				level:
					renamed > 0 && renamable === 0 && conflicts === 0 && skillMetadata.length === 0 && overlays.length === 0
						? "ok"
						: "warn",
				name: "naming resources",
				detail: [
					`${renamed} proven skills renamed`,
					`${renamable} proven skills await doctor --fix`,
					`${conflicts} modified/conflicting skills left untouched`,
					`${skillMetadata.length} legacy skill metadata keys`,
					`${overlays.length} legacy model overlay files/metadata (manual migration required)`,
				].join("; "),
			},
		];
	} catch (error) {
		return [
			{
				ok: false,
				name: "naming resources",
				detail: `resource naming inspection failed: ${error instanceof Error ? error.message : String(error)}`,
			},
		];
	}
}

function inspectSettingsNaming(path: string): SettingsNamingInspection {
	if (!existsSync(path)) return { path, legacy: 0, conflicts: 0, error: null };
	try {
		const transformed = transformNamingSettingsDocument(parseYaml(readFileSync(path, "utf8")));
		return {
			path,
			legacy: transformed.replacements.length,
			conflicts: transformed.conflicts.length,
			error: null,
		};
	} catch (error) {
		return { path, legacy: 0, conflicts: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

function settingsFinding(label: string, inspection: SettingsNamingInspection, fixed: boolean): DoctorFinding {
	if (inspection.error !== null) {
		return {
			ok: false,
			name: `naming ${label}`,
			detail: `${inspection.path} could not be inspected: ${inspection.error}`,
		};
	}
	const count = inspection.legacy + inspection.conflicts;
	if (count === 0) {
		return { ok: true, name: `naming ${label}`, detail: `${inspection.path} has canonical settings identifiers` };
	}
	return {
		ok: fixed,
		level: fixed ? "ok" : "warn",
		name: `naming ${label}`,
		detail: fixed
			? `${inspection.path}: migrated ${inspection.legacy} aliases and resolved ${inspection.conflicts} canonical collisions; backup written beside the file`
			: `${inspection.path}: ${inspection.legacy} legacy aliases and ${inspection.conflicts} canonical collisions (run \`clio-coder doctor --fix\`)`,
	};
}

/** Read-only naming-footprint settings sweep plus the sanctioned deterministic fixes. */
export function namingFootprintFindings(options: NamingDoctorOptions = {}): DoctorFinding[] {
	const cwd = options.cwd ?? process.cwd();
	const userSettingsPath = join(resolveClioDirs().config, "settings.yaml");
	const candidates = [
		{ label: "settings user", path: userSettingsPath, lock: true },
		{ label: "settings project", path: join(cwd, ".clio-coder", "settings.yaml"), lock: false },
		{ label: "settings local", path: join(cwd, ".clio-coder", "settings.local.yaml"), lock: false },
	] as const;
	const findings: DoctorFinding[] = [];
	for (const candidate of candidates) {
		const before = inspectSettingsNaming(candidate.path);
		let fixed = false;
		if (options.fix && before.error === null && before.legacy + before.conflicts > 0) {
			try {
				if (candidate.lock) withSettingsLock(() => migrateNamingSettingsFile(candidate.path));
				else migrateNamingSettingsFile(candidate.path);
				fixed = true;
			} catch (error) {
				findings.push({
					ok: false,
					name: `naming ${candidate.label}`,
					detail: `--fix could not migrate ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
		}
		findings.push(settingsFinding(candidate.label, before, fixed));
	}
	findings.push(...namingEnvironmentFindings());
	findings.push(...namingResourceFindings({ ...options, cwd }));
	return findings;
}
