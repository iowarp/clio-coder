import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import type { EvalWorkspaceV2 } from "../schema/suite.js";
import type { PreparedEvalWorkspace } from "./local.js";

export async function prepareTempCopyWorkspace(
	baseDir: string,
	workspace: EvalWorkspaceV2,
): Promise<PreparedEvalWorkspace> {
	const source = resolve(baseDir, workspace.path ?? ".");
	const dest = await mkdtemp(resolve(tmpdir(), "clio-eval-workspace-"));
	const excludes = workspace.excludes ?? [];
	await cp(source, dest, {
		recursive: true,
		filter: (path) => !isExcluded(relative(source, path), excludes),
	});
	return {
		dir: dest,
		cleanup: async () => {
			await rm(dest, { recursive: true, force: true });
		},
	};
}

function isExcluded(rel: string, excludes: ReadonlyArray<string>): boolean {
	const normalized = rel.replaceAll("\\", "/");
	return excludes.some((entry) => normalized === entry || normalized.startsWith(`${entry.replaceAll("\\", "/")}/`));
}
