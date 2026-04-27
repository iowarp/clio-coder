import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnClioPty } from "../harness/pty.js";
import { runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

function writeTargetFixture(home: string): void {
	writeFileSync(
		join(home, "settings.yaml"),
		[
			"version: 1",
			"identity: clio",
			"defaultMode: default",
			"safetyLevel: auto-edit",
			"targets:",
			"  - id: anthropic-prod",
			"    runtime: anthropic",
			"    defaultModel: claude-sonnet-4-6",
			"    auth:",
			"      apiKeyEnvVar: ANTHROPIC_API_KEY",
			"orchestrator:",
			"  target: anthropic-prod",
			"  model: claude-sonnet-4-6",
			"  thinkingLevel: off",
			"workers:",
			"  default:",
			"    target: anthropic-prod",
			"    model: claude-sonnet-4-6",
			"    thinkingLevel: off",
			"scope: []",
			"budget:",
			"  sessionCeilingUsd: 5",
			"  concurrency: auto",
			"theme: default",
			"keybindings: {}",
			"state:",
			"  lastMode: default",
			"compaction:",
			"  threshold: 0.8",
			"  auto: true",
			"",
		].join("\n"),
		"utf8",
	);
}

describe("CLIO_SELF_DEV end-to-end", () => {
	let home: string;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "clio-selfdev-e2e-"));
		await runCli(["doctor", "--fix"], { env: { CLIO_HOME: home } });
		writeTargetFixture(home);
		// CLIO-dev.md must exist for the activation gate. The XDG fallback
		// resolves under CLIO_HOME, so seeding it here keeps the test
		// independent of the developer's real ~/.config/clio.
		writeFileSync(join(home, "CLIO-dev.md"), "# dev supplement (e2e)\n", "utf8");
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("clio --dev exits 1 on a protected branch when stdin is closed", async () => {
		const scratchRepo = mkdtempSync(join(tmpdir(), "clio-selfdev-protected-"));
		try {
			mkdirSync(join(scratchRepo, "src"), { recursive: true });
			writeFileSync(join(scratchRepo, "package.json"), '{"name":"fake","version":"0.0.0"}', "utf8");
			writeFileSync(join(scratchRepo, "src", "placeholder.ts"), "export const placeholder = true;\n", "utf8");
			// Initialize a fresh git repo on main with a single commit so
			// branch --show-current is unambiguous and git switch -c can run.
			execFileSync("git", ["-C", scratchRepo, "init", "-q", "-b", "main"]);
			execFileSync("git", ["-C", scratchRepo, "config", "user.email", "test@example.com"]);
			execFileSync("git", ["-C", scratchRepo, "config", "user.name", "test"]);
			execFileSync("git", ["-C", scratchRepo, "add", "."]);
			execFileSync("git", ["-C", scratchRepo, "commit", "-q", "-m", "initial"]);
			// CLIO-dev.md is already seeded under CLIO_HOME by the suite's
			// beforeEach so the WS5 gate passes before WS6's branch step runs.

			const result = await runCli(["--dev"], {
				env: { CLIO_HOME: home },
				cwd: scratchRepo,
				timeoutMs: 15_000,
			});
			strictEqual(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
			ok(result.stderr.includes("refusing to operate on main"), result.stderr);
			ok(result.stderr.includes("cancelled"), result.stderr);
			// No TUI banner should have been printed; the orchestrator returns
			// before buildBanner runs.
			ok(!result.stdout.includes("Clio Coder"), result.stdout);
		} finally {
			rmSync(scratchRepo, { recursive: true, force: true });
		}
	});

	it("clio --dev enables the self-development banner", async () => {
		const result = await runCli(["--dev"], { env: { CLIO_HOME: home }, timeoutMs: 15_000 });
		strictEqual(result.code, 0);
		ok(result.stdout.includes("--dev | CLIO_SELF_DEV=1"), result.stdout);
		ok(result.stdout.includes("watching src/"), result.stdout);
	});

	it("dashboard shows DEV MODE and footer flips to restart-required on engine edit", async () => {
		const readToolPath = join(REPO_ROOT, "src", "tools", "read.ts");
		const original = readFileSync(readToolPath, "utf8");
		const pty = spawnClioPty({
			env: { CLIO_HOME: home, CLIO_SELF_DEV: "1", ANTHROPIC_API_KEY: "sk-test" },
		});
		try {
			await pty.expect(/DEV MODE/, 8000);
			await pty.expect(/Clio Coder/, 8000);
			// touch read.ts (safe: change only a comment)
			const patched = original.replace("export const readTool", "/* hot-reload smoke test */\nexport const readTool");
			writeFileSync(readToolPath, patched);
			// Match the success glyph to ensure the hot-swap actually landed; a
			// bare `read\.ts` match would also catch the `⚠ read.ts: ...` failure
			// banner and false-pass.
			await pty.expect(/⚡\s+read\.ts\s+\(\d+ms\)/, 5000);
			// Now trigger a restart prompt via an engine-boundary file.
			const sessionTouch = join(REPO_ROOT, "src", "engine", "types.ts");
			const engineOriginal = readFileSync(sessionTouch, "utf8");
			try {
				writeFileSync(sessionTouch, `${engineOriginal}\n// hot-reload smoke test\n`);
				await pty.expect(/restart required/, 5000);
			} finally {
				writeFileSync(sessionTouch, engineOriginal);
			}
			ok(true);
		} finally {
			pty.kill();
			writeFileSync(readToolPath, original);
		}
	});
});
