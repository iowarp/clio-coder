import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Migration } from "./index.js";

/**
 * First-ever Clio state migration. No-op beyond ensuring `<dir>/state/` exists,
 * which validates the migration scaffolding end-to-end. Later migrations can
 * assume the state directory is there.
 */
const migration: Migration = {
	id: "2026-04-17-initial",
	async up(dir: string): Promise<void> {
		mkdirSync(join(dir, "state"), { recursive: true });
	},
};

export default migration;
