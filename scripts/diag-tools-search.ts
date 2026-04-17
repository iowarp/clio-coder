import path from "node:path";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { lsTool } from "../src/tools/ls.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools-search] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools-search] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function run(): Promise<void> {
	const repoRoot = process.cwd();

	const grepExport = await grepTool.run({ pattern: "export", path: "src/core" });
	check("grep:export-kind-ok", grepExport.kind === "ok", JSON.stringify(grepExport));
	check(
		"grep:export-has-matches",
		grepExport.kind === "ok" &&
			grepExport.output !== "no matches" &&
			grepExport.output.includes(`${path.join(repoRoot, "src", "core")}${path.sep}`),
		grepExport.kind === "ok" ? grepExport.output : JSON.stringify(grepExport),
	);

	const grepMiss = await grepTool.run({ pattern: "nonexistent-xyz-123", path: "src/core" });
	check("grep:miss-kind-ok", grepMiss.kind === "ok", JSON.stringify(grepMiss));
	check(
		"grep:miss-empty-or-no-matches",
		grepMiss.kind === "ok" && (grepMiss.output.trim() === "" || grepMiss.output.trim() === "no matches"),
		grepMiss.kind === "ok" ? grepMiss.output : JSON.stringify(grepMiss),
	);

	const globCore = await globTool.run({ pattern: "src/core/*.ts" });
	const globCoreLines = globCore.kind === "ok" && globCore.output.length > 0 ? globCore.output.split("\n") : [];
	check("glob:core-kind-ok", globCore.kind === "ok", JSON.stringify(globCore));
	check(
		"glob:core-has-several-files",
		globCore.kind === "ok" && globCoreLines.length >= 3,
		globCore.kind === "ok" ? globCore.output : JSON.stringify(globCore),
	);
	check(
		"glob:core-returns-absolute-paths",
		globCore.kind === "ok" && globCoreLines.every((line) => path.isAbsolute(line)),
		globCore.kind === "ok" ? globCore.output : JSON.stringify(globCore),
	);

	const globInvalid = await globTool.run({ pattern: "src/core/[abc" });
	check(
		"glob:invalid-errors",
		globInvalid.kind === "error" && globInvalid.message.includes("invalid pattern"),
		JSON.stringify(globInvalid),
	);

	const lsSrc = await lsTool.run({ path: "src" });
	check("ls:src-kind-ok", lsSrc.kind === "ok", JSON.stringify(lsSrc));
	check(
		"ls:src-has-domains-entry",
		lsSrc.kind === "ok" && lsSrc.output.split("\n").some((line) => line.trimEnd().endsWith("domains")),
		lsSrc.kind === "ok" ? lsSrc.output : JSON.stringify(lsSrc),
	);

	const lsMissing = await lsTool.run({ path: "definitely-missing-dir-xyz" });
	check(
		"ls:missing-errors",
		lsMissing.kind === "error" && lsMissing.message.includes("ENOENT"),
		JSON.stringify(lsMissing),
	);
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-tools-search] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools-search] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools-search] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
