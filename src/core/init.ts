/**
 * Bootstrap Clio's config/data/state/cache directories on first install.
 * Creates the full directory tree required by subsequent domains and writes
 * defaults when absent. Idempotent.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
	legacyMigrationManifestPath,
	migrationManifestPath,
	REGISTERED_MIGRATION_IDS,
	RETIRED_MIGRATION_IDS,
} from "../domains/lifecycle/migrations/registry-ids.js";
import { isDevVersion } from "./build-info.js";
import { DEFAULT_SETTINGS_YAML, SETTINGS_FILE_MODE } from "./defaults.js";
import { readClioVersion } from "./package-root.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import { assertClioDirLayout, clioCacheDir, clioConfigDir, clioDataDir, clioStateDir, resolveClioDirs } from "./xdg.js";

export interface InitReport {
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	createdPaths: string[];
	touchedSettings: boolean;
	/** Set when a newer Clio last used this home; `home.json` was then left as it was. */
	newerHome?: NewerHome;
}

/** A home last written by a newer Clio than the running one. */
export interface NewerHome {
	version: string;
	/** Applied migration ids this build does not register. */
	unknownMigrations: string[];
}

const CONFIG_SUBDIRS = ["agents"] as const;
const DATA_SUBDIRS = ["memory"] as const;
const STATE_SUBDIRS = ["sessions", "interviews", "scratch"] as const;
// State directories that are only ever Clio's and hold transcripts, tool output or run records.
const PRIVATE_STATE_SUBDIRS = [...STATE_SUBDIRS, "telemetry", "live", "runs", "fleet-runs"] as const;

interface InstallMetadata {
	version: string;
	/**
	 * When Clio was first installed on this machine, present only when that is
	 * actually known. Absent on a record this process had to synthesize over a
	 * state root that already existed, where the install time is unrecoverable.
	 */
	installedAt?: string;
	upgradedAt?: string;
	/**
	 * When this record was rebuilt because it was missing or unreadable. A repair
	 * is not an install and must never be written into `installedAt`: `clio-coder
	 * doctor --fix` over a wiped state root reported the repair minute as the day
	 * the user installed Clio, and every later run repeated it as fact.
	 */
	repairedAt?: string;
	/**
	 * The version on record before the most recent version change, kept so the
	 * first interactive launch after an upgrade can say where it came from and
	 * `doctor` can show it. Absent on a home that has never changed version.
	 */
	upgradedFrom?: string;
	/**
	 * The newer version this home was taken back from, after the operator
	 * accepted running an older Clio on it. Cleared by the next upgrade.
	 */
	downgradedFrom?: string;
	/**
	 * The version whose upgrade notice the operator has already seen. Written
	 * by the interactive boot, once per version, so the notice never repeats.
	 */
	noticedVersion?: string;
	platform: string;
	nodeVersion: string;
}

/**
 * Close Clio's own state directories an older build left group or world readable. Not recursive: a closed
 * parent hides everything below it. The roots are left alone; an operator may share one with other tools.
 */
function tightenPrivateStateDirs(stateDir: string): void {
	if (process.platform === "win32") return;
	for (const sub of PRIVATE_STATE_SUBDIRS) {
		const full = join(stateDir, sub);
		try {
			const stat = lstatSync(full);
			if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) chmodSync(full, 0o700);
		} catch {
			// Missing or unreadable: nothing to tighten.
		}
	}
}

export function initializeClioHome(): InitReport {
	enforceHomePrefixGuard();

	// Probed from the resolved paths, before the accessors below create them:
	// clioStateDir() makes the directory it is being asked about, so anything
	// checked after it reports a first install on every run. A root that is
	// already there means whatever this call is about to write is a repair.
	const resolved = resolveClioDirs();
	// A role nested in another role turns a scoped reset into an accidental
	// cross-role wipe. Refuse before any accessor below creates a directory.
	assertClioDirLayout(resolved);
	const preexistingHome = existsSync(resolved.state) || existsSync(resolved.config) || existsSync(resolved.data);
	const settingsExisted = existsSync(join(resolved.config, "settings.yaml"));

	const configDir = clioConfigDir();
	const dataDir = clioDataDir();
	const stateDir = clioStateDir();
	const cacheDir = clioCacheDir();

	const created: string[] = [];

	for (const dir of [configDir, dataDir, stateDir, cacheDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			created.push(dir);
		}
	}

	const subdirSets: ReadonlyArray<[string, ReadonlyArray<string>]> = [
		[configDir, CONFIG_SUBDIRS],
		[dataDir, DATA_SUBDIRS],
		[stateDir, STATE_SUBDIRS],
	];
	for (const [root, subs] of subdirSets) {
		for (const sub of subs) {
			const full = join(root, sub);
			if (!existsSync(full)) {
				mkdirSync(full, { recursive: true, mode: 0o700 });
				created.push(full);
			}
		}
	}
	tightenPrivateStateDirs(stateDir);

	// Structure only: an existing settings.yaml is never read, validated, or
	// rewritten here. Content validation belongs to readSettings/doctor.
	// Both scaffolds are checked before their lock as well as inside it: the lock is
	// a file beside the target, so taking it for a file that is already there
	// rewrote the config root on every boot, a read-only one included.
	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		withStateFileLockSync(settingsPath, () => {
			if (existsSync(settingsPath)) return;
			safeResourceWrite(settingsPath, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
			created.push(settingsPath);
			touched = true;
		});
	}

	// Settings this call just wrote are in the current shape, so every registered
	// migration is already satisfied. Without this record doctor reports them
	// pending until an upgrade replays no-op migrations over it. A settings file
	// that was already here may predate them and is left to runPending, and so is
	// a manifest the state root still holds from before 0.6.8.
	const migrationsPath = migrationManifestPath();
	if (!settingsExisted) {
		withStateFileLockSync(migrationsPath, () => {
			if (existsSync(migrationsPath) || existsSync(legacyMigrationManifestPath(stateDir))) return;
			safeResourceWrite(migrationsPath, `${JSON.stringify({ applied: [...REGISTERED_MIGRATION_IDS] }, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(migrationsPath, 0o600);
			created.push(migrationsPath);
		});
	}

	const credentialsPath = join(configDir, "credentials.yaml");
	if (!existsSync(credentialsPath)) {
		withStateFileLockSync(credentialsPath, () => {
			if (existsSync(credentialsPath)) return;
			safeResourceWrite(
				credentialsPath,
				"# Managed via `clio-coder auth`. Do not edit manually unless you know what you are doing.\n{}\n",
				{ encoding: "utf8", mode: 0o600 },
			);
			chmodSync(credentialsPath, 0o600);
			created.push(credentialsPath);
		});
	}

	// installedAt is written exactly once, at first install. Any later
	// version/platform/node change preserves it and stamps upgradedAt instead.
	// Multiple Clio processes can boot together, so the read/compare/write is one
	// locked transaction and publication is atomic. Otherwise both first boots
	// can invent different install times, or a stale writer can erase the other
	// process's noticedVersion after an upgrade.
	const installPath = join(stateDir, "home.json");
	const runningVersion = readClioVersion();
	let newerHome: NewerHome | undefined;
	withStateFileLockSync(installPath, () => {
		// Before 0.6.8 this record was install.json, one of three files with that name.
		const legacyPath = join(stateDir, "install.json");
		if (!existsSync(installPath) && existsSync(legacyPath)) renameSync(legacyPath, installPath);
		const installMetadata = readInstallMetadata(installPath);
		// A `-dev` checkout build is not a release, so it never becomes the recorded
		// version of a home it shares with an installed one. Stamping `0.6.0-dev`
		// would make the installed 0.5.9 read an upgrade from a version it never
		// shipped, and doctor, upgrade and the one-time notice all key on this field.
		// A home the dev build creates still records its own version.
		const currentVersion =
			installMetadata !== null && isDevVersion(runningVersion) ? installMetadata.version : runningVersion;
		// An older binary must not restamp a newer home as its own version.
		const newer = installMetadata ? newerHomeOf(installMetadata, runningVersion, stateDir) : null;
		if (newer) {
			newerHome = newer;
			return;
		}
		if (!installMetadata) {
			const payload: InstallMetadata = {
				version: currentVersion,
				// A first install knows when it happened. A repair does not, and saying
				// `installedAt: now` there is a fact this process invented.
				...(preexistingHome ? { repairedAt: new Date().toISOString() } : { installedAt: new Date().toISOString() }),
				platform: process.platform,
				nodeVersion: process.version,
			};
			safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			created.push(installPath);
		} else if (
			installMetadata.version !== currentVersion ||
			installMetadata.platform !== process.platform ||
			installMetadata.nodeVersion !== process.version
		) {
			// A version change is the upgrade the record is about; a node or platform
			// change alone keeps whatever earlier transition was on record.
			const upgradedFrom =
				installMetadata.version !== currentVersion ? installMetadata.version : installMetadata.upgradedFrom;
			const payload: InstallMetadata = {
				version: currentVersion,
				...(installMetadata.installedAt !== undefined ? { installedAt: installMetadata.installedAt } : {}),
				...(installMetadata.repairedAt !== undefined ? { repairedAt: installMetadata.repairedAt } : {}),
				...(upgradedFrom !== undefined ? { upgradedFrom } : {}),
				...(installMetadata.version === currentVersion && installMetadata.downgradedFrom !== undefined
					? { downgradedFrom: installMetadata.downgradedFrom }
					: {}),
				...(installMetadata.noticedVersion !== undefined ? { noticedVersion: installMetadata.noticedVersion } : {}),
				upgradedAt: new Date().toISOString(),
				platform: process.platform,
				nodeVersion: process.version,
			};
			safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		}
		// Upgrade metadata written by earlier releases to the lifecycle file's
		// owner-only contract even when no content changed on this boot.
		chmodSync(installPath, 0o600);
	});

	return {
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		createdPaths: created,
		touchedSettings: touched,
		...(newerHome ? { newerHome } : {}),
	};
}

/** The release triple of a version; a `-dev` or `-rc` suffix is ignored. */
function releaseTriple(version: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerRelease(recorded: string, running: string): boolean {
	const a = releaseTriple(recorded);
	const b = releaseTriple(running);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
	}
	return false;
}

function newerHomeOf(metadata: InstallMetadata, runningVersion: string, stateDir: string): NewerHome | null {
	const newerVersion = isNewerRelease(metadata.version, runningVersion);
	// Once the operator accepted this version on the home, its leftover newer ids no longer ask.
	const unknownMigrations = metadata.downgradedFrom === undefined ? unknownAppliedMigrations(stateDir) : [];
	if (!newerVersion && unknownMigrations.length === 0) return null;
	return { version: metadata.version, unknownMigrations };
}

function unknownAppliedMigrations(stateDir: string): string[] {
	const registered = new Set<string>([...REGISTERED_MIGRATION_IDS, ...RETIRED_MIGRATION_IDS]);
	for (const path of [migrationManifestPath(), legacyMigrationManifestPath(stateDir)]) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { applied?: unknown };
			if (!Array.isArray(parsed.applied)) return [];
			return parsed.applied.filter((id): id is string => typeof id === "string" && !registered.has(id));
		} catch {
			return [];
		}
	}
	return [];
}

/** The newer Clio that last used this home, or null. Reads only; writes nothing. */
export function detectNewerHome(): NewerHome | null {
	const stateDir = resolveClioDirs().state;
	const metadata = readInstallMetadata(join(stateDir, "home.json"));
	return metadata ? newerHomeOf(metadata, readClioVersion(), stateDir) : null;
}

/**
 * The operator accepted running an older Clio on a newer home: record the
 * downgrade so later boots do not ask, and the home is that version's again.
 * `version` defaults to the running one; `upgrade --rollback` passes the
 * version it switched the launcher to, whose binary reads this record.
 */
export function recordHomeDowngrade(version: string = readClioVersion()): void {
	const stateDir = clioStateDir();
	const installPath = join(stateDir, "home.json");
	withStateFileLockSync(installPath, () => {
		const metadata = readInstallMetadata(installPath);
		if (!metadata) return;
		const payload: InstallMetadata = {
			version,
			...(metadata.installedAt !== undefined ? { installedAt: metadata.installedAt } : {}),
			...(metadata.repairedAt !== undefined ? { repairedAt: metadata.repairedAt } : {}),
			downgradedFrom: metadata.version,
			...(metadata.noticedVersion !== undefined ? { noticedVersion: metadata.noticedVersion } : {}),
			platform: process.platform,
			nodeVersion: process.version,
		};
		safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	});
}

function readInstallMetadata(path: string): InstallMetadata | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallMetadata>;
		// Either stamp is enough to call the record ours. Requiring installedAt
		// would make every repaired record look corrupt and get re-synthesized on
		// the next run, moving the repair time forward each time.
		if (
			typeof parsed.version === "string" &&
			(typeof parsed.installedAt === "string" || typeof parsed.repairedAt === "string") &&
			typeof parsed.platform === "string" &&
			typeof parsed.nodeVersion === "string"
		) {
			return {
				version: parsed.version,
				...(typeof parsed.installedAt === "string" ? { installedAt: parsed.installedAt } : {}),
				...(typeof parsed.upgradedAt === "string" ? { upgradedAt: parsed.upgradedAt } : {}),
				...(typeof parsed.repairedAt === "string" ? { repairedAt: parsed.repairedAt } : {}),
				...(typeof parsed.upgradedFrom === "string" ? { upgradedFrom: parsed.upgradedFrom } : {}),
				...(typeof parsed.downgradedFrom === "string" ? { downgradedFrom: parsed.downgradedFrom } : {}),
				...(typeof parsed.noticedVersion === "string" ? { noticedVersion: parsed.noticedVersion } : {}),
				platform: parsed.platform,
				nodeVersion: parsed.nodeVersion,
			};
		}
	} catch {
		// Repaired below by overwriting home.json with current metadata.
	}
	return null;
}

/**
 * Opt-in safety check that prevents tests from clobbering a parent process's
 * sandbox when the parent has CLIO_CODER_CONFIG_DIR/CLIO_CODER_DATA_DIR/CLIO_CODER_STATE_DIR/
 * CLIO_CODER_CACHE_DIR set and the test only overrides CLIO_CODER_HOME. Individual env
 * vars take precedence over CLIO_CODER_HOME inside resolveClioDirs, so a test that
 * forgets to override all five will silently inherit the parent's paths and
 * write into the wrong sandbox.
 *
 * Enable by setting CLIO_CODER_REQUIRE_HOME_PREFIX=1 in the test env. The test
 * harness in tests/harness/spawn.ts opts in by default. We deliberately do
 * not enable this in production because dev installs may legitimately point
 * individual dirs outside CLIO_CODER_HOME.
 */
function enforceHomePrefixGuard(): void {
	if (process.env.CLIO_CODER_REQUIRE_HOME_PREFIX !== "1") return;
	const home = process.env.CLIO_CODER_HOME?.trim();
	if (!home) return;
	const dirs = resolveClioDirs();
	const offenders: string[] = [];
	if (!dirs.config.startsWith(home)) offenders.push(`configDir=${dirs.config}`);
	if (!dirs.data.startsWith(home)) offenders.push(`dataDir=${dirs.data}`);
	if (!dirs.state.startsWith(home)) offenders.push(`stateDir=${dirs.state}`);
	if (!dirs.cache.startsWith(home)) offenders.push(`cacheDir=${dirs.cache}`);
	if (offenders.length === 0) return;
	throw new Error(
		`CLIO_CODER_REQUIRE_HOME_PREFIX guardrail tripped: resolved Clio directories escape CLIO_CODER_HOME=${home}. ` +
			`Offending paths: ${offenders.join(", ")}. ` +
			`Individual overrides CLIO_CODER_CONFIG_DIR, CLIO_CODER_DATA_DIR, CLIO_CODER_STATE_DIR, and CLIO_CODER_CACHE_DIR take precedence ` +
			`over CLIO_CODER_HOME, so a test that sets only CLIO_CODER_HOME inherits whatever the parent process configured. ` +
			`Override all five env vars in lockstep to scratch subdirs (CLIO_CODER_HOME plus CLIO_CODER_CONFIG_DIR, ` +
			`CLIO_CODER_DATA_DIR, CLIO_CODER_STATE_DIR, CLIO_CODER_CACHE_DIR pointing under it), then call resetXdgCache().`,
	);
}
