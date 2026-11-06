/**
 * Where the Copilot runtime keeps a session's own records (events, workspace, checkpoints).
 *
 * The SDK's `mode: "empty"` requires an explicit persistence location: `baseDirectory` or `sessionFs`.
 * `baseDirectory` would set `COPILOT_HOME` for the runtime, which is also where the official
 * `copilot login` keeps its sign-in, so it would hide the very login Clio is meant to use. `sessionFs`
 * redirects only session-scoped files, so the login stays where `copilot login` put it while session
 * records land under Clio's own cache root: `<cache>/copilot-sdk/sessions/<session id>/`, per OS user,
 * removed when Clio closes the conversation.
 *
 * Every runtime path is treated as a virtual POSIX path inside that one directory: `..` cannot climb out,
 * and an absolute path such as the project directory maps to a mirror inside it, never the real file.
 */

import { rmSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { SessionFsConfig, SessionFsProvider } from "@github/copilot-sdk";
import { clioCacheDir } from "../../core/xdg.js";

/** The virtual directory, inside each session's filesystem, that holds its records. */
const SESSION_STATE_PATH = "/copilot-session";

function copilotSessionsRoot(): string {
	return join(clioCacheDir(), "copilot-sdk", "sessions");
}

export function copilotSessionFsConfig(): SessionFsConfig {
	return { initialCwd: "/", sessionStatePath: SESSION_STATE_PATH, conventions: "posix" };
}

function sessionRoot(sessionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error(`invalid Copilot session id: ${sessionId}`);
	return join(copilotSessionsRoot(), sessionId);
}

/** At process exit only synchronous work runs; this removes what a still-open conversation wrote. */
export function removeCopilotSessionRecordsSync(sessionId: string): void {
	rmSync(sessionRoot(sessionId), { recursive: true, force: true });
}

/** A session's own directory, removed with its conversation. */
export async function removeCopilotSessionRecords(sessionId: string): Promise<void> {
	await rm(sessionRoot(sessionId), { recursive: true, force: true });
}

export function createCopilotSessionFs(sessionId: string): SessionFsProvider {
	const root = sessionRoot(sessionId);
	const resolve = (path: string): string => {
		// normalize("/" + p) cannot leave "/", so the joined path stays under root.
		const relative = posix.normalize(`/${path.replaceAll("\\", "/")}`).slice(1);
		return relative.length === 0 ? root : join(root, ...relative.split("/"));
	};
	const parentOf = async (path: string) => {
		await mkdir(join(resolve(path), ".."), { recursive: true });
	};
	return {
		readFile: (path) => readFile(resolve(path), "utf8"),
		async writeFile(path, content, mode) {
			await parentOf(path);
			await writeFile(resolve(path), content, mode !== undefined ? { mode } : {});
		},
		async appendFile(path, content, mode) {
			await parentOf(path);
			await appendFile(resolve(path), content, mode !== undefined ? { mode } : {});
		},
		async exists(path) {
			try {
				await stat(resolve(path));
				return true;
			} catch {
				// Any stat failure reads as absent, which is what the runtime asks.
				return false;
			}
		},
		async stat(path) {
			const info = await stat(resolve(path));
			return {
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				size: info.size,
				mtime: info.mtime.toISOString(),
				birthtime: info.birthtime.toISOString(),
			};
		},
		async mkdir(path, recursive, mode) {
			await mkdir(resolve(path), { recursive, ...(mode !== undefined ? { mode } : {}) });
		},
		readdir: (path) => readdir(resolve(path)),
		async readdirWithTypes(path) {
			const entries = await readdir(resolve(path), { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
		},
		async rm(path, recursive, force) {
			await rm(resolve(path), { recursive, force });
		},
		async rename(src, dest) {
			await parentOf(dest);
			await rename(resolve(src), resolve(dest));
		},
	};
}
