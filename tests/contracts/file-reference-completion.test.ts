import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createFileReferenceCompletionSource,
	formatInlineFileReference,
} from "../../src/interactive/file-reference-completion.js";

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-file-completion-"));
	roots.push(root);
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# Workspace preview\n", "utf8");
	writeFileSync(join(root, "scratch.txt"), "untracked scratch line\n", "utf8");
	writeFileSync(join(root, "docs", "operator notes.md"), "Operator preview line\nsecond\n", "utf8");
	writeFileSync(join(root, "src", "index.ts"), "export const tracked = true;\n", "utf8");
	writeFileSync(join(root, "src", "nested", "worker.ts"), "export function worker() {}\n", "utf8");
	return root;
}

describe("contracts/file-reference completion", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("presents a git-first workspace tree with fuzzy paths and content previews", async () => {
		const root = workspace();
		const files = ["README.md", "scratch.txt", "docs/operator notes.md", "src/index.ts", "src/nested/worker.ts"];
		const tracked = new Set(["README.md", "docs/operator notes.md", "src/index.ts", "src/nested/worker.ts"]);
		const source = createFileReferenceCompletionSource({
			basePath: root,
			listWorkspaceFiles: async () => files,
			listTrackedFiles: async () => tracked,
		});
		const signal = new AbortController().signal;

		const rootRows = await source({ query: "", signal });
		deepStrictEqual(
			rootRows.map((row) => [row.path, row.tracked, row.isDirectory]),
			[
				["docs", true, true],
				["src", true, true],
				["README.md", true, false],
				["scratch.txt", false, false],
			],
		);
		ok(rootRows[0]?.description.includes("Tab/Enter opens"));
		ok(rootRows.find((row) => row.path === "README.md")?.description.includes("# Workspace preview"));

		const fuzzy = await source({ query: "opnote", signal });
		strictEqual(fuzzy[0]?.path, "docs/operator notes.md");
		ok(fuzzy[0]?.description.includes("Operator preview line"));
		strictEqual(fuzzy[0]?.value, '@"docs/operator notes.md"');

		const childRows = await source({ query: "src/", signal });
		deepStrictEqual(
			childRows.map((row) => row.path),
			["src/nested", "src/index.ts"],
		);
		strictEqual(childRows[0]?.value, "@src/nested/");
	});

	it("quotes whitespace, quotes, and backslashes in inline completion values", () => {
		strictEqual(formatInlineFileReference("src/index.ts", false), "@src/index.ts");
		strictEqual(formatInlineFileReference("docs/operator notes.md", false), '@"docs/operator notes.md"');
		strictEqual(formatInlineFileReference('docs/a"b.txt', false), '@"docs/a\\"b.txt"');
		strictEqual(formatInlineFileReference("docs/a\\b", true), '@"docs/a\\\\b/"');
	});
});
