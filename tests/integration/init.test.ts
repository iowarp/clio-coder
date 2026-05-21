import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
