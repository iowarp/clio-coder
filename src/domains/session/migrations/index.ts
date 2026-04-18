/**
 * Session-format migration chain (Phase 12 slice 12a).
 *
 * Runs on every session read via manager.resumeSessionState. Each migrator
 * mutates SessionMeta in place; the chain stops at CURRENT_SESSION_FORMAT_VERSION.
 * Migrations are idempotent: a freshly-created v2 session that passes through
 * here again is a no-op.
 *
 * To add a future v2→v3 migration: create v2-to-v3.ts, import it here, and
 * extend the switch in runMigrations. Bump CURRENT_SESSION_FORMAT_VERSION
 * to the new ceiling.
 */

import type { SessionMeta } from "../contract.js";
import { migrateV1ToV2 } from "./v1-to-v2.js";

export const CURRENT_SESSION_FORMAT_VERSION = 2;

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
	return { migrated: true, from, to: CURRENT_SESSION_FORMAT_VERSION };
}
