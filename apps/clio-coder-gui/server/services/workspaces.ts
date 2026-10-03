import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type PathCompletion, Workspace, type WorkspacePick } from "../../contracts/sessions.js";
import { runFolderPicker } from "../process-policy.js";
import type { AppFiles } from "../state/files.js";
import type { WorkerHost } from "../worker/host.js";
import { completePath, detectPathHost, type PathHost, toServerPath } from "./path-complete.js";
import { AppProblem } from "./problem.js";

const Workspaces = Type.Array(Workspace);
const LedgerWorkspaces = Type.Array(
	Type.Object({ cwd: Type.String({ maxLength: 4096 }), lastActivityAt: Type.String() }, { additionalProperties: true }),
);
const RECENT_LIMIT = 40;
const workspaceId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);
/**
 * A workspace is a canonical directory, the same identity the terminal interface and the session ledger use.
 * The recents file only remembers what this app opened; the ledger remembers every project any interface
 * ran in, so both feed the list and a project started in the terminal is already here.
 */
export class WorkspaceService {
	private picking = false;
	private host: PathHost | null = null;
	constructor(
		private readonly files: AppFiles,
		private readonly ledger?: WorkerHost,
	) {}
	private pathHost() {
		this.host ??= detectPathHost();
		return this.host;
	}
	complete(input: string, hidden = false): Promise<PathCompletion> {
		return completePath(input, hidden, this.pathHost());
	}
	/** One native folder dialog at a time: a second would stack behind the first on the person's desktop. */
	async pick(signal?: AbortSignal): Promise<WorkspacePick> {
		if (this.picking) throw new AppProblem("conflict", "A folder dialog is already open.");
		this.picking = true;
		try {
			const result = await runFolderPicker(signal);
			if (result.status !== "picked") return result;
			const host = this.pathHost();
			// A Windows dialog under WSL answers in Windows spelling; map it onto this distro's mounts.
			const candidate = result.windows && host.platform !== "win32" ? toServerPath(result.raw, host) : result.raw;
			if (!candidate || !isAbsolute(candidate))
				return { status: "unavailable", reason: `The chosen folder ${result.raw} is not reachable from this server.` };
			try {
				const path = await realpath(candidate);
				if ((await stat(path)).isDirectory()) return { status: "picked", path };
			} catch {
				// Reported below as an unreachable choice; the dialog itself succeeded.
			}
			return { status: "unavailable", reason: `The chosen folder ${result.raw} is not reachable from this server.` };
		} finally {
			this.picking = false;
		}
	}
	private async fromLedger(): Promise<Workspace[]> {
		if (!this.ledger) return [];
		let raw: unknown;
		try {
			raw = await this.ledger.call("sessions.workspaces", {});
		} catch {
			// The ledger is a second source; recents alone still give a usable list while it is unreadable.
			return [];
		}
		if (!Value.Check(LedgerWorkspaces, raw)) return [];
		return raw.map((row) => ({
			id: workspaceId(row.cwd),
			path: row.cwd,
			name: basename(row.cwd) || row.cwd,
			openedAt: row.lastActivityAt,
		}));
	}
	async list(): Promise<Workspace[]> {
		const value = await this.files.read("workspaces");
		if (!Value.Check(Workspaces, value)) throw new AppProblem("unavailable", "Recent workspace state is invalid.");
		const merged = new Map<string, Workspace>();
		for (const row of [...value, ...(await this.fromLedger())]) {
			const known = merged.get(row.id);
			if (!known) merged.set(row.id, row);
			else if (row.openedAt > known.openedAt) merged.set(row.id, { ...known, openedAt: row.openedAt });
		}
		// A directory that has gone away keeps its record and its history; it only stops being offered until it returns.
		const available = await Promise.all(
			[...merged.values()].map(async (row) => {
				try {
					return (await realpath(row.path)) === row.path && (await stat(row.path)).isDirectory() ? row : null;
				} catch {
					return null;
				}
			}),
		);
		return available
			.filter((row): row is Workspace => row !== null)
			.sort((a, b) => b.openedAt.localeCompare(a.openedAt))
			.slice(0, RECENT_LIMIT);
	}
	async get(id: string) {
		const row = (await this.list()).find((item) => item.id === id);
		if (!row) throw new AppProblem("not_found", "Workspace was not found in the recent list.");
		let path: string;
		try {
			path = await realpath(row.path);
			if (!(await stat(path)).isDirectory()) throw new Error("directory");
		} catch {
			throw new AppProblem("unavailable", "Workspace directory is no longer available.");
		}
		if (path !== row.path) throw new AppProblem("conflict", "Workspace path changed; open its canonical path again.");
		return row;
	}
	async open(typed: string): Promise<Workspace> {
		// The path box completes `~`, drive and WSL share spellings, so opening accepts the same ones.
		const path = toServerPath(typed.trim(), this.pathHost()) ?? typed;
		if (!isAbsolute(path)) throw new AppProblem("validation", "Workspace path must be absolute.");
		let canonical: string;
		try {
			canonical = await realpath(path);
			if (!(await stat(canonical)).isDirectory()) throw new Error("directory");
		} catch {
			throw new AppProblem("validation", "Workspace must be an existing directory.");
		}
		const row: Workspace = {
			id: workspaceId(canonical),
			path: canonical,
			name: basename(canonical) || canonical,
			openedAt: new Date().toISOString(),
		};
		return this.files.update("workspaces", (current) => {
			if (!Value.Check(Workspaces, current)) throw new AppProblem("unavailable", "Recent workspace state is invalid.");
			return { value: [row, ...current.filter((item) => item.id !== row.id)].slice(0, RECENT_LIMIT), result: row };
		});
	}
}
