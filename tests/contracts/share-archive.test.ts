import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readClioVersion } from "../../src/core/package-root.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	type ClioShareArchive,
	importShareArchive,
	type ShareArchiveFile,
	type ShareEntryType,
	type ShareImportPlan,
	type ShareScope,
	writeShareArchive,
} from "../../src/domains/share/archive.js";

const ORIGINAL_ENV = { ...process.env };

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function archiveFile(input: {
	type?: ShareEntryType;
	scope?: ShareScope;
	archivePath: string;
	relativePath: string;
	body: string;
}): ShareArchiveFile {
	const buffer = Buffer.from(input.body, "utf8");
	return {
		type: input.type ?? "skill",
		scope: input.scope ?? "project",
		archivePath: input.archivePath,
		relativePath: input.relativePath,
		sha256: sha256(buffer),
		size: buffer.byteLength,
		encoding: "base64",
		data: buffer.toString("base64"),
	};
}

function archiveWith(files: ShareArchiveFile[]): ClioShareArchive {
	const manifestFiles = files.map(({ data: _data, encoding: _encoding, ...entry }) => entry);
	return {
		kind: "clio-share-archive",
		formatVersion: 1,
		manifest: {
			format: "clio.share.v1",
			clioVersion: readClioVersion(),
			createdAt: new Date(0).toISOString(),
			files: manifestFiles,
		},
		files,
	};
}

function writeArchive(filePath: string, archive: ClioShareArchive): void {
	writeFileSync(filePath, `${JSON.stringify(archive)}\n`, "utf8");
}

function hasBlockingDiagnostics(plan: ShareImportPlan): boolean {
	return plan.diagnostics.some((diagnostic) => diagnostic.type === "error" || diagnostic.type === "conflict");
}

describe("contracts/share archive import", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), "clio-share-archive-"));
		process.env.HOME = scratch;
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = path.join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = path.join(scratch, "config");
		process.env.CLIO_CACHE_DIR = path.join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("rejects an absolute relativePath before writing any archive entry", () => {
		const dest = path.join(scratch, "dest");
		mkdirSync(dest, { recursive: true });
		const absoluteEscape = path.join(scratch, "outside-absolute", "SKILL.md");
		const archivePath = path.join(scratch, "absolute.clio-share.json");
		writeArchive(
			archivePath,
			archiveWith([
				archiveFile({
					type: "project-context",
					archivePath: "project/CLIO.md",
					relativePath: "CLIO.md",
					body: "clean\n",
				}),
				archiveFile({
					archivePath: "project/skills/bad/SKILL.md",
					relativePath: absoluteEscape,
					body: "bad\n",
				}),
			]),
		);

		const plan = importShareArchive(archivePath, { cwd: dest, force: true });

		strictEqual(hasBlockingDiagnostics(plan), true);
		strictEqual(plan.actions.length, 0);
		strictEqual(existsSync(path.join(dest, "CLIO.md")), false);
		strictEqual(existsSync(absoluteEscape), false);
		ok(plan.diagnostics.some((diagnostic) => diagnostic.message.includes(absoluteEscape)));
	});

	it("rejects a parent traversal relativePath before writing any archive entry", () => {
		const dest = path.join(scratch, "dest");
		mkdirSync(dest, { recursive: true });
		const archivePath = path.join(scratch, "traversal.clio-share.json");
		writeArchive(
			archivePath,
			archiveWith([
				archiveFile({
					type: "project-context",
					archivePath: "project/CLIO.md",
					relativePath: "CLIO.md",
					body: "clean\n",
				}),
				archiveFile({
					archivePath: "project/skills/bad/SKILL.md",
					relativePath: "../escape.md",
					body: "bad\n",
				}),
			]),
		);

		const plan = importShareArchive(archivePath, { cwd: dest, force: true });

		strictEqual(hasBlockingDiagnostics(plan), true);
		strictEqual(plan.actions.length, 0);
		strictEqual(existsSync(path.join(dest, "CLIO.md")), false);
		strictEqual(existsSync(path.join(dest, ".clio", "escape.md")), false);
		ok(plan.diagnostics.some((diagnostic) => diagnostic.message.includes("../escape.md")));
	});

	it("rejects a symlinked directory escape before writing any archive entry", () => {
		const dest = path.join(scratch, "dest");
		const outside = path.join(scratch, "outside");
		mkdirSync(path.join(dest, ".clio", "skills"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, path.join(dest, ".clio", "skills", "linked"), "dir");
		const archivePath = path.join(scratch, "symlink.clio-share.json");
		writeArchive(
			archivePath,
			archiveWith([
				archiveFile({
					type: "project-context",
					archivePath: "project/CLIO.md",
					relativePath: "CLIO.md",
					body: "clean\n",
				}),
				archiveFile({
					archivePath: "project/skills/linked/SKILL.md",
					relativePath: "linked/SKILL.md",
					body: "bad\n",
				}),
			]),
		);

		const plan = importShareArchive(archivePath, { cwd: dest, force: true });

		strictEqual(hasBlockingDiagnostics(plan), true);
		strictEqual(plan.actions.length, 0);
		strictEqual(existsSync(path.join(dest, "CLIO.md")), false);
		strictEqual(existsSync(path.join(outside, "SKILL.md")), false);
		ok(plan.diagnostics.some((diagnostic) => diagnostic.message.includes("linked/SKILL.md")));
	});

	it("imports a clean project archive and backs up an overwritten file", () => {
		const source = path.join(scratch, "source");
		const dest = path.join(scratch, "dest");
		mkdirSync(path.join(source, ".clio", "skills", "roundtrip"), { recursive: true });
		mkdirSync(dest, { recursive: true });
		writeFileSync(path.join(source, "CLIO.md"), "source context\n", "utf8");
		writeFileSync(path.join(source, ".clio", "skills", "roundtrip", "SKILL.md"), "source skill\n", "utf8");
		writeFileSync(path.join(dest, "CLIO.md"), "old context\n", "utf8");
		const archivePath = path.join(scratch, "clean.clio-share.json");
		writeShareArchive(archivePath, {
			cwd: source,
			scope: "project",
			includeContext: true,
			includeSkills: true,
			includePrompts: false,
			includeSettings: false,
			includeExtensions: false,
		});

		const plan = importShareArchive(archivePath, { cwd: dest, force: true });

		strictEqual(hasBlockingDiagnostics(plan), false);
		strictEqual(readFileSync(path.join(dest, "CLIO.md"), "utf8"), "source context\n");
		strictEqual(readFileSync(path.join(dest, "CLIO.md.bak"), "utf8"), "old context\n");
		strictEqual(readFileSync(path.join(dest, ".clio", "skills", "roundtrip", "SKILL.md"), "utf8"), "source skill\n");
	});

	it("reports written files and backups when a later write fails", () => {
		const dest = path.join(scratch, "dest");
		mkdirSync(path.join(dest, ".clio", "skills"), { recursive: true });
		writeFileSync(path.join(dest, ".clio", "skills", "blocked"), "not a directory\n", "utf8");
		const archivePath = path.join(scratch, "failure.clio-share.json");
		writeArchive(
			archivePath,
			archiveWith([
				archiveFile({
					type: "project-context",
					archivePath: "project/CLIO.md",
					relativePath: "CLIO.md",
					body: "clean\n",
				}),
				archiveFile({
					archivePath: "project/skills/blocked/SKILL.md",
					relativePath: "blocked/SKILL.md",
					body: "blocked\n",
				}),
			]),
		);

		const plan = importShareArchive(archivePath, { cwd: dest, force: true });

		strictEqual(hasBlockingDiagnostics(plan), true);
		deepStrictEqual(plan.recovery?.written, [path.join(dest, "CLIO.md")]);
		deepStrictEqual(plan.recovery?.backups, []);
		strictEqual(plan.recovery?.failed, path.join(dest, ".clio", "skills", "blocked", "SKILL.md"));
		strictEqual(readFileSync(path.join(dest, "CLIO.md"), "utf8"), "clean\n");
		strictEqual(readFileSync(path.join(dest, ".clio", "skills", "blocked"), "utf8"), "not a directory\n");
	});
});
