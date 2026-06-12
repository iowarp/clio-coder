import { mkdirSync } from "node:fs";
import type { Migration } from "./index.js";

/**
 * First-ever Clio Coder state migration. No-op beyond ensuring the state root
 * exists, which validates the migration scaffolding end-to-end. Later
 * migrations can assume the state directory is there.
 */
const migration: Migration = {
	id: "2026-04-17-initial",
	async up(stateDir: string): Promise<void> {
		mkdirSync(stateDir, { recursive: true });
	},
};

export default migration;
