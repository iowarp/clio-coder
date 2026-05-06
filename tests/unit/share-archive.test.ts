import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	type ClioShareArchive,
	importShareArchive,
	planShareImport,
	writeShareArchive,
} from "../../src/domains/share/index.js";

let scratch: string;
let oldEnv: NodeJS.ProcessEnv;
let oldCwd: string;

beforeEach(() => {
	oldEnv = { ...process.env };
	oldCwd = process.cwd();
	scratch = mkdtempSync(join(tmpdir(), "clio-share-"));
	process.env.CLIO_HOME = join(scratch, "home");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	process.chdir(scratch);
});

afterEach(() => {
	process.env = oldEnv;
	process.chdir(oldCwd);
	resetXdgCache();
	rmSync(scratch, { recursive: true, force: true });
});

function writeProject(root: string): void {
	mkdirSync(join(root, ".clio", "prompts"), { recursive: true });
	mkdirSync(join(root, ".clio", "skills", "review"), { recursive: true });
	mkdirSync(join(root, ".clio", "extensions", "lab"), { recursive: true });
	writeFileSync(join(root, "CLIO.md"), "# Project\n\nUse local guidance.\n", "utf8");
	writeFileSync(join(root, ".clio", "prompts", "review.md"), "---\ndescription: Review\n---\nReview $1\n", "utf8");
	writeFileSync(
		join(root, ".clio", "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Review skill\n---\nUse review.\n",
		"utf8",
	);
	writeFileSync(
		join(root, ".clio", "extensions", "lab", "clio-extension.yaml"),
		"manifestVersion: 1\nid: lab\nname: lab\nversion: 1.0.0\ndescription: Lab\nresources:\n  prompts: prompts\n",
		"utf8",
	);
}

describe("share archive", () => {
	it("round-trips project context, prompts, skills, settings fragments, and extension bundles", () => {
		const source = join(scratch, "source");
		const dest = join(scratch, "dest");
		mkdirSync(source, { recursive: true });
		mkdirSync(dest, { recursive: true });
		writeProject(source);
		const archivePath = join(scratch, "bundle.clio-share.json");

		const archive = writeShareArchive(archivePath, { cwd: source, scope: "project" });
		strictEqual(archive.kind, "clio-share-archive");
		ok(archive.files.some((file) => file.type === "project-context"));
		ok(archive.files.some((file) => file.type === "prompt"));
		ok(archive.files.some((file) => file.type === "skill"));
		ok(archive.files.some((file) => file.type === "settings"));
		ok(archive.files.some((file) => file.type === "extension"));

		const plan = importShareArchive(archivePath, { cwd: dest });

		strictEqual(plan.diagnostics.filter((diag) => diag.type === "error" || diag.type === "conflict").length, 0);
		ok(existsSync(join(dest, "CLIO.md")));
		ok(existsSync(join(dest, ".clio", "prompts", "review.md")));
		ok(existsSync(join(dest, ".clio", "skills", "review", "SKILL.md")));
		ok(existsSync(join(dest, ".clio", "extensions", "lab", "clio-extension.yaml")));
	});

	it("reports version mismatch as a dry-run warning", () => {
		const source = join(scratch, "source");
		mkdirSync(source, { recursive: true });
		writeProject(source);
		const archivePath = join(scratch, "bundle.clio-share.json");
		const archive = writeShareArchive(archivePath, { cwd: source }) as ClioShareArchive;
		archive.manifest.clioVersion = "99.0.0";
		writeFileSync(archivePath, `${JSON.stringify(archive)}\n`, "utf8");

		const plan = planShareImport(archivePath, { cwd: join(scratch, "dest"), dryRun: true });

		ok(plan.diagnostics.some((diag) => diag.type === "warning" && diag.message.includes("99.0.0")));
	});

	it("reports conflicts in dry-run and preserves existing files until forced", () => {
		const source = join(scratch, "source");
		const dest = join(scratch, "dest");
		mkdirSync(source, { recursive: true });
		mkdirSync(dest, { recursive: true });
		writeProject(source);
		writeFileSync(join(dest, "CLIO.md"), "existing", "utf8");
		const archivePath = join(scratch, "bundle.clio-share.json");
		writeShareArchive(archivePath, { cwd: source });

		const plan = planShareImport(archivePath, { cwd: dest, dryRun: true });
		strictEqual(readFileSync(join(dest, "CLIO.md"), "utf8"), "existing");
		ok(plan.diagnostics.some((diag) => diag.type === "conflict"));

		const forced = importShareArchive(archivePath, { cwd: dest, force: true });
		strictEqual(
			forced.diagnostics.some((diag) => diag.type === "conflict"),
			false,
		);
		ok(readFileSync(join(dest, "CLIO.md"), "utf8").includes("Use local guidance."));
	});

	it("rejects corrupted archives and checksum mismatches", () => {
		const badJson = join(scratch, "bad.json");
		writeFileSync(badJson, "{", "utf8");
		const invalid = planShareImport(badJson);
		ok(invalid.diagnostics.some((diag) => diag.type === "error"));

		const source = join(scratch, "source");
		mkdirSync(source, { recursive: true });
		writeProject(source);
		const archivePath = join(scratch, "bundle.clio-share.json");
		const archive = writeShareArchive(archivePath, { cwd: source });
		const first = archive.files[0];
		ok(first);
		first.data = Buffer.from("tampered").toString("base64");
		writeFileSync(archivePath, `${JSON.stringify(archive)}\n`, "utf8");

		const corrupt = planShareImport(archivePath);
		ok(corrupt.diagnostics.some((diag) => diag.type === "error" && diag.message.includes("checksum")));
	});
});
