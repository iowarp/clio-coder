import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectProjectType } from "../../../src/domains/session/workspace/project-type.js";

function tmp(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-pt-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("detectProjectType", () => {
	it("returns 'unknown' for an empty directory", () => {
		const t = tmp();
		try {
			strictEqual(detectProjectType(t.dir), "unknown");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'node' when package.json is present", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "package.json"), "{}");
			strictEqual(detectProjectType(t.dir), "node");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'python' when pyproject.toml is present", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "pyproject.toml"), "");
			strictEqual(detectProjectType(t.dir), "python");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'python' when setup.py is present", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "setup.py"), "");
			strictEqual(detectProjectType(t.dir), "python");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'rust' when Cargo.toml is present", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "Cargo.toml"), "");
			strictEqual(detectProjectType(t.dir), "rust");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'go' when go.mod is present", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "go.mod"), "module x");
			strictEqual(detectProjectType(t.dir), "go");
		} finally {
			t.cleanup();
		}
	});

	it("returns 'dotfiles' when stow-style dot- directories are present", () => {
		const t = tmp();
		try {
			mkdirSync(join(t.dir, "dot-bashrc"));
			mkdirSync(join(t.dir, "dot-config"));
			strictEqual(detectProjectType(t.dir), "dotfiles");
		} finally {
			t.cleanup();
		}
	});

	it("prefers 'node' over 'dotfiles' when both signals exist", () => {
		const t = tmp();
		try {
			writeFileSync(join(t.dir, "package.json"), "{}");
			mkdirSync(join(t.dir, "dot-bashrc"));
			strictEqual(detectProjectType(t.dir), "node");
		} finally {
			t.cleanup();
		}
	});
});
