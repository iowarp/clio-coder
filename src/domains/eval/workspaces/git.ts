import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { EvalWorkspaceV2 } from "../schema/suite.js";
import type { PreparedEvalWorkspace } from "./local.js";

export async function prepareGitWorkspace(workspace: EvalWorkspaceV2): Promise<PreparedEvalWorkspace> {
	if (workspace.url === undefined) throw new Error("git workspace requires url");
	const dest = await mkdtemp(resolve(tmpdir(), "clio-coder-eval-git-"));
	try {
		await runGit(["clone", "--quiet", workspace.url, dest], process.cwd());
		const ref = workspace.checkout ?? workspace.commit;
		if (ref !== undefined) await runGit(["checkout", "--quiet", ref], dest);
		return {
			dir: dest,
			cleanup: async () => {
				await rm(dest, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(dest, { recursive: true, force: true });
		throw error;
	}
}

function runGit(args: ReadonlyArray<string>, cwd: string): Promise<void> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn("git", [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", rejectRun);
		child.on("close", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
		});
	});
}
