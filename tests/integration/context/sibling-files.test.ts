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
			writeFileSync(join(dir, ".cursor", "rules", "rules.mdc"), "cursor", "utf8");
			const files = loadSiblingContextFiles(dir, { includeGlobal: false });
			strictEqual(
				files.some((file) => file.path.endsWith("CLAUDE.md")),
				true,
			);
			ok(files.some((file) => file.content === "cursor"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads global sibling files from an explicit home directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-sibling-"));
		const home = mkdtempSync(join(tmpdir(), "clio-sibling-home-"));
		try {
			mkdirSync(join(home, ".codex"), { recursive: true });
			writeFileSync(join(home, ".codex", "AGENTS.md"), "global codex", "utf8");

			const files = loadSiblingContextFiles(dir, { homeDir: home, includeGlobal: true });

			ok(files.some((file) => file.source === "global" && file.content === "global codex"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("can suppress global sibling files for isolated callers", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-sibling-"));
		const home = mkdtempSync(join(tmpdir(), "clio-sibling-home-"));
		try {
			mkdirSync(join(home, ".codex"), { recursive: true });
			writeFileSync(join(home, ".codex", "AGENTS.md"), "global codex", "utf8");

			const files = loadSiblingContextFiles(dir, { homeDir: home, includeGlobal: false });

			strictEqual(files.length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
