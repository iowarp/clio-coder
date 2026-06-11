/**
 * Session-format migration chain.
 *
 * Runs on every session read via manager.resumeSessionState. Each migrator
 * mutates SessionMeta in place; the chain stops at CURRENT_SESSION_FORMAT_VERSION.
 * Migrations are idempotent: a freshly-created session that passes through
 * here again is a no-op.
 *
 * To add a future v3→v4 migration: create v3-to-v4.ts, import it here, and
 * extend the switch in runMigrations. Bump CURRENT_SESSION_FORMAT_VERSION
 * in src/engine/session.ts to the new ceiling.
 */

import { CURRENT_SESSION_FORMAT_VERSION } from "../../../engine/session.js";
import type { SessionMeta } from "../contract.js";
import { migrateV1ToV2 } from "./v1-to-v2.js";
import { migrateV2ToV3 } from "./v2-to-v3.js";

export { stripV2PromptArtifacts } from "./v2-to-v3.js";
export { CURRENT_SESSION_FORMAT_VERSION };

export interface MigrationResult {
	migrated: boolean;
	from: number;
	to: number;
}

export function runMigrations(meta: SessionMeta): MigrationResult {
	const from = meta.sessionFormatVersion ?? 1;
	if (from >= CURRENT_SESSION_FORMAT_VERSION) {
		return { migrated: false, from, to: from };
	}
	if (from < 2) migrateV1ToV2(meta);
	if (from < 3) migrateV2ToV3(meta);
	return { migrated: true, from, to: CURRENT_SESSION_FORMAT_VERSION };
}
