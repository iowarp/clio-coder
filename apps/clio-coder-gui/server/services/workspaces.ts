import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Workspace } from "../../contracts/sessions.js";
import type { AppFiles } from "../state/files.js";
import { AppProblem } from "./problem.js";

const Workspaces = Type.Array(Workspace);
export class WorkspaceService {
	constructor(private readonly files: AppFiles) {}
	async list(): Promise<Workspace[]> {
		const value = await this.files.read("workspaces");
		if (!Value.Check(Workspaces, value)) throw new AppProblem("unavailable", "Recent workspace state is invalid.");
		return value;
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
	async open(path: string): Promise<Workspace> {
		if (!isAbsolute(path)) throw new AppProblem("validation", "Workspace path must be absolute.");
		let canonical: string;
		try {
			canonical = await realpath(path);
			if (!(await stat(canonical)).isDirectory()) throw new Error("directory");
		} catch {
			throw new AppProblem("validation", "Workspace must be an existing directory.");
		}
		const row: Workspace = {
			id: createHash("sha256").update(canonical).digest("hex").slice(0, 32),
			path: canonical,
			name: basename(canonical) || canonical,
			openedAt: new Date().toISOString(),
		};
		return this.files.update("workspaces", (current) => {
			if (!Value.Check(Workspaces, current)) throw new AppProblem("unavailable", "Recent workspace state is invalid.");
			return { value: [row, ...current.filter((item) => item.id !== row.id)].slice(0, 40), result: row };
		});
	}
}
