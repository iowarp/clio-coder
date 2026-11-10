import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadProjectClioMd } from "../../src/domains/context/clio-md.js";

const root = mkdtempSync(join(tmpdir(), "clio-coder-handbook-discovery-"));
after(() => rmSync(root, { recursive: true, force: true }));

function handbook(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "CLIO-CODER.md");
	writeFileSync(path, `# ${name}\n\n${name} guidance.\n`);
	return path;
}

describe("handbook discovery", () => {
	it("stops at the repository root, so a handbook for the directory holding many repos stays out of each", () => {
		handbook(root, "Container");
		const repo = join(root, "repo");
		const repoHandbook = handbook(repo, "Repo");
		mkdirSync(join(repo, ".git"));
		const nested = handbook(join(repo, "packages", "app"), "Package");
		deepStrictEqual(
			loadProjectClioMd(join(repo, "packages", "app")).files.map((file) => file.path),
			[repoHandbook, nested],
		);
	});

	it("treats a .git file as a root too, as in a worktree or submodule", () => {
		const worktree = join(root, "worktree");
		const own = handbook(worktree, "Worktree");
		writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
		deepStrictEqual(
			loadProjectClioMd(worktree).files.map((file) => file.path),
			[own],
		);
	});

	it("outside any repository loads only the directory's own handbook", () => {
		handbook(join(root, "plain"), "Plain");
		const child = handbook(join(root, "plain", "child"), "Child");
		deepStrictEqual(
			loadProjectClioMd(join(root, "plain", "child")).files.map((file) => file.path),
			[child],
		);
	});

	it("loads CLIO-DEV.md ahead of CLIO-CODER.md only at the root of Clio's own checkout", () => {
		const checkout = (dir: string, packageName: string): string => {
			handbook(dir, "Generated");
			for (const marker of [
				"src/entry/orchestrator.ts",
				"src/worker/entry.ts",
				"src/domains/prompts/fragments/identity/clio.md",
			]) {
				mkdirSync(join(dir, marker, ".."), { recursive: true });
				writeFileSync(join(dir, marker), "");
			}
			mkdirSync(join(dir, ".git"));
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: packageName, repository: "https://github.com/iowarp/clio-coder" }),
			);
			const own = join(dir, "CLIO-DEV.md");
			writeFileSync(own, "# Hand-written\n\nHand-written guidance.\n");
			return own;
		};
		const own = checkout(join(root, "clio-checkout"), "@iowarp/clio-coder");
		deepStrictEqual(
			loadProjectClioMd(join(root, "clio-checkout")).files.map((file) => file.path),
			[own],
		);
		checkout(join(root, "other-checkout"), "@example/other");
		deepStrictEqual(
			loadProjectClioMd(join(root, "other-checkout")).files.map((file) => file.path),
			[join(root, "other-checkout", "CLIO-CODER.md")],
		);
	});
});
