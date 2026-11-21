import { clioDataDir } from "../../../core/xdg.js";
import { upgradeMemoryStore } from "../../memory/store-upgrade.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Rewrites the memory store into the one shape the store reads (`upgradeMemoryStore`): version 2, claims stored,
 * deliveries counted, every verdict scoped to a revision and every evidence ref in its current form. The store had
 * read each older shape at runtime.
 */
const migration: Migration = {
	id: "2026-11-21-memory-store-v2",
	async up(): Promise<MigrationReport> {
		return upgradeMemoryStore(clioDataDir());
	},
};

export default migration;
