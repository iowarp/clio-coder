import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as pty from "node-pty";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SETTINGS_JSON =
	'{"version":1,"identity":"clio","defaultMode":"default","safetyLevel":"auto-edit","endpoints":[{"id":"anthropic-prod","runtime":"anthropic","defaultModel":"claude-sonnet-4-6","auth":{"apiKeyEnvVar":"ANTHROPIC_API_KEY"}}],"orchestrator":{"target":"anthropic-prod","model":"claude-sonnet-4-6","thinkingLevel":"off"},"workers":{"default":{"target":"anthropic-prod","model":"claude-sonnet-4-6","thinkingLevel":"off"},"profiles":{}},"scope":[],"budget":{"sessionCeilingUsd":5,"concurrency":"auto"},"theme":"default","keybindings":{}}';

function buildPrivateDistTo(outDir: string): void {
	execFileSync("npx", ["tsup", "--out-dir", outDir], {
		cwd: REPO_ROOT,
		env: { ...process.env, CLIO_BUILD_PRIVATE: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	// The bundle marks `yaml`, `chalk`, the pi-* SDKs, etc. as runtime deps.
	// Symlink node_modules so bare-specifier resolution works when running
	// from the temp out-dir.
	symlinkSync(join(REPO_ROOT, "node_modules"), join(outDir, "node_modules"), "dir");
	// resolvePackageRoot walks up looking for package.json. Provide one here so
	// CLIO_PACKAGE_ROOT-less callers and the import resolver see a sane root.
	writeFileSync(join(outDir, "package.json"), '{"name":"clio-private-dist-test","type":"module"}');
}

function tmpRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "clio-selfdev-private-dist-"));
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "package.json"), '{"name":"tmp","version":"0.0.0"}');
	writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "CLIO-dev.md"), "# private dist gate\n");
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "selfdev-test"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
	return repo;
}

function writeSettings(configDir: string): void {
	writeFileSync(join(configDir, "settings.yaml"), SETTINGS_JSON);
}

function waitFor(child: pty.IPty, pattern: RegExp, timeoutMs = 12_000): Promise<void> {
	let buffer = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timeout waiting for ${pattern}; output=${buffer.slice(-400)}`)),
			timeoutMs,
		);
		child.onData((chunk) => {
			buffer += chunk;
			if (!pattern.test(buffer)) return;
			clearTimeout(timer);
			resolve();
		});
	});
}

describe("CLIO_BUILD_PRIVATE=1 dist boot", () => {
	it("private bundle exports the selfdev tool factories and registration helper", async () => {
		const distRoot = mkdtempSync(join(tmpdir(), "clio-private-dist-exports-"));
		try {
			buildPrivateDistTo(distRoot);
			ok(existsSync(join(distRoot, "selfdev", "index.js")), "private build should emit dist/selfdev/index.js");
			const mod = (await import(join(distRoot, "selfdev", "index.js"))) as Record<string, unknown>;
			strictEqual(typeof mod.registerSelfDevTools, "function", "registerSelfDevTools missing");
			strictEqual(typeof mod.clioIntrospectTool, "function", "clioIntrospectTool missing");
			strictEqual(typeof mod.clioRecallTool, "function", "clioRecallTool missing");
			strictEqual(typeof mod.clioRememberTool, "function", "clioRememberTool missing");
			strictEqual(typeof mod.resolveSelfDevMode, "function", "resolveSelfDevMode missing");
			strictEqual(typeof mod.createSelfDevFooterLine, "function", "createSelfDevFooterLine missing");
			strictEqual(typeof mod.renderDevMemoryFragment, "function", "renderDevMemoryFragment missing");
		} finally {
			rmSync(distRoot, { recursive: true, force: true });
		}
	});

	it("private dist clio --dev boots the TUI and registers selfdev tools in a scratch repo", async () => {
		const distRoot = mkdtempSync(join(tmpdir(), "clio-private-dist-boot-"));
		const home = makeScratchHome();
		const repo = tmpRepo();
		try {
			buildPrivateDistTo(distRoot);
			await runCli(["doctor", "--fix"], { env: home.env });
			writeSettings(home.env.CLIO_CONFIG_DIR ?? home.dir);
			const child = pty.spawn(process.execPath, [join(distRoot, "cli", "index.js"), "--dev"], {
				name: "xterm-256color",
				cols: 120,
				rows: 40,
				cwd: repo,
				env: {
					...process.env,
					...home.env,
					CLIO_INTERACTIVE: "1",
					CLIO_PACKAGE_ROOT: REPO_ROOT,
					ANTHROPIC_API_KEY: "sk-test",
					TERM: "xterm-256color",
				},
			});
			try {
				await waitFor(child, /selfdev branch=/, 15_000);
			} finally {
				child.kill();
			}
		} finally {
			home.cleanup();
			rmSync(repo, { recursive: true, force: true });
			rmSync(distRoot, { recursive: true, force: true });
		}
	});
});
