import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSiblingContextFiles } from "../../../src/domains/context/sibling-files.js";

describe("context/sibling-files", () => {
	it("reads local sibling files and cursor rules", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-sibling-"));
		try {
			writeFileSync(join(dir, "CLAUDE.md"), "claude", "utf8");
			mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
			writeFileSync(join(dir, ".cursor", "rules", "rules.md"), "cursor", "utf8");
			const files = loadSiblingContextFiles(dir);
			strictEqual(
				files.some((file) => file.path.endsWith("CLAUDE.md")),
				true,
			);
			ok(files.some((file) => file.content === "cursor"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
