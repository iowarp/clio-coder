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
	return findings;
}
