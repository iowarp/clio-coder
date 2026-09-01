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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lmStudioRuntimeId from "./2026-08-18-lmstudio-runtime-id.js";
import retirePanesKnobs from "./2026-09-01-retire-panes-knobs.js";

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

// `retirePanesKnobs` first, per requirement 3: it strips keys the strict reader
// refuses, and `lmStudioRuntimeId` calls `readSettings` and would throw on the
// same document before the repair ever ran.
const REGISTRY: ReadonlyArray<Migration> = Object.freeze([retirePanesKnobs, lmStudioRuntimeId]);

export function listMigrations(): ReadonlyArray<Migration> {
	return REGISTRY;
}

function manifestPath(stateDir: string): string {
	return join(stateDir, "migrations.json");
}

function readManifest(path: string): MigrationManifest {
	if (!existsSync(path)) return { applied: [] };
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as { applied?: unknown }).applied)) {
			const ids = (parsed as { applied: unknown[] }).applied.filter((v): v is string => typeof v === "string");
			return { applied: ids };
		}
	} catch {
		// fall through; treat unreadable manifest as empty
	}
	return { applied: [] };
}

function writeManifest(path: string, manifest: MigrationManifest): void {
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
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
	mkdirSync(stateDir, { recursive: true });
	const path = manifestPath(stateDir);
	const manifest = readManifest(path);
	const applied = new Set(manifest.applied);
	const newlyApplied: string[] = [];
	// The manifest is written after each `up()` rather than once at the end. A
	// throw from a later migration used to discard the record of the earlier ones
	// that had already succeeded, so they re-ran on the next upgrade against a
	// tree they had already changed. That breaks the at-most-once guarantee this
	// module's contract states.
	for (const m of migrations) {
		if (applied.has(m.id)) continue;
		await m.up(stateDir);
		applied.add(m.id);
		newlyApplied.push(m.id);
		writeManifest(path, { applied: [...applied] });
	}
	const allApplied = [...applied];
	// Nothing pending still rewrites the manifest, so a home whose file was
	// missing or unparseable gains a well-formed one.
	writeManifest(path, { applied: allApplied });
	return {
		applied: newlyApplied,
		allApplied,
		available: migrations.map((m) => m.id),
	};
}
