import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { withSettingsLock } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	migrateNamingSettingsFile,
	transformNamingSettingsDocument,
} from "../domains/lifecycle/migrations/2026-09-01-clio-coder-naming.js";
import { inspectNamingHistory } from "../domains/lifecycle/naming-history.js";
import {
	inspectInstalledNamingResources,
	inspectModelOverlayNaming,
	inspectSkillMetadataNaming,
} from "../domains/lifecycle/naming-resources.js";
import { inspectToolMarkerNaming } from "../domains/lifecycle/naming-tool-markers.js";
import { inspectYaziNaming, regenerateYaziNamingProfile } from "../domains/lifecycle/naming-yazi.js";

export interface NamingDoctorOptions {
	fix?: boolean;
	cwd?: string;
	yaziEnabled?: boolean;
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

function namingEnvironmentFindings(
	yaziEnabled: boolean,
	environment: NodeJS.ProcessEnv = process.env,
): DoctorFinding[] {
	const present = LEGACY_ENVIRONMENT_NAMES.filter(
		([legacy]) => (yaziEnabled || legacy !== "CLIO_YAZI_PICK_TOKEN") && Boolean(environment[legacy]?.trim()),
	);
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

function yaziNamingFinding(fix: boolean, enabled: boolean): DoctorFinding {
	if (!enabled) {
		return {
			ok: true,
			name: "naming yazi profile",
			detail: "disabled by settings",
		};
	}
	const inspection = inspectYaziNaming();
	const legacy = inspection.legacyEvents + inspection.legacyEnvironmentNames;
	if (legacy === 0) {
		return {
			ok: true,
			name: "naming yazi profile",
			detail: inspection.present
				? `${inspection.profileDir} uses canonical event and environment identifiers`
				: `${inspection.profileDir} is absent; the next managed open will generate canonical identifiers`,
		};
	}
	if (!fix) {
		return {
			ok: true,
			level: "warn",
			name: "naming yazi profile",
			detail: `${inspection.profileDir}: ${inspection.legacyEvents} legacy events and ${inspection.legacyEnvironmentNames} legacy environment names (run \`clio-coder doctor --fix\`)`,
		};
	}
	const report = regenerateYaziNamingProfile();
	return {
		ok: report.status !== "regeneration-failed",
		...(report.status === "regeneration-failed" ? {} : { level: "ok" as const }),
		name: "naming yazi profile",
		detail: report.detail,
	};
}

function toolMarkerNamingFinding(fix: boolean): DoctorFinding {
	try {
		const reports = inspectToolMarkerNaming({ fix });
		if (reports.length === 0) {
			return { ok: true, name: "naming tool markers", detail: "known tool versions use canonical install markers" };
		}
		const fixed = reports.filter((entry) => entry.status === "renamed" || entry.status === "duplicate-removed").length;
		const fixable = reports.filter(
			(entry) => entry.status === "renamable" || entry.status === "agreeing-duplicate",
		).length;
		const manual = reports.length - fixed - fixable;
		return {
			ok: true,
			level: fixed > 0 && fixable === 0 && manual === 0 ? "ok" : "warn",
			name: "naming tool markers",
			detail: `${fixed} validated markers fixed; ${fixable} await doctor --fix; ${manual} invalid/conflicting markers left untouched`,
		};
	} catch (error) {
		return {
			ok: false,
			name: "naming tool markers",
			detail: `tool marker inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function immutableHistoryNamingFinding(): DoctorFinding {
	const dirs = resolveClioDirs();
	const counts = inspectNamingHistory({ stateDir: dirs.state, dataDir: dirs.data });
	const errors = counts.filter((entry) => entry.error !== null);
	if (errors.length > 0) {
		return {
			ok: false,
			name: "naming immutable history",
			detail: errors.map((entry) => `${entry.area}: ${entry.error}`).join("; "),
		};
	}
	const legacy = counts.reduce((sum, entry) => sum + entry.legacyIdentifiers, 0);
	return {
		ok: true,
		...(legacy > 0 ? { level: "warn" as const } : {}),
		name: "naming immutable history",
		detail: `${counts.map((entry) => `${entry.area}=${entry.legacyIdentifiers}`).join("; ")} legacy identifiers; read-only retention, no rewrite`,
	};
}

function legacyGitRefsFinding(cwd: string): DoctorFinding {
	let refs: string[];
	try {
		refs = execFileSync(
			"git",
			["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/clio/task", "refs/heads/clio/compete"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
		)
			.split("\n")
			.map((entry) => entry.trim())
			.filter((entry) => /^clio\/(?:task|compete)\//u.test(entry))
			.sort();
	} catch {
		refs = [];
	}
	if (refs.length === 0) {
		return { ok: true, name: "naming git refs", detail: "no legacy Clio Coder task or compete refs found" };
	}
	const shown = refs.slice(0, 20);
	return {
		ok: true,
		level: "warn",
		name: "naming git refs",
		detail: `${refs.length} legacy refs retained (never auto-renamed): ${shown.join(", ")}${refs.length > shown.length ? ", …" : ""}`,
	};
}

function legacyWorktreeMarkerFinding(cwd: string): DoctorFinding {
	const root = join(cwd, ".clio-coder", "worktrees");
	let legacy = 0;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const candidates = entry.isFile()
				? entry.name.endsWith(".task-owner.json")
					? [join(root, entry.name)]
					: []
				: entry.isDirectory()
					? [join(root, entry.name, ".clio-coder-compete-owner.json")]
					: [];
			for (const path of candidates) {
				if (!existsSync(path)) continue;
				const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (parsed.kind === "clio-task-worktree" || parsed.kind === "clio-compete-group") legacy += 1;
			}
		}
	} catch {
		// An absent or partially unreadable project-local worktree root is not a
		// repair target. Proven markers remain the lifecycle readers' authority.
	}
	return {
		ok: true,
		...(legacy > 0 ? { level: "warn" as const } : {}),
		name: "naming worktree markers",
		detail:
			legacy === 0
				? "active worktree markers use canonical identifiers"
				: `${legacy} active legacy worktree markers retained for cleanup compatibility; no automatic rewrite`,
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
	findings.push(...namingEnvironmentFindings(options.yaziEnabled ?? true));
	findings.push(...namingResourceFindings({ ...options, cwd }));
	findings.push(yaziNamingFinding(Boolean(options.fix), options.yaziEnabled ?? true));
	findings.push(toolMarkerNamingFinding(Boolean(options.fix)));
	findings.push(immutableHistoryNamingFinding());
	findings.push(legacyGitRefsFinding(cwd));
	findings.push(legacyWorktreeMarkerFinding(cwd));
	return findings;
}
