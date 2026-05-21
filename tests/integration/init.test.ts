import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseClioMd } from "../../src/domains/context/clio-md.js";
import { type CodewikiEntry, readCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import { runBootstrap } from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";
import { findSymbolTool } from "../../src/tools/codewiki/find-symbol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "sample-ts-project");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(previous);
	}
}

describe("clio init", () => {
	it("writes CLIO.md, .clio/state.json, and .gitignore for a fixture repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-init-"));
		try {
			cpSync(fixture, dir, { recursive: true });
			const result = await runBootstrap({
				cwd: dir,
				confirmGitignore: () => true,
				modelId: "stub-model",
				now: () => new Date("2026-05-01T00:00:00.000Z"),
				generate: () => ({
					projectName: "Sample Ts Project",
					identity: "Sample Ts Project is a TypeScript project. It is a small fixture for init tests.",
					conventions: ["Local imports end in `.js`. Tests use `node:test`."],
					invariants: [],
				}),
			});

			ok(existsSync(join(dir, "CLIO.md")));
			ok(existsSync(join(dir, ".clio", "state.json")));
			ok(existsSync(join(dir, ".clio", "codewiki.json")));
			ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(".clio/"));
			strictEqual(result.projectType, "typescript");
			strictEqual(result.summary.action, "wrote");
			strictEqual(result.summary.contextFileCount, 1);
			strictEqual(result.summary.codewikiEntries, 2);
			const parsed = parseClioMd(readFileSync(join(dir, "CLIO.md"), "utf8"));
			ok(parsed.ok);
			if (parsed.ok) strictEqual(parsed.value.fingerprint?.model, "stub-model");
			const state = readClioState(dir);
			strictEqual(state?.projectType, "typescript");
			strictEqual(state?.lastIndexedAt, "2026-05-01T00:00:00.000Z");
			const codewiki = readCodewiki(dir);
			strictEqual(
				codewiki?.entries.some((entry) => entry.exports.includes("value")),
				true,
			);
			await withCwd(dir, async () => {
				const found = await findSymbolTool.run({ symbol: "value" });
				strictEqual(found.kind, "ok");
				if (found.kind === "ok") {
					const parsed = JSON.parse(found.output) as { entries?: CodewikiEntry[] };
					strictEqual(parsed.entries?.[0]?.path, "src/index.ts");
				}
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prints compact init output instead of dumping git status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-init-ui-"));
		try {
			cpSync(fixture, dir, { recursive: true });
			git(dir, "init", "--initial-branch=main", "-q");
			git(dir, "config", "user.email", "clio@example.test");
			git(dir, "config", "user.name", "Clio Test");
			git(dir, "add", ".");
			git(dir, "commit", "-m", "initial", "-q");
			const stdout: string[] = [];
			const stderr: string[] = [];
			const result = await runBootstrap({
				cwd: dir,
				confirmGitignore: () => true,
				modelId: "stub-model",
				now: () => new Date("2026-05-01T00:00:00.000Z"),
				io: {
					stdout: (s) => stdout.push(s),
					stderr: (s) => stderr.push(s),
				},
				generate: () => ({
					projectName: "Sample Ts Project",
					identity: "Sample Ts Project is a TypeScript project. It is a small fixture for init tests.",
					conventions: ["Local imports end in `.js`. Tests use `node:test`."],
					invariants: [],
				}),
			});

			const rendered = stdout.join("");
			ok(rendered.includes("clio init wrote CLIO.md"), rendered);
			ok(rendered.includes("folded 1 context file (CLAUDE.md)"), rendered);
			ok(rendered.includes("codewiki rebuilt 2 entries"), rendered);
			ok(rendered.includes("fingerprint updated"), rendered);
			ok(rendered.includes("workspace has 2 dirty files"), rendered);
			ok(!rendered.includes("git status --short"), rendered);
			ok(!rendered.includes("M CLIO.md"), rendered);
			strictEqual(stderr.join(""), "");
			strictEqual(result.summary.dirtyFiles, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("previews adoption without writing files and keeps output compact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-init-preview-"));
		try {
			cpSync(fixture, dir, { recursive: true });
			mkdirSync(join(dir, ".github"), { recursive: true });
			writeFileSync(
				join(dir, ".github", "copilot-instructions.md"),
				"- Always use pnpm for package management.\n",
				"utf8",
			);
			const stdout: string[] = [];
			const result = await runBootstrap({
				cwd: dir,
				preview: true,
				adopt: true,
				modelId: "stub-model",
				now: () => new Date("2026-05-01T00:00:00.000Z"),
				io: { stdout: (s) => stdout.push(s), stderr: () => {} },
			});

			const rendered = stdout.join("");
			ok(rendered.includes("clio init preview"), rendered);
			ok(rendered.includes("no files written"), rendered);
			ok(rendered.includes("adoption scanned"), rendered);
			ok(!rendered.includes("Always use pnpm"), rendered);
			ok(rendered.trim().split("\n").length <= 3, rendered);
			strictEqual(existsSync(join(dir, "CLIO.md")), false);
			strictEqual(existsSync(join(dir, ".clio", "state.json")), false);
			strictEqual(result.summary.action, "previewed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("adopts provenance-rich agent context into CLIO.md and records source fingerprints", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-init-adopt-"));
		try {
			cpSync(fixture, dir, { recursive: true });
			writeFileSync(join(dir, "CLAUDE.md"), "- Prefer pnpm for package management.\n", "utf8");
			writeFileSync(join(dir, "AGENTS.md"), "- Prefer npm for package management.\n", "utf8");
			const result = await runBootstrap({
				cwd: dir,
				adopt: true,
				confirmGitignore: () => true,
				modelId: "stub-model",
				now: () => new Date("2026-05-01T00:00:00.000Z"),
			});

			const clio = readFileSync(join(dir, "CLIO.md"), "utf8");
			ok(clio.includes("## Imported agent context"), clio);
			ok(clio.includes("Sources: `CLAUDE.md`"), clio);
			ok(clio.includes("Skipped conflicts"), clio);
			const parsed = parseClioMd(clio);
			ok(parsed.ok);
			if (parsed.ok) ok(parsed.value.importedAgentContext?.includes("Source provenance"));
			const state = readClioState(dir);
			ok(state?.contextSources && state.contextSources.length >= 2);
			ok(state?.contextSourceHash);
			strictEqual(result.summary.adoption.mode, "adopt");
			strictEqual(result.summary.adoption.conflictCount, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
