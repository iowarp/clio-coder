/** Validate committed suites through the production loader; never execute a runner or model. */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEvalSuiteFile } from "../src/domains/eval/suites/load.js";
import { protectGraderFiles } from "../src/domains/eval/verifiers/integrity.js";

const root = resolve(import.meta.dirname, "..");
let count = 0;
async function checkDirectory(directory: string): Promise<void> {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await checkDirectory(path);
		} else if (entry.name.endsWith(".yaml")) {
			const loaded = await loadEvalSuiteFile(path);
			for (const task of loaded.suite.tasks) {
				const workspace = task.workspace;
				if (workspace.kind === "git") {
					if (!/^[a-f0-9]{40}$/.test(workspace.commit ?? "") || workspace.checkout !== undefined)
						throw new Error(`${path}: ${task.id} must pin an immutable Git commit without a checkout override`);
				} else {
					const cwd = resolve(loaded.baseDir, workspace.path ?? ".");
					if (!existsSync(cwd)) throw new Error(`${path}: missing workspace ${cwd}`);
					await protectGraderFiles(cwd, task.verify?.protectedFiles ?? []);
				}
			}
			count++;
		}
	}
}
await checkDirectory(join(root, "evals"));
console.log(`evals: ${count} suites validated through the production loader; no runners executed`);
