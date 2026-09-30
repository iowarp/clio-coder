/**
 * Clio Coder state migration runner.
 *
 * A migration is a versioned state-shape change keyed by a stable id of the
 * form `YYYY-MM-DD-<slug>`. The registry is a static, ordered list compiled
 * into the bundle so the runtime never scans the filesystem for migration
 * files. To add a migration, author `YYYY-MM-DD-<slug>.ts` with a default
 * export matching the `Migration` contract and register it below.
 *
 * Applied migration ids are persisted to `<stateDir>/migrations.json`. A
 * migration whose id already appears in that manifest is skipped. `up()` is
 * invoked at most once per Clio Coder state tree for a given id.
 *
 * The registry ships empty pre-launch. Requirements for future migrations:
 *
 * 1. A migration that writes settings.yaml must hold the settings
 *    single-writer lock (`withSettingsLock` in core/config.ts) around its
 *    read-rewrite-write so it can never race `updateSettings`, and should
 *    land the write through the atomic rename writer
 *    (core/safe-resource-write.ts) so readers never see a partial file.
 * 2. Migrations are authored against the shapes the code has on the day they
 *    are needed, never against stale pre-release shapes.
 * 3. A migration that repairs settings.yaml into a shape the strict reader
 *    accepts runs before any migration that reads settings through
 *    `readSettings`, because that reader throws on the very document the
 *    repair exists to fix. The registry order below is that order, and it is
 *    deliberately not the id order: ids are stable identifiers, and the
 *    manifest replays by id membership rather than by position, so a home that
 *    already applied one of these is unaffected by where the other sits.
 */

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import retirePanesKnobs from "./2026-09-01-retire-panes-knobs.js";
import settingsV2 from "./2026-09-01-settings-v2.js";
import { REGISTERED_MIGRATION_IDS } from "./registry-ids.js";

export interface Migration {
	id: string;
	up(stateDir: string): Promise<void>;
}

export interface MigrationManifest {
	applied: string[];
}

export interface MigrationRunResult {
	/** ids newly applied on this invocation (in order). */
	applied: string[];
	/** every id recorded in the manifest after this invocation. */
	allApplied: string[];
	/** full migration inventory ordered by id. */
	available: string[];
}

export interface MigrationManifestRead {
	manifest: MigrationManifest;
	/** Absent is healthy; a present manifest that cannot be trusted is not. */
	problem: string | null;
}

const MIGRATION_MANIFEST_MAX_BYTES = 1024 * 1024;

// Settings v2 owns the complete v1 rewrite, including the already-retired pane
// keys, and must run before any later migration reaches the strict v2 reader.
// `retirePanesKnobs` remains registered for homes that already recorded the v2
// migration independently and for manifest continuity; it is a no-op on v2.
//
// The naming migration (`2026-09-01-clio-coder-naming`) and the runtime-id
// migrations (`2026-08-18-lmstudio-runtime-id`, `2026-09-18-ollama-runtime-id`)
// were retired with the legacy naming layer. Homes that recorded their ids keep
// them in the manifest; an id with no registered migration is inert.
const REGISTRY: ReadonlyArray<Migration> = Object.freeze([settingsV2, retirePanesKnobs]);

// A fresh home records REGISTERED_MIGRATION_IDS as already applied. An id
// registered here but missing there would be recorded for no home, and one
// listed there but not here would be recorded as run when it never can be.
if (
	REGISTRY.length !== REGISTERED_MIGRATION_IDS.length ||
	REGISTRY.some((migration, index) => migration.id !== REGISTERED_MIGRATION_IDS[index])
) {
	throw new Error("lifecycle migrations: registry-ids.ts does not match the migration registry");
}

export function listMigrations(): ReadonlyArray<Migration> {
	return REGISTRY;
}

export function readMigrationManifestResult(stateDir: string): MigrationManifestRead {
	return readManifest(manifestPath(stateDir));
}

function manifestPath(stateDir: string): string {
	return join(stateDir, "migrations.json");
}

function readManifest(path: string): MigrationManifestRead {
	if (!existsSync(path)) return { manifest: { applied: [] }, problem: null };
	try {
		if (statSync(path).size > MIGRATION_MANIFEST_MAX_BYTES) {
			return {
				manifest: { applied: [] },
				problem: `${path} is larger than ${MIGRATION_MANIFEST_MAX_BYTES} bytes; refusing to replay migrations`,
			};
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root is not an object");
		const keys = Object.keys(parsed as Record<string, unknown>);
		if (keys.some((key) => key !== "applied")) throw new Error("contains unknown fields");
		const applied = (parsed as { applied?: unknown }).applied;
		if (!Array.isArray(applied) || applied.some((value) => typeof value !== "string" || value.length === 0))
			throw new Error("applied must be an array of non-empty migration ids");
		if (new Set(applied).size !== applied.length) throw new Error("applied contains duplicate migration ids");
		return { manifest: { applied: applied as string[] }, problem: null };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			manifest: { applied: [] },
			problem:
				`${path} cannot be trusted: ${detail}. No migration was replayed. ` +
				"Restore this machine-produced file from backup, or move it aside after reviewing which migrations already changed user data.",
		};
	}
}

function writeManifest(path: string, manifest: MigrationManifest): void {
	safeResourceWrite(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

/**
 * Apply every registered migration this state tree has not recorded yet.
 *
 * `migrations` defaults to the compiled registry and exists so the ordering
 * guarantee below can be exercised against a failing migration; production
 * callers pass one argument.
 */
export async function runPending(
	stateDir: string,
	migrations: ReadonlyArray<Migration> = REGISTRY,
): Promise<MigrationRunResult> {
	const path = manifestPath(stateDir);
	return withStateFileLock(path, async () => {
		const read = readManifest(path);
		if (read.problem !== null) throw new Error(read.problem);
		const applied = new Set(read.manifest.applied);
		const newlyApplied: string[] = [];
		// The manifest is written after each `up()` rather than once at the end. A
		// throw from a later migration used to discard the record of the earlier ones
		// that had already succeeded, so they re-ran on the next upgrade against a
		// tree they had already changed. That breaks the at-most-once guarantee this
		// module's contract states.
		for (const migration of migrations) {
			if (applied.has(migration.id)) continue;
			await migration.up(stateDir);
			applied.add(migration.id);
			newlyApplied.push(migration.id);
			writeManifest(path, { applied: [...applied] });
		}
		const allApplied = [...applied];
		// Nothing pending still writes a manifest, so a fresh home gains an
		// explicit record. A malformed present file is refused above and is never
		// silently replaced with an empty history.
		writeManifest(path, { applied: allApplied });
		return {
			applied: newlyApplied,
			allApplied,
			available: migrations.map((migration) => migration.id),
		};
	});
}
