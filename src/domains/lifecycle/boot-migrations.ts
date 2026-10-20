import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import type { MigrationReport } from "./migrations/index.js";
import { MIGRATION_NOTICES_FILE, readMigrationNotices } from "./migrations/notices.js";
import { REGISTERED_MIGRATION_IDS } from "./migrations/registry-ids.js";

/**
 * A background update installs the new package with `--no-post-install`, so the
 * first launch of the new version meets state the previous release wrote and no
 * `clio-coder upgrade` has run. Boot applies the pending migrations once, under
 * the migration runner's own lock. Reports persist until an interactive launch
 * claims them. A fresh home never lands here: initialization records every
 * registered migration as applied.
 */
let notices: string[] = [];

function describeMigrationReport(id: string, report: MigrationReport): string {
	// "changed" keeps the footer notice until it is read; see describeConversion.
	const parts = [`Applied migration ${id}; changed:`, ...report.changed];
	if (report.attention.length > 0) parts.push(`Left unchanged, needs you: ${report.attention.join(" ")}`);
	return parts.join(" ");
}

export function takePendingMigrationNotices(): string[] {
	const stateDir = clioStateDir();
	const path = join(stateDir, MIGRATION_NOTICES_FILE);
	if (!existsSync(path)) return [];
	try {
		// Share the writer's migrations.json lock so a claim cannot erase a new report.
		// A second interactive boot must never stall; after 50 ms the other process claims it.
		return withStateFileLockSync(
			join(stateDir, "migrations.json"),
			() => {
				if (!existsSync(path)) return [];
				const pending = readMigrationNotices(stateDir);
				unlinkSync(path);
				return pending.map((entry) => describeMigrationReport(entry.id, entry));
			},
			{ timeoutMs: 50 },
		);
	} catch {
		return [];
	}
}

export async function applyPendingMigrationsAtBoot(
	interactive = process.env.CLIO_CODER_INTERACTIVE === "1",
): Promise<void> {
	const stateDir = clioStateDir();
	const manifest = join(stateDir, "migrations.json");
	if (!existsSync(manifest)) return;
	try {
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { applied?: unknown };
		if (
			Array.isArray(parsed.applied) &&
			REGISTERED_MIGRATION_IDS.every((id) => (parsed.applied as unknown[]).includes(id))
		)
			return;
	} catch {
		// An unreadable manifest falls through to the runner, which refuses it by name.
	}
	try {
		const { runPending } = await import("./migrations/index.js");
		const result = await runPending(stateDir);
		for (const id of result.applied) {
			const report = result.reports?.[id];
			if (!interactive && report && (report.changed.length > 0 || report.attention.length > 0))
				notices.push(describeMigrationReport(id, report));
		}
	} catch (error) {
		notices.push(
			`Pending migrations did not run (${error instanceof Error ? error.message : String(error)}). Run: clio-coder upgrade --post-install`,
		);
	}
}

/** What the boot migrations reported, handed over once. */
export function takeBootMigrationNotices(): string[] {
	const taken = notices;
	notices = [];
	return taken;
}
