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

	it("keeps layering every ancestor when no repository encloses the directory", () => {
		const container = handbook(join(root, "plain"), "Plain");
		const child = handbook(join(root, "plain", "child"), "Child");
		deepStrictEqual(
			loadProjectClioMd(join(root, "plain", "child"))
				.files.map((file) => file.path)
				.filter((path) => path.startsWith(root)),
			[join(root, "CLIO-CODER.md"), container, child],
		);
	});
});
