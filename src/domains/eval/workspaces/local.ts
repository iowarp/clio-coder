import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalWorkspaceV2 } from "../schema/suite-v2.js";

export interface PreparedEvalWorkspace {
	dir: string;
	cleanup: () => Promise<void>;
}

export async function prepareLocalWorkspace(
	baseDir: string,
	workspace: EvalWorkspaceV2,
): Promise<PreparedEvalWorkspace> {
	const dir = resolve(baseDir, workspace.path ?? ".");
	await access(dir);
	return { dir, cleanup: async () => {} };
}
