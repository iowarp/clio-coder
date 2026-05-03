import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as pty from "node-pty";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const SETTINGS_JSON =
	'{"version":1,"identity":"clio","defaultMode":"default","safetyLevel":"auto-edit","endpoints":[{"id":"anthropic-prod","runtime":"anthropic","defaultModel":"claude-sonnet-4-6","auth":{"apiKeyEnvVar":"ANTHROPIC_API_KEY"}}],"orchestrator":{"target":"anthropic-prod","model":"claude-sonnet-4-6","thinkingLevel":"off"},"workers":{"default":{"target":"anthropic-prod","model":"claude-sonnet-4-6","thinkingLevel":"off"},"profiles":{}},"scope":[],"budget":{"sessionCeilingUsd":5,"concurrency":"auto"},"theme":"default","keybindings":{}}';
function writeSettings(configDir: string): void {
	writeFileSync(join(configDir, "settings.yaml"), SETTINGS_JSON);
}

function tmpRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "clio-selfdev-footer-"));
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "package.json"), '{"name":"tmp","version":"0.0.0"}');
	writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "CLIO-dev.md"), "# dev gate\n");
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "selfdev-test"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
	return repo;
}

function waitFor(child: pty.IPty, pattern: RegExp): Promise<void> {
	let buffer = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timeout waiting for ${pattern}; output=${buffer.slice(-300)}`)),
			8000,
		);
		child.onData((chunk) => {
			buffer += chunk;
			if (!pattern.test(buffer)) return;
			clearTimeout(timer);
			resolve();
		});
	});
}

it("shows the passive selfdev footer in source dev mode", async () => {
	const home = makeScratchHome();
	const repo = tmpRepo();
	await runCli(["doctor", "--fix"], { env: home.env });
	writeSettings(home.env.CLIO_CONFIG_DIR ?? home.dir);
	const child = pty.spawn(
		process.execPath,
		["--import", TSX_LOADER, join(REPO_ROOT, "src", "cli", "index.ts"), "--dev"],
		{
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
		},
	);
	try {
		await waitFor(child, /selfdev branch=/);
	} finally {
		child.kill();
		home.cleanup();
		rmSync(repo, { recursive: true, force: true });
	}
});
