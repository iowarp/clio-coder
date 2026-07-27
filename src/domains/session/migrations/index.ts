/**
 * Strict session-format version reader.
 *
 * Runs before every session resume. Earlier pre-1.0 formats are disposable
 * local state and must not be transformed into the current format.
 */

import { CURRENT_SESSION_FORMAT_VERSION } from "../../../engine/session.js";
import type { SessionMeta } from "../contract.js";

export { CURRENT_SESSION_FORMAT_VERSION };

export interface MigrationResult {
	migrated: boolean;
	from: number;
	to: number;
}

export function runMigrations(meta: SessionMeta, sessionPath: string): MigrationResult {
	const from = meta.sessionFormatVersion ?? 1;
	if (from < CURRENT_SESSION_FORMAT_VERSION) {
		throw new Error(
			`session metadata has an unsupported format version (expected version 3, got ${from}): ${sessionPath}. Remove the session directory to start a new session.`,
		);
	}
	return { migrated: false, from, to: from };
}
