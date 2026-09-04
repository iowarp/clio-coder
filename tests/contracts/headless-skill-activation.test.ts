import { match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");

const fixtures: OpenAICompatFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Scratch {
	root: string;
	configDir: string;
	env: NodeJS.ProcessEnv;
}

function scratchHome(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "clio-headless-skill-"));
	roots.push(root);
	return {
		root,
		configDir: join(root, "config"),
		env: {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			CLIO_CODER_HOME: root,
			CLIO_CODER_CONFIG_DIR: join(root, "config"),
			CLIO_CODER_DATA_DIR: join(root, "data"),
			CLIO_CODER_STATE_DIR: join(root, "state"),
			CLIO_CODER_CACHE_DIR: join(root, "cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
			CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
		},
	};
}

async function runCli(
	args: string[],
	options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd: ROOT,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	child.stdin.end();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timeout: ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`));
		}, options.timeoutMs ?? 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function writeSkill(dir: string, name: string): string {
	const directory = join(dir, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			`description: ${name} workflow for the headless activation contract.`,
			"allowed-tools: read, grep",
			"---",
			"",
			`HEADLESS_SKILL_BODY_${name.toUpperCase().replace(/-/gu, "_")}`,
			"",
		].join("\n"),
		"utf8",
	);
	return directory;
}

/** Every JSON line the run wrote, in order. */
function jsonEvents(stdout: string): Array<Record<string, unknown>> {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The tool result text the model was handed for its `context` call. */
function contextToolResult(events: Array<Record<string, unknown>>): string {
	const end = events.find((event) => event.type === "tool_execution_end" && event.toolName === "context");
	if (!end) return "";
	return JSON.stringify(end.result ?? end);
}

async function headlessSkillTurn(
	autonomy: string,
	skillName: string,
): Promise<{
	stdout: string;
	stderr: string;
	code: number | null;
	skillDir: string;
}> {
	const scratch = scratchHome();
	const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
	strictEqual(fixed.code, 0, fixed.stderr);
	// One scripted tool call per turn: the model asks to load the skill by name,
	// which is the call that is operator-gated today at every level.
	const fixture = await startOpenAICompatFixture("done", {
		toolCall: { name: "context", arguments: { scope: "skills", name: skillName } },
	});
	fixtures.push(fixture);
	seedOpenAICompatToolOrchestrator(scratch.configDir, fixture.url, autonomy);
	const skillDir = writeSkill(scratch.root, "headless-interview");
	const turn = await runCli(
		[
			"--no-context-files",
			"--skill",
			skillDir,
			"run",
			"--autonomy",
			autonomy,
			"--json-events",
			"full",
			"HEADLESS_SKILL_ACTIVATION",
		],
		{ env: scratch.env },
	);
	return { ...turn, skillDir };
}

describe("headless skill activation by autonomy level", () => {
	it("activates an installed skill on a model call at full-auto", async () => {
		const turn = await headlessSkillTurn("full-auto", "headless-interview");
		strictEqual(turn.code, 0, turn.stderr);
		const events = jsonEvents(turn.stdout);
		const result = contextToolResult(events);
		match(result, /HEADLESS_SKILL_BODY_HEADLESS_INTERVIEW/u, turn.stdout);
		const notices = events
			.filter((event) => event.type === "notice")
			.map((event) => String(event.text ?? ""))
			.join("\n");
		match(notices, /Skill activated: headless-interview \(model\)/u, turn.stdout);
	});

	it("keeps activation operator-gated at suggest", async () => {
		const turn = await headlessSkillTurn("suggest", "headless-interview");
		strictEqual(turn.code, 0, turn.stderr);
		const result = contextToolResult(jsonEvents(turn.stdout));
		match(result, /only the operator can activate a skill/u, turn.stdout);
		ok(!/HEADLESS_SKILL_BODY_/u.test(result), "the skill body must not reach the model at suggest");
	});

	it("still refuses an uninstalled marketplace skill at full-auto", async () => {
		const turn = await headlessSkillTurn("full-auto", "not-installed-anywhere");
		strictEqual(turn.code, 0, turn.stderr);
		const result = contextToolResult(jsonEvents(turn.stdout));
		ok(!/HEADLESS_SKILL_BODY_/u.test(result), "an uninstalled skill must not load");
	});
});
