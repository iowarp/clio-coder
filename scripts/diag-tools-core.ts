import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool, truncateUtf8 } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";

/**
 * Phase 5 Slice 1 diag harness. Exercises the four core per-file tools
 * (read, write, edit, bash) without involving the registry, modes, or
 * safety domains. No CLIO_HOME — these tools are pure file/shell wrappers.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools-core] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools-core] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), "clio-tools-"));
	try {
		// 1. read OK on package.json
		const pkgRead = await readTool.run({ path: "package.json" });
		check(
			"read:package.json-ok",
			pkgRead.kind === "ok" && pkgRead.output.includes('"name"'),
			`got ${JSON.stringify(pkgRead).slice(0, 120)}`,
		);

		// 2. read missing path
		const readMissing = await readTool.run({});
		check(
			"read:missing-path-error",
			readMissing.kind === "error" && readMissing.message.includes("missing path"),
			`got ${JSON.stringify(readMissing)}`,
		);

		// 3. write to fresh path
		const writePath = join(tmp, "nested", "hello.txt");
		const writeRes = await writeTool.run({ path: writePath, content: "hello world" });
		check(
			"write:fresh-ok",
			writeRes.kind === "ok" && existsSync(writePath) && readFileSync(writePath, "utf8") === "hello world",
			`got ${JSON.stringify(writeRes)}`,
		);

		// 4. write refuses to overwrite
		const writeOverwriteRefused = await writeTool.run({ path: writePath, content: "again" });
		check(
			"write:refuses-overwrite",
			writeOverwriteRefused.kind === "error" && writeOverwriteRefused.message.includes("overwrite"),
			`got ${JSON.stringify(writeOverwriteRefused)}`,
		);

		// 4b. write with overwrite=true succeeds
		const writeOverwriteOk = await writeTool.run({ path: writePath, content: "again", overwrite: true });
		check(
			"write:overwrite-true-ok",
			writeOverwriteOk.kind === "ok" && readFileSync(writePath, "utf8") === "again",
			`got ${JSON.stringify(writeOverwriteOk)}`,
		);

		// 5. edit unique string
		const editPath = join(tmp, "edit-target.txt");
		writeFileSync(editPath, "alpha BETA gamma\n", "utf8");
		const editRes = await editTool.run({ path: editPath, old_string: "BETA", new_string: "DELTA" });
		check(
			"edit:unique-replace-ok",
			editRes.kind === "ok" && readFileSync(editPath, "utf8") === "alpha DELTA gamma\n",
			`got ${JSON.stringify(editRes)}; file=${readFileSync(editPath, "utf8")}`,
		);

		// 6. edit not found
		const editMissing = await editTool.run({ path: editPath, old_string: "ZZZ", new_string: "Q" });
		check(
			"edit:not-found-error",
			editMissing.kind === "error" && editMissing.message.includes("not found"),
			`got ${JSON.stringify(editMissing)}`,
		);

		// 6b. edit duplicate without replace_all
		const dupPath = join(tmp, "dup.txt");
		writeFileSync(dupPath, "x x x", "utf8");
		const editDup = await editTool.run({ path: dupPath, old_string: "x", new_string: "y" });
		check(
			"edit:duplicate-without-replace-all-error",
			editDup.kind === "error" && editDup.message.includes("multiple"),
			`got ${JSON.stringify(editDup)}`,
		);

		// 6c. edit duplicate with replace_all
		const editDupAll = await editTool.run({
			path: dupPath,
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
		check(
			"edit:replace-all-ok",
			editDupAll.kind === "ok" && readFileSync(dupPath, "utf8") === "y y y",
			`got ${JSON.stringify(editDupAll)}; file=${readFileSync(dupPath, "utf8")}`,
		);

		// 7. bash echo
		const bashEcho = await bashTool.run({ command: "echo hello" });
		check("bash:echo-ok", bashEcho.kind === "ok" && bashEcho.output.includes("hello"), `got ${JSON.stringify(bashEcho)}`);

		// 8. bash nonexistent command
		const bashFail = await bashTool.run({ command: "this-command-does-not-exist-xyz" });
		check("bash:nonexistent-error", bashFail.kind === "error", `got ${JSON.stringify(bashFail)}`);

		// 9. UTF-8 truncation backs up to a code point boundary.
		const longAscii = "a".repeat(1_000_000 - 2);
		const utf8Truncated = truncateUtf8(longAscii + "€".repeat(10), 1_000_000, "\n[output truncated]\n");
		check(
			"bash:truncate-utf8-boundary-safe",
			!utf8Truncated.includes("\uFFFD") && utf8Truncated === `${longAscii}\n[output truncated]\n`,
			`got length=${utf8Truncated.length}`,
		);
	} finally {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-tools-core] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools-core] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools-core] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
