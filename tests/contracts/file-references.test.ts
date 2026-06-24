import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expandInlineFileReferences, readFileArgsAsync } from "../../src/core/file-references.js";
import { expandInteractiveSubmit } from "../../src/interactive/index.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-file-refs-"));
	roots.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
	return root;
}

describe("contracts/file references working paths", () => {
	it("returns referenced paths for inline and explicit file context", async () => {
		const cwd = scratch();
		const target = join(cwd, "src", "index.ts");

		const inline = expandInlineFileReferences("read @src/index.ts", { cwd, missing: "leave" });
		ok(inline.text.includes("<file name="));
		deepStrictEqual(inline.referencedPaths, [target]);

		const interactive = expandInteractiveSubmit("read @src/index.ts", undefined, cwd);
		deepStrictEqual(interactive.workingContextPaths, [target]);

		const explicit = await readFileArgsAsync(["src/index.ts"], { cwd, missing: "error" });
		deepStrictEqual(explicit.referencedPaths, [target]);
	});
});
