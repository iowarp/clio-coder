import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { enumerateWorkspaceFiles, filterWorkspaceFileCandidates } from "../../src/core/workspace-files.js";
import { buildCodewiki, updateCodewikiPaths } from "../../src/domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { detectProjectProfile } from "../../src/domains/session/workspace/project-type.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchProject(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	scratchRoots.push(root);
	return root;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
	return child.stdout.trim();
}

function treeHashForPaths(cwd: string, relPaths: ReadonlyArray<string>): string {
	const hash = createHash("sha256");
	for (const relPath of [...relPaths].sort()) {
		const stat = statSync(join(cwd, relPath));
		hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
	}
	return hash.digest("hex");
}

describe("contracts/workspace-files", () => {
	it("keeps Git-visible source files aligned across index, profile, fingerprint, and incremental updates", async () => {
		const cwd = scratchProject("clio-workspace-files-git-");
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "clio-test@example.com"]);
		git(cwd, ["config", "user.name", "Clio Test"]);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");
		git(cwd, ["add", "src/tracked.ts"]);

		const ignoredDir = "scratch-output-with-arbitrary-name";
		writeFileSync(join(cwd, ".gitignore"), `${ignoredDir}/\nsrc/tracked.ts\ndist/\n`, "utf8");
		writeFileSync(join(cwd, "src", "wip.ts"), "export const wip = true;\n", "utf8");
		mkdirSync(join(cwd, ignoredDir), { recursive: true });
		writeFileSync(join(cwd, ignoredDir, "noise.ts"), "export const noise = true;\n", "utf8");
		mkdirSync(join(cwd, "dist"), { recursive: true });
		writeFileSync(join(cwd, "dist", "tracked.ts"), "export const generated = true;\n", "utf8");
		git(cwd, ["add", "-f", "dist/tracked.ts"]);

		const files = enumerateWorkspaceFiles(cwd);
		deepStrictEqual(files, [...files].sort());
		deepStrictEqual(
			files.filter((path) => path.endsWith(".ts")),
			["src/tracked.ts", "src/wip.ts"],
		);
		deepStrictEqual(
			filterWorkspaceFileCandidates(cwd, [`${ignoredDir}/noise.ts`, "dist/tracked.ts", "src/wip.ts", "src/tracked.ts"]),
			["src/tracked.ts", "src/wip.ts"],
		);

		const codewiki = await buildCodewiki({ cwd, language: "typescript" });
		deepStrictEqual(
			codewiki.files.map((file) => file.path),
			["src/tracked.ts", "src/wip.ts"],
		);
		const profile = detectProjectProfile(cwd);
		strictEqual(profile.sourceFiles, 2);
		strictEqual(profile.languageCounts.typescript, 2);
		strictEqual(
			computeFingerprint(cwd, codewiki).treeHash,
			treeHashForPaths(
				cwd,
				codewiki.files.map((file) => file.path),
			),
		);

		const unchanged = await updateCodewikiPaths(cwd, codewiki, [`${ignoredDir}/noise.ts`]);
		strictEqual(unchanged, codewiki);
	});

	it("falls back to a bounded filesystem walk outside Git and does not follow symlinks", () => {
		const cwd = scratchProject("clio-workspace-files-fallback-");
		const external = scratchProject("clio-workspace-files-external-");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "src", "main.py"), "def main():\n    return 0\n", "utf8");
		writeFileSync(join(cwd, "node_modules", "pkg", "ignored.py"), "ignored = True\n", "utf8");
		writeFileSync(join(external, "outside.py"), "outside = True\n", "utf8");
		symlinkSync(join(external, "outside.py"), join(cwd, "src", "linked.py"));

		const files = enumerateWorkspaceFiles(cwd);
		ok(files.includes("src/main.py"));
		strictEqual(
			files.some((path) => path.includes("node_modules")),
			false,
		);
		strictEqual(files.includes("src/linked.py"), false);
		strictEqual(detectProjectProfile(cwd).sourceFiles, 1);
	});

	it("reconciles indexed paths when Git ignore visibility changes", async () => {
		const cwd = scratchProject("clio-workspace-files-ignore-transition-");
		git(cwd, ["init"]);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "wip.ts"), "export const wip = true;\n", "utf8");

		const initial = await buildCodewiki({ cwd, language: "typescript" });
		deepStrictEqual(
			initial.files.map((file) => file.path),
			["src/wip.ts"],
		);

		writeFileSync(join(cwd, ".gitignore"), "src/wip.ts\n", "utf8");
		const ignored = await updateCodewikiPaths(cwd, initial, [".gitignore"]);
		deepStrictEqual(
			ignored.files.map((file) => file.path),
			[],
		);

		writeFileSync(join(cwd, ".gitignore"), "", "utf8");
		const restored = await updateCodewikiPaths(cwd, ignored, [".gitignore"]);
		deepStrictEqual(
			restored.files.map((file) => file.path),
			["src/wip.ts"],
		);
	});
});
