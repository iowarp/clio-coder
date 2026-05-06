import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandInlineFileReferences, readFileArgs } from "../../src/core/file-references.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-file-ref-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("core/file-references", () => {
	it("renders @file args as file XML blocks", () => {
		writeFileSync(join(scratch, "README.md"), "# Project\n", "utf8");

		const result = readFileArgs(["README.md"], { cwd: scratch });

		strictEqual(result.diagnostics.length, 0);
		ok(result.text.includes(`<file name="${join(scratch, "README.md")}">`), result.text);
		ok(result.text.includes("# Project"), result.text);
	});

	it("reports missing @file args in strict mode", () => {
		const result = readFileArgs(["missing.md"], { cwd: scratch });

		strictEqual(result.text, "");
		strictEqual(result.diagnostics[0]?.type, "error");
		ok(result.diagnostics[0]?.message.includes("file not found"));
	});

	it("expands inline references that point to existing files and leaves missing mentions alone", () => {
		writeFileSync(join(scratch, "notes.md"), "notes body\n", "utf8");

		const result = expandInlineFileReferences("Read @notes.md, then @missing.md", { cwd: scratch });

		ok(result.text.includes(`<file name="${join(scratch, "notes.md")}">`), result.text);
		ok(result.text.includes("notes body"), result.text);
		ok(result.text.includes(", then @missing.md"), result.text);
	});
});
