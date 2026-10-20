import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";

export const MIGRATION_NOTICES_FILE = "migration-notices.json";

interface MigrationNotice {
	id: string;
	changed: string[];
	attention: string[];
}

export function readMigrationNotices(stateDir: string): MigrationNotice[] {
	try {
		const parsed = JSON.parse(readFileSync(join(stateDir, MIGRATION_NOTICES_FILE), "utf8")) as {
			notices?: unknown;
		} | null;
		if (!Array.isArray(parsed?.notices)) return [];
		const entries: MigrationNotice[] = [];
		for (const entry of parsed.notices) {
			if (
				entry === null ||
				typeof entry !== "object" ||
				typeof entry.id !== "string" ||
				!Array.isArray(entry.changed) ||
				!entry.changed.every((line: unknown) => typeof line === "string") ||
				!Array.isArray(entry.attention) ||
				!entry.attention.every((line: unknown) => typeof line === "string")
			)
				return [];
			entries.push({ id: entry.id, changed: entry.changed, attention: entry.attention });
		}
		return entries;
	} catch {
		return [];
	}
}

export function appendMigrationNotice(stateDir: string, entry: MigrationNotice): void {
	const notices = readMigrationNotices(stateDir);
	notices.push(entry);
	safeResourceWrite(join(stateDir, MIGRATION_NOTICES_FILE), `${JSON.stringify({ notices })}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}
