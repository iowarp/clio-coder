import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolSpec } from "../src/tools/registry.js";
import { writePlanTool } from "../src/tools/write-plan.js";
import { writeReviewTool } from "../src/tools/write-review.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools-plan-review] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools-plan-review] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function exerciseTool(label: string, basename: string, content: string, tool: ToolSpec): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), `clio-${label}-`));
	const originalCwd = process.cwd();
	try {
		process.chdir(tmp);

		const allowedRes = await tool.run({ path: basename, content });
		const allowedPath = join(tmp, basename);
		check(
			`${label}:allowed-root-path`,
			allowedRes.kind === "ok" && existsSync(allowedPath) && readFileSync(allowedPath, "utf8") === content,
			`got ${JSON.stringify(allowedRes)}`,
		);

		const otherPath = join(tmp, "other.md");
		const rejectOtherRes = await tool.run({ path: "other.md", content });
		check(
			`${label}:rejects-other-path`,
			rejectOtherRes.kind === "error" &&
				rejectOtherRes.message.includes(`only accepts path="${basename}"`) &&
				!existsSync(otherPath),
			`got ${JSON.stringify(rejectOtherRes)}`,
		);

		const rejectEscapeRes = await tool.run({ path: "../escape/PLAN.md", content: "x" });
		check(
			`${label}:rejects-parent-escape`,
			rejectEscapeRes.kind === "error" && rejectEscapeRes.message.includes(`only accepts path="${basename}"`),
			`got ${JSON.stringify(rejectEscapeRes)}`,
		);

		const emptyRes = await tool.run({ content: "" });
		check(
			`${label}:rejects-empty-content`,
			emptyRes.kind === "error" &&
				emptyRes.message.includes("empty content") &&
				readFileSync(allowedPath, "utf8") === content,
			`got ${JSON.stringify(emptyRes)}`,
		);
	} finally {
		process.chdir(originalCwd);
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

async function main(): Promise<void> {
	await exerciseTool("write-plan", "PLAN.md", "# plan", writePlanTool);
	await exerciseTool("write-review", "REVIEW.md", "# review", writeReviewTool);

	if (failures.length > 0) {
		process.stderr.write(`[diag-tools-plan-review] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools-plan-review] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools-plan-review] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
