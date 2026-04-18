/**
 * Session cwd fallback resolver (Phase 12 slice 12d).
 *
 * Pure guard used by the interactive layer when a session is resumed.
 * `meta.cwd` is captured at session creation time; by the time the user
 * runs `/resume`, that directory may no longer exist (repo deleted,
 * external drive unmounted, user renamed the project directory). This
 * helper answers "is the recorded cwd still usable?" without touching
 * clio's orchestrator or the TUI; the caller pops `cwd-fallback` overlay
 * on a negative answer.
 *
 * Injectable `fsProbe` so the unit tests under tests/unit/cwd-fallback.test.ts
 * can cover every branch without touching the real filesystem.
 */

import { existsSync, statSync } from "node:fs";

/**
 * Minimal filesystem surface `resolveSessionCwd` consults. Production
 * callers use `defaultFsProbe`; tests inject a deterministic stub.
 */
export interface FsProbe {
	exists(path: string): boolean;
	isDirectory(path: string): boolean;
}

export const defaultFsProbe: FsProbe = {
	exists: (p) => existsSync(p),
	isDirectory: (p) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	},
};

/**
 * Discriminated result the overlay layer branches on.
 *   - `no-cwd`: the meta record has no cwd field or it is blank after
 *     trimming. Pre-Phase-12 sessions occasionally land here.
 *   - `missing`: cwd string is set but the directory does not exist on
 *     disk (fsProbe.exists returned false).
 *   - `not-a-directory`: the path exists but resolves to a file or a
 *     symlink target that is not a directory.
 */
export type ResolveSessionCwdResult =
	| { ok: true; cwd: string }
	| { ok: false; reason: "no-cwd" | "missing" | "not-a-directory" };

/**
 * Check whether a resumed session's recorded cwd still points at a live
 * directory on disk. Returns `{ok: true, cwd}` when the path resolves and
 * is a directory; a typed reason otherwise. No side effects — callers
 * persist nothing here; they decide how to react based on the reason.
 */
export function resolveSessionCwd(
	meta: { cwd?: string | null },
	fsProbe: FsProbe = defaultFsProbe,
): ResolveSessionCwdResult {
	const raw = typeof meta.cwd === "string" ? meta.cwd.trim() : "";
	if (raw.length === 0) return { ok: false, reason: "no-cwd" };
	if (!fsProbe.exists(raw)) return { ok: false, reason: "missing" };
	if (!fsProbe.isDirectory(raw)) return { ok: false, reason: "not-a-directory" };
	return { ok: true, cwd: raw };
}
