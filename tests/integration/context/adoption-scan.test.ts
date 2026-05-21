import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adoptionSourcesChanged, scanAgentConfigs } from "../../../src/domains/context/adoption.js";

function scratch(prefix: string): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

describe("context/adoption-scan", () => {
	it("discovers supported project-local agent config source types without claiming generated Antigravity state", () => {
		const t = scratch("clio-adopt-sources-");
		try {
			write(join(t.dir, "CLAUDE.md"), "- Always use pnpm for package management.\n");
			write(join(t.dir, ".claude", "CLAUDE.md"), "- Must run focused tests before broad suites.\n");
			write(
				join(t.dir, ".claude", "settings.json"),
				JSON.stringify({ permissions: { allow: ["Bash(npm test)"], deny: ["WebFetch"] } }),
			);
			write(join(t.dir, ".claude", "commands", "review.md"), "- Always inspect diffs before editing.\n");
			write(join(t.dir, ".claude", "agents", "tester.md"), "- Prefer small verification steps.\n");
			write(join(t.dir, "AGENTS.md"), "- Should keep changes minimal.\n");
			write(join(t.dir, "CODEX.md"), "- Avoid unrelated refactors.\n");
			write(join(t.dir, ".codex", "AGENTS.md"), "- Always mention skipped tests.\n");
			write(join(t.dir, ".codex", "skills", "review", "SKILL.md"), "- Must cite reviewed files.\n");
			write(join(t.dir, "GEMINI.md"), "- Prefer deterministic test fixtures.\n");
			write(join(t.dir, ".gemini", "GEMINI.md"), "- Keep generated state out of commits.\n");
			write(join(t.dir, ".gemini", "rules", "rules.md"), "- Always document safety assumptions.\n");
			write(join(t.dir, ".gemini", "config", "rules.md"), "- Use reproducible commands.\n");
			write(
				join(t.dir, ".cursor", "rules", "typescript.mdc"),
				"---\nalwaysApply: true\n---\n- Must use explicit return types for exported helpers.\n",
			);
			write(join(t.dir, ".cursor", "rules", "review.md"), "- Avoid broad search-and-replace edits.\n");
			write(join(t.dir, ".github", "copilot-instructions.md"), "- Should preserve public APIs unless requested.\n");
			write(join(t.dir, ".antigravitycli", "state.md"), "- Always ingest me.\n");

			const scan = scanAgentConfigs({ cwd: t.dir });
			const paths = scan.sources.map((source) => source.displayPath);
			for (const expected of [
				"CLAUDE.md",
				".claude/CLAUDE.md",
				".claude/settings.json",
				".claude/commands/review.md",
				".claude/agents/tester.md",
				"AGENTS.md",
				"CODEX.md",
				".codex/AGENTS.md",
				".codex/skills/review/SKILL.md",
				"GEMINI.md",
				".gemini/GEMINI.md",
				".gemini/rules/rules.md",
				".gemini/config/rules.md",
				".cursor/rules/typescript.mdc",
				".cursor/rules/review.md",
				".github/copilot-instructions.md",
			]) {
				ok(paths.includes(expected), `missing ${expected} in ${paths.join(", ")}`);
			}
			strictEqual(
				paths.some((path) => path.includes(".antigravitycli")),
				false,
			);
			strictEqual(new Set(scan.sources.map((source) => source.provider)).size, 5);
			ok(scan.importedRules.some((rule) => rule.text.includes("pnpm")));
			ok(scan.importedRules.every((rule) => rule.sources.length > 0));
		} finally {
			t.cleanup();
		}
	});

	it("uses project-local precedence and records conflicts instead of concatenating both rules", () => {
		const t = scratch("clio-adopt-conflict-");
		try {
			write(join(t.dir, "CLAUDE.md"), "- Prefer pnpm for package management.\n");
			write(join(t.dir, "AGENTS.md"), "- Prefer npm for package management.\n");

			const scan = scanAgentConfigs({ cwd: t.dir });
			strictEqual(scan.conflicts.length, 1);
			strictEqual(scan.conflicts[0]?.key, "package-manager");
			ok(scan.importedRules.some((rule) => rule.text.includes("pnpm")));
			strictEqual(
				scan.importedRules.some((rule) => /^Prefer npm\b/.test(rule.text)),
				false,
			);
			strictEqual(scan.conflicts[0]?.skipped[0]?.source, "AGENTS.md");
		} finally {
			t.cleanup();
		}
	});

	it("rejects secret-like content and never imports it", () => {
		const t = scratch("clio-adopt-secret-");
		try {
			write(
				join(t.dir, ".github", "copilot-instructions.md"),
				'- Always use pnpm.\napi_key = "sk-1234567890abcdefghijklmnop"\n',
			);
			const scan = scanAgentConfigs({ cwd: t.dir });
			strictEqual(scan.sources.length, 0);
			strictEqual(scan.rejected.length, 1);
			strictEqual(scan.rejected[0]?.reason, "secret-like content");
			strictEqual(JSON.stringify(scan).includes("sk-1234567890"), false);
		} finally {
			t.cleanup();
		}
	});

	it("requires explicit opt-in for global Codex AGENTS.md", () => {
		const t = scratch("clio-adopt-global-");
		const home = mkdtempSync(join(tmpdir(), "clio-adopt-home-"));
		try {
			write(join(home, ".codex", "AGENTS.md"), "- Prefer npm for personal projects.\n");

			const withoutOptIn = scanAgentConfigs({ cwd: t.dir, homeDir: home });
			strictEqual(withoutOptIn.sources.length, 0);

			const withOptIn = scanAgentConfigs({ cwd: t.dir, homeDir: home, includeGlobal: true });
			strictEqual(withOptIn.sources.length, 1);
			strictEqual(withOptIn.sources[0]?.scope, "global");
			strictEqual(withOptIn.sources[0]?.displayPath, "~/.codex/AGENTS.md");
		} finally {
			t.cleanup();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("tracks imported source hashes for stale detection", () => {
		const t = scratch("clio-adopt-stale-");
		try {
			const claude = join(t.dir, "CLAUDE.md");
			write(claude, "- Prefer pnpm for package management.\n");
			const scan = scanAgentConfigs({ cwd: t.dir });
			strictEqual(adoptionSourcesChanged(scan.sourceSnapshots), false);
			write(claude, "- Prefer pnpm for package management.\n- Always run focused tests.\n");
			strictEqual(adoptionSourcesChanged(scan.sourceSnapshots), true);
		} finally {
			t.cleanup();
		}
	});
});
