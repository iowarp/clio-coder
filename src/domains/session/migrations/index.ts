/**
 * Strict session-format version reader.
 *
 * Runs before every session resume. Earlier pre-1.0 formats are disposable
 * local state and must not be transformed into the current format. A version
 * from the future is refused for the opposite reason: the file is not
 * disposable, it belongs to a newer Clio, and this build would silently drop
 * whatever that build understood and this one does not. Downgrading and
 * resuming would then write the truncated reading back over the original.
 *
 * Version 3 to 4 is the one additive step: 4 only adds the working-set kinds
 * (`contextEviction`, `contextRecall`), so a version-3 ledger is read as-is
 * and the metadata is restamped. Nothing in the file changes.
 */

import { CURRENT_SESSION_FORMAT_VERSION } from "../../../engine/session.js";
import type { SessionMeta } from "../contract.js";

export { CURRENT_SESSION_FORMAT_VERSION };

/** Oldest version this build reads without transforming the ledger. */
export const OLDEST_READABLE_SESSION_FORMAT_VERSION = 3;

export interface MigrationResult {
	migrated: boolean;
	from: number;
	to: number;
}

export function runMigrations(meta: SessionMeta, sessionPath: string): MigrationResult {
	const from = meta.sessionFormatVersion ?? 1;
	if (from < OLDEST_READABLE_SESSION_FORMAT_VERSION) {
		throw new Error(
			`session metadata has an unsupported format version (expected version ${CURRENT_SESSION_FORMAT_VERSION}, got ${from}): ${sessionPath}. Remove the session directory to start a new session.`,
		);
	}
	if (from > CURRENT_SESSION_FORMAT_VERSION) {
		throw new Error(
			`session was written by a newer Clio (format version ${from}, this build reads version ${CURRENT_SESSION_FORMAT_VERSION}): ${sessionPath}. Upgrade clio-coder to resume this session.`,
		);
	}
	if (from < CURRENT_SESSION_FORMAT_VERSION) {
		return { migrated: true, from, to: CURRENT_SESSION_FORMAT_VERSION };
	}
	return { migrated: false, from, to: from };
}
