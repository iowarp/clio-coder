/**
 * Clio state migration runner.
 *
 * A migration is a versioned state-shape change keyed by a stable id of the
 * form `YYYY-MM-DD-<slug>`. The registry is a static, ordered list compiled
 * into the bundle so the runtime never scans the filesystem for migration
 * files. To add a migration, author `YYYY-MM-DD-<slug>.ts` with a default
 * export matching the `Migration` contract and register it below.
 *
 * Applied migration ids are persisted to `<dir>/state/migrations.json`. A
 * migration whose id already appears in that manifest is skipped. `up()` is
 * invoked at most once per Clio state tree for a given id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initialMigration from "./2026-04-17-initial.js";

export interface Migration {
	id: string;
	up(dir: string): Promise<void>;
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

const REGISTRY: ReadonlyArray<Migration> = Object.freeze([initialMigration]);

export function listMigrations(): ReadonlyArray<Migration> {
	return REGISTRY;
}

function manifestPath(dir: string): string {
	return join(dir, "state", "migrations.json");
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

export async function runPending(dir: string): Promise<MigrationRunResult> {
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { recursive: true });
	const path = manifestPath(dir);
	const manifest = readManifest(path);
	const applied = new Set(manifest.applied);
	const newlyApplied: string[] = [];
	for (const m of REGISTRY) {
		if (applied.has(m.id)) continue;
		await m.up(dir);
		applied.add(m.id);
		newlyApplied.push(m.id);
	}
	const allApplied = [...applied];
	writeManifest(path, { applied: allApplied });
	return {
		applied: newlyApplied,
		allApplied,
		available: REGISTRY.map((m) => m.id),
	};
}
