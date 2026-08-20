import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { detectClioCoderRepo } from "../../src/core/clio-repo.js";

const roots: string[] = [];
const SOURCE_MARKERS = [
	"src/entry/orchestrator.ts",
	"src/worker/entry.ts",
	"src/domains/prompts/fragments/identity/clio.md",
];

function makeClioRepoRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-repo-"));
	roots.push(root);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "@iowarp/clio-coder",
			repository: { type: "git", url: "https://github.com/iowarp/clio-coder.git" },
		}),
		"utf8",
	);
	mkdirSync(join(root, ".git"), { recursive: true });
	for (const marker of SOURCE_MARKERS) {
		mkdirSync(join(root, marker, ".."), { recursive: true });
		writeFileSync(join(root, marker), "// marker\n", "utf8");
	}
	return root;
}

describe("contracts/clio-repo detection", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("detects the clio-coder root from its own directory and plain subdirectories", () => {
		const root = makeClioRepoRoot();
		strictEqual(detectClioCoderRepo(root).isClioCoderRepo, true);
		strictEqual(detectClioCoderRepo(root).repoRoot, root);

		const deep = join(root, "docs", "guides");
		mkdirSync(deep, { recursive: true });
		const fromDeep = detectClioCoderRepo(deep);
		strictEqual(fromDeep.isClioCoderRepo, true);
		strictEqual(fromDeep.repoRoot, root);
	});

	it("stops at a nested git repository instead of matching the clio-coder root above it", () => {
		const root = makeClioRepoRoot();
		const nested = join(root, "work", "other-project");
		mkdirSync(join(nested, ".git"), { recursive: true });

		strictEqual(detectClioCoderRepo(nested).isClioCoderRepo, false);
		strictEqual(detectClioCoderRepo(nested).repoRoot, null);

		const deeper = join(nested, "src", "lib");
		mkdirSync(deeper, { recursive: true });
		strictEqual(detectClioCoderRepo(deeper).isClioCoderRepo, false);
	});

	it("stops at a nested worktree-style .git file as well", () => {
		const root = makeClioRepoRoot();
		const nested = join(root, "work", "worktree-project");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");

		strictEqual(detectClioCoderRepo(nested).isClioCoderRepo, false);
	});

	it("does not match an unrelated repository", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-other-"));
		roots.push(root);
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other" }), "utf8");

		strictEqual(detectClioCoderRepo(root).isClioCoderRepo, false);
	});
});
