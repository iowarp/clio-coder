import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import type { MigrationReport } from "./migrations/index.js";
import { REGISTERED_MIGRATION_IDS } from "./migrations/registry-ids.js";

/**
 * A background update installs the new package with `--no-post-install`, so the
 * first launch of the new version meets state the previous release wrote and no
 * `clio-coder upgrade` has run. Boot applies the pending migrations once, under
 * the migration runner's own lock, and keeps what they report for the notice the
 * session shows. A fresh home never lands here: initialization records every
 * registered migration as applied.
 */
let notices: string[] = [];

export function describeMigrationReport(id: string, report: MigrationReport): string {
	const parts = [`Applied migration ${id}.`, ...report.changed];
	if (report.attention.length > 0) parts.push(`Needs you: ${report.attention.join(" ")}`);
	return parts.join(" ");
}

export async function applyPendingMigrationsAtBoot(): Promise<void> {
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
			if (report && (report.changed.length > 0 || report.attention.length > 0))
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
