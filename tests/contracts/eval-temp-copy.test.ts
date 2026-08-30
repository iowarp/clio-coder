import { strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { prepareTempCopyWorkspace } from "../../src/domains/eval/workspaces/temp-copy.js";

describe("contracts/eval temp copy", { concurrency: false }, () => {
	it("copies Git tracked and visible untracked files without Git-ignored files", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-copy-git-"));
		let prepared: Awaited<ReturnType<typeof prepareTempCopyWorkspace>> | null = null;
		try {
			const source = join(root, "repo");
			const tempRoot = join(root, "temp");
			mkdirSync(join(source, "ignored"), { recursive: true });
			mkdirSync(tempRoot, { recursive: true });
			execFileSync("git", ["init", "-q", source]);
			writeFileSync(join(source, ".gitignore"), "ignored/\n*.ignored\n", "utf8");
			writeFileSync(join(source, "tracked.txt"), "tracked\n", "utf8");
			writeFileSync(join(source, "visible.txt"), "visible untracked\n", "utf8");
			writeFileSync(join(source, "tracked.ignored"), "tracked despite ignore\n", "utf8");
			writeFileSync(join(source, "ignored", "dataset.bin"), "ignored data\n", "utf8");
			execFileSync("git", ["-C", source, "add", ".gitignore", "tracked.txt"]);
			execFileSync("git", ["-C", source, "add", "-f", "tracked.ignored"]);

			prepared = await prepareTempCopyWorkspace(root, { kind: "temp-copy", path: "repo", excludes: [] }, { tempRoot });

			strictEqual(existsSync(join(prepared.dir, ".gitignore")), true);
			strictEqual(existsSync(join(prepared.dir, "tracked.txt")), true);
			strictEqual(existsSync(join(prepared.dir, "tracked.ignored")), true);
			strictEqual(existsSync(join(prepared.dir, "visible.txt")), true);
			strictEqual(existsSync(join(prepared.dir, "ignored", "dataset.bin")), false);
			strictEqual(existsSync(join(prepared.dir, ".git")), false);
		} finally {
			await prepared?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains recursive copy behavior outside a Git checkout", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-copy-plain-"));
		let prepared: Awaited<ReturnType<typeof prepareTempCopyWorkspace>> | null = null;
		try {
			const source = join(root, "source");
			const tempRoot = join(root, "temp");
			mkdirSync(join(source, "ignored-by-name-only"), { recursive: true });
			mkdirSync(tempRoot, { recursive: true });
			writeFileSync(join(source, ".gitignore"), "ignored-by-name-only/\n", "utf8");
			writeFileSync(join(source, "ignored-by-name-only", "kept.txt"), "plain workspace\n", "utf8");

			prepared = await prepareTempCopyWorkspace(root, { kind: "temp-copy", path: "source", excludes: [] }, { tempRoot });

			strictEqual(existsSync(join(prepared.dir, "ignored-by-name-only", "kept.txt")), true);
		} finally {
			await prepared?.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
