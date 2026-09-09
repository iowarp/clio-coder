import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

it("headless commands refuse interactive actions before boot while preserving skills, templates, and prose", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-headless-slash-"));
	const config = join(root, "config");
	mkdirSync(join(config, "prompts"), { recursive: true });
	writeFileSync(join(config, "prompts", "local-check.md"), "---\ndescription: Local check\n---\nInspect $ARGUMENTS\n");
	const env = {
		...process.env,
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: config,
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		NO_COLOR: "1",
	};
	const run = (task: string) =>
		spawnSync(
			process.execPath,
			["--import", TSX, CLI, "run", "--target", "headless-slash-missing-target", "--json", task],
			{
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 15_000,
			},
		);
	try {
		for (const task of [
			"/context compact retain constraints",
			"/context reset",
			"/context init",
			"/context refresh",
			"/context",
			"/model mini",
			"/new",
			"/help",
			"/skill",
			"/skill off",
		]) {
			const result = run(task);
			strictEqual(result.error, undefined, task);
			strictEqual(result.status, 2, `${task}: ${result.stderr}`);
			match(result.stderr, /interactive commands are not supported by clio-coder run/, task);
			doesNotMatch(result.stdout, /"type":"(?:session|agent_start)"/, task);
			strictEqual(existsSync(join(root, "state", "sessions")), false, task);
		}
		// A missing explicit target stops these after command preflight but before
		// boot/inference. No provider fixture or model call is needed to prove
		// that supported prompt forms still reach the existing headless path.
		for (const task of [
			"/skill local-check inspect",
			"/local-check src",
			"/tmp/source.js needs inspection",
			"\\/tmp is full",
			"Inspect src",
		]) {
			const result = run(task);
			strictEqual(result.status, 2, `${task}: ${result.stderr}`);
			match(result.stderr, /target 'headless-slash-missing-target' not found/, task);
			doesNotMatch(result.stderr, /interactive commands are not supported|is not a command/, task);
		}
		match(run("/compact").stderr, /is not a command/);
		match(run("/not-a-real-command").stderr, /is not a command/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("headless run prints a display-only template to stdout and exits without booting", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-headless-display-"));
	const config = join(root, "config");
	mkdirSync(join(config, "prompts", "pkg"), { recursive: true });
	writeFileSync(
		join(config, "prompts", "pkg", "help.md"),
		"---\ndescription: Reference\ndisplay-only: true\n---\nDisplay the following:\n\n```\n━━━ pkg ━━━\n /pkg:help   This help\n```\n",
	);
	const env = {
		...process.env,
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: config,
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		NO_COLOR: "1",
	};
	try {
		for (const task of ["/pkg:help", "/pkg:help with arguments"]) {
			const result = spawnSync(
				process.execPath,
				["--import", TSX, CLI, "run", "--target", "headless-slash-missing-target", task],
				{ cwd: root, env, encoding: "utf8", timeout: 15_000 },
			);
			strictEqual(result.error, undefined, task);
			strictEqual(result.status, 0, `${task}: ${result.stderr}`);
			strictEqual(result.stdout, "━━━ pkg ━━━\n /pkg:help   This help\n", task);
			doesNotMatch(result.stderr, /not found|is not a command/, task);
			strictEqual(existsSync(join(root, "state", "sessions")), false, `${task}: no session was created`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
