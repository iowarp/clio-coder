import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { workspaceTrustDirectory } from "../../../core/workspace-trust.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Project approvals moved from the state root to the config root, beside
 * `mcp-trust.json`. They are operator decisions rather than disposable state, so
 * `reset --state` no longer costs every project its approvals. A record already
 * at the destination is newer and stays. Copied, not renamed, because the two
 * roots can sit on different filesystems.
 */
const migration: Migration = {
	id: "2026-11-02-approvals-to-config",
	async up(stateDir: string): Promise<MigrationReport | undefined> {
		const from = join(stateDir, "workspace-trust");
		let names: string[];
		try {
			names = readdirSync(from).filter((name) => name.endsWith(".json"));
		} catch {
			// No approvals were ever recorded on this home.
			return undefined;
		}
		const to = workspaceTrustDirectory();
		for (const name of names) {
			const target = join(to, name);
			if (!existsSync(target)) safeResourceWrite(target, readFileSync(join(from, name), "utf8"), { mode: 0o600 });
		}
		rmSync(from, { recursive: true, force: true });
		return names.length === 0
			? undefined
			: { changed: [`moved ${names.length} project approval record(s) to ${to}.`], attention: [] };
	},
};

export default migration;
