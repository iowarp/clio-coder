import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { bashTool } from "../../src/tools/bash.js";
import { editTool } from "../../src/tools/edit.js";
import { findTool } from "../../src/tools/find.js";
import { globTool } from "../../src/tools/glob.js";
import { lsTool } from "../../src/tools/ls.js";
import { writeTool } from "../../src/tools/write.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-tools-basic-"));
	scratchRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("ported basic coding tools", () => {
	it("write overwrites existing files and creates parent directories", async () => {
		const root = scratchDir();
		const filePath = join(root, "nested", "note.txt");

		let result = await writeTool.run({ path: filePath, content: "one" });
		strictEqual(result.kind, "ok");
		result = await writeTool.run({ path: filePath, content: "two" });
		strictEqual(result.kind, "ok");

		strictEqual(readFileSync(filePath, "utf8"), "two");
	});

	it("edit applies multiple disjoint edits and returns diff details", async () => {
		const root = scratchDir();
		const filePath = join(root, "src.ts");
		writeFileSync(filePath, "export const a = 1;\nexport const b = 2;\n", "utf8");

		const result = await editTool.run({
			path: filePath,
			edits: [
				{ oldText: "export const a = 1;", newText: "export const a = 10;" },
				{ oldText: "export const b = 2;", newText: "export const b = 20;" },
			],
		});

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(readFileSync(filePath, "utf8"), "export const a = 10;\nexport const b = 20;\n");
		ok(String(result.details?.diff ?? "").includes("+1 export const a = 10;"));
		ok(String(result.details?.diff ?? "").includes("+2 export const b = 20;"));
	});

	it("find locates files by glob relative to the search root", async () => {
		const root = scratchDir();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
		writeFileSync(join(root, "README.md"), "# sample\n", "utf8");

		const result = await findTool.run({ pattern: "**/*.ts", path: root });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.split("\n").includes("src/index.ts"), result.output);
	});

	it("find only reports result limits when additional matches exist", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "a.txt"), "a\n", "utf8");
		writeFileSync(join(root, "b.txt"), "b\n", "utf8");

		const exactLimit = await findTool.run({ pattern: "*.txt", path: root, limit: 2 });

		strictEqual(exactLimit.kind, "ok");
		if (exactLimit.kind !== "ok") return;
		ok(!exactLimit.output.includes("results limit reached"), exactLimit.output);
		strictEqual(exactLimit.details?.resultLimitReached, undefined);

		const exceededLimit = await findTool.run({ pattern: "*.txt", path: root, limit: 1 });

		strictEqual(exceededLimit.kind, "ok");
		if (exceededLimit.kind !== "ok") return;
		ok(exceededLimit.output.includes("1 results limit reached"), exceededLimit.output);
		strictEqual(exceededLimit.details?.resultLimitReached, 1);
	});

	it("find uses shared read-path normalization for the search root", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "note.md"), "# sample\n", "utf8");

		const result = await findTool.run({ pattern: "*.md", path: `@${root}` });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output, "note.md");
	});

	it("glob uses shared read-path normalization for the search root", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "note.md"), "# sample\n", "utf8");

		const result = await globTool.run({ pattern: "*.md", path: `@${root}` });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output, "note.md");
		strictEqual(result.details?.root, root);
	});

	it("glob reports when its result limit is reached", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "a.txt"), "a\n", "utf8");
		writeFileSync(join(root, "b.txt"), "b\n", "utf8");

		const result = await globTool.run({ pattern: "*.txt", path: root, limit: 1 });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("1 results limit reached"), result.output);
		strictEqual(result.details?.resultLimitReached, 1);
	});

	it("ls lists directory names with suffixes and honors the entry limit", async () => {
		const root = scratchDir();
		mkdirSync(join(root, "Aardvark"), { recursive: true });
		writeFileSync(join(root, "Alpha.txt"), "a\n", "utf8");
		writeFileSync(join(root, "beta.txt"), "b\n", "utf8");

		const result = await lsTool.run({ path: root, limit: 2 });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output, "Aardvark/\nAlpha.txt\n\n[2 entries limit reached. Use limit=4 for more]");
		strictEqual(result.details?.entryLimitReached, 2);
	});

	it("ls reports empty directories explicitly", async () => {
		const root = scratchDir();

		const result = await lsTool.run({ path: root });

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") strictEqual(result.output, "(empty directory)");
	});

	it("ls uses shared read-path normalization for the search root", async () => {
		const root = scratchDir();
		writeFileSync(join(root, "note.md"), "# sample\n", "utf8");

		const result = await lsTool.run({ path: `@${root}` });

		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output, "note.md");
	});

	it("bash preserves command output when the command exits nonzero", async () => {
		const result = await bashTool.run({ command: "printf before; printf 'err' >&2; exit 7" });

		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		ok(result.message.includes("before\nerr"), result.message);
		ok(result.message.includes("bash: command failed (exit 7)"), result.message);
	});
});
