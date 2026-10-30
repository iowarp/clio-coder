import path from "node:path";

/**
 * After a write or edit lands a recipe under `<workspace>/.clio-coder/agents/`,
 * the model that authored it gets the validator's full issue list once, on the
 * same tool result, instead of discovering a quarantined recipe at dispatch.
 *
 * It never blocks or fails the write: the note is appended after the file is
 * published, and a validator that cannot run appends nothing. The validator
 * loads through a dynamic import on the first matching write so the tool
 * substrate, the instant shell's Stage 0 closure and the worker entry do not
 * carry the agents domain for writes that never touch a recipe.
 */
export async function harnessRecipeWriteNote(filePath: string, workspaceRoot = process.cwd()): Promise<string | null> {
	const relative = path.relative(workspaceRoot, filePath);
	const segments = relative.split(path.sep);
	if (segments.length !== 3 || segments[0] !== ".clio-coder" || segments[1] !== "agents" || !relative.endsWith(".md")) {
		return null;
	}
	try {
		const { formatHarnessIssues, validateHarnessAt } = await import("../domains/agents/harness-validate.js");
		const id = path.basename(filePath, ".md");
		const file = relative.split(path.sep).join("/");
		const issues = validateHarnessAt(workspaceRoot, { recipeFile: filePath }).filter(
			(issue) => issue.file === relative || issue.file === file || issue.field === `fleet.agentProfiles.${id}`,
		);
		if (issues.length === 0) return null;
		return `harness: ${issues.length} problem${issues.length === 1 ? "" : "s"} in ${file}, listed in full so they can be fixed in one edit:\n${formatHarnessIssues(issues)}`;
	} catch {
		// The write already landed. A validator that throws, or cannot load in
		// this process, must not turn a successful write into an error or noise.
		return null;
	}
}
