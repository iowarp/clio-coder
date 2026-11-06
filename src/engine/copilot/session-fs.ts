/**
 * The session filesystem the Copilot runtime sees, under the SDK's `sessionFs` contract.
 *
 * The SDK's `mode: "empty"` requires an explicit persistence location: `baseDirectory` or `sessionFs`.
 * `baseDirectory` would set `COPILOT_HOME` for the runtime, which is also where the official
 * `copilot login` keeps its sign-in, so it would hide the very login Clio is meant to use.
 *
 * With `sessionFs`, the runtime routes every session file operation through this provider: its own records
 * under `sessionStatePath`, and the workspace namespace rooted at `initialCwd` (the runtime stats the
 * session's working directory there while creating a session). Paths keep their real absolute form; the
 * provider decides by where they point:
 *
 * - Session state: `sessionStatePath` is `<cache>/copilot-sdk/state`, which nothing on disk uses. A path
 *   under it lands in this session's own directory, `<cache>/copilot-sdk/sessions/<session id>/`, per OS
 *   user, removed when Clio closes the conversation; `..` cannot leave it.
 * - Everything else is the user's real filesystem, served read-only. Copilot's built-in tools are disabled
 *   and every change to the workspace goes through Clio's own tools and permission policy, so a write,
 *   mkdir, rename or rm there is refused.
 */

import { rmSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type { SessionFsConfig, SessionFsProvider } from "@github/copilot-sdk";
import { clioCacheDir } from "../../core/xdg.js";

function copilotSdkCacheDir(): string {
	return join(clioCacheDir(), "copilot-sdk");
}

/** Where each session's state appears in the runtime's namespace; mapped per session, never written as is. */
function sessionStateBase(): string {
	return join(copilotSdkCacheDir(), "state");
}

export function copilotSessionFsConfig(cwd = process.cwd()): SessionFsConfig {
	return {
		initialCwd: resolvePath(cwd),
		sessionStatePath: sessionStateBase(),
		conventions: process.platform === "win32" ? "windows" : "posix",
	};
}

function sessionRoot(sessionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error(`invalid Copilot session id: ${sessionId}`);
	return join(copilotSdkCacheDir(), "sessions", sessionId);
}

/** At process exit only synchronous work runs; this removes what a still-open conversation wrote. */
export function removeCopilotSessionRecordsSync(sessionId: string): void {
	rmSync(sessionRoot(sessionId), { recursive: true, force: true });
}

/** A session's own directory, removed with its conversation. */
export async function removeCopilotSessionRecords(sessionId: string): Promise<void> {
	await rm(sessionRoot(sessionId), { recursive: true, force: true });
}

function refuseWorkspaceWrite(path: string): never {
	throw new Error(
		`Clio does not let the Copilot runtime change ${path}; workspace changes go through Clio's own tools.`,
	);
}

export function createCopilotSessionFs(sessionId: string): SessionFsProvider {
	const root = sessionRoot(sessionId);
	const base = sessionStateBase();
	/** The on-disk path for a runtime path, and whether it is this session's own state. */
	const locate = (path: string): { real: string; state: boolean } => {
		const absolute = resolvePath(path);
		const inside = relative(base, absolute);
		if (inside === "") return { real: root, state: true };
		if (!inside.startsWith("..") && !isAbsolute(inside)) return { real: join(root, inside), state: true };
		return { real: absolute, state: false };
	};
	const writable = (path: string): string => {
		const target = locate(path);
		return target.state ? target.real : refuseWorkspaceWrite(path);
	};
	const parentOf = async (real: string) => {
		await mkdir(dirname(real), { recursive: true });
	};
	return {
		readFile: (path) => readFile(locate(path).real, "utf8"),
		async writeFile(path, content, mode) {
			const real = writable(path);
			await parentOf(real);
			await writeFile(real, content, mode !== undefined ? { mode } : {});
		},
		async appendFile(path, content, mode) {
			const real = writable(path);
			await parentOf(real);
			await appendFile(real, content, mode !== undefined ? { mode } : {});
		},
		async exists(path) {
			try {
				await stat(locate(path).real);
				return true;
			} catch {
				// Any stat failure reads as absent, which is what the runtime asks.
				return false;
			}
		},
		async stat(path) {
			const info = await stat(locate(path).real);
			return {
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				size: info.size,
				mtime: info.mtime.toISOString(),
				birthtime: info.birthtime.toISOString(),
			};
		},
		async mkdir(path, recursive, mode) {
			await mkdir(writable(path), { recursive, ...(mode !== undefined ? { mode } : {}) });
		},
		readdir: (path) => readdir(locate(path).real),
		async readdirWithTypes(path) {
			const entries = await readdir(locate(path).real, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
		},
		async rm(path, recursive, force) {
			await rm(writable(path), { recursive, force });
		},
		async rename(src, dest) {
			const from = writable(src);
			const to = writable(dest);
			await parentOf(to);
			await rename(from, to);
		},
	};
}
