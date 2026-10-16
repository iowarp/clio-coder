import { ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	hasToolExchange,
	type OpenAICompatFixture,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

const GATE_ENTRY = `export default (api) => { api.hook("before_tool", () => ({ effects: [{ kind: "block_tool", reason: "desk gate closed" }] })); };\n`;

async function installGate(scratch: HeadlessScratch, cwd: string, entry = GATE_ENTRY): Promise<void> {
	const source = join(scratch.root, "gate");
	mkdirSync(source);
	writeFileSync(
		join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "desk_guard",
			name: "Desk guard",
			version: "1.0.0",
			description: "Closes the read gate",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				hooks: [{ on: "before_tool", tools: ["read"], timeoutMs: 2000, onTimeout: "block", onError: "block" }],
			},
		}),
	);
	writeFileSync(join(source, "extension.mjs"), entry);
	const installed = await runCli(["extensions", "install", source, "--user"], { env: scratch.env, cwd });
	ok(installed.code === 0, installed.stderr);
}

describe("fleet run worker extension hooks", () => {
	const fixtures: OpenAICompatFixture[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	it("refuses a fleet run worker's read through an installed gate hook", { timeout: 120_000 }, async () => {
		const scratch = headlessScratch("clio-coder-fleet-worker-hook-");
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture("done", {
			toolCall: (request) => (hasToolExchange(request) ? null : { name: "read", arguments: { path: "input.txt" } }),
		});
		fixtures.push(fixture);
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
		seedOpenAICompatFleetDefault(scratch.configDir);
		const project = join(scratch.root, "project");
		mkdirSync(join(project, ".clio-coder", "playbooks"), { recursive: true });
		writeFileSync(join(project, "input.txt"), "secret fixture\n");
		writeFileSync(
			join(project, ".clio-coder", "playbooks", "probe.md"),
			[
				"---",
				"version: 3",
				"name: probe",
				'description: "One read-only coder step."',
				"steps:",
				"  - kind: agent",
				"    id: look",
				"    agent: coder",
				"    scope: readonly",
				"    dependencies: []",
				"maxWorkers: 1",
				"onFailure: stop",
				"---",
				"",
				"Read input.txt.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(project, ".clio-coder", "playbooks", "commands.yaml"),
			"version: 1\ncommands:\n  noop:\n    argv: [node, -e, '0']\n",
		);
		await installGate(scratch, project);
		const run = await runCli(["fleet", "run", "probe"], { env: scratch.env, cwd: project, timeoutMs: 90_000 });
		const answered = fixture.requests.filter((request) => request.stream !== false && hasToolExchange(request));
		ok(answered.length > 0, `the worker never returned a tool result (exit ${run.code}): ${run.stderr}`);
		const results = JSON.stringify(answered.map((request) => request.messages));
		ok(results.includes("desk gate closed"), "the gate's verdict never reached the worker");
		ok(!results.includes("secret fixture"), "the worker read the file past the gate");
	});

	it("refuses at route preflight a playbook whose later step routes past a blocking hook", {
		timeout: 120_000,
	}, async () => {
		const scratch = headlessScratch("clio-coder-fleet-hook-preflight-");
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture("done");
		fixtures.push(fixture);
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
		seedOpenAICompatFleetDefault(scratch.configDir);
		const settingsPath = join(scratch.configDir, "settings.yaml");
		writeFileSync(
			settingsPath,
			readFileSync(settingsPath, "utf8").replace(
				/^targets:$/m,
				"targets:\n  - id: sdk\n    runtime: claude-sdk\n    defaultModel: claude-fixture",
			),
		);
		const project = join(scratch.root, "project");
		mkdirSync(join(project, ".clio-coder", "playbooks"), { recursive: true });
		writeFileSync(
			join(project, ".clio-coder", "playbooks", "probe.md"),
			[
				"---",
				"version: 5",
				"name: probe",
				'description: "A native step, then an SDK step no hook reaches."',
				"steps:",
				"  - kind: agent",
				"    id: look",
				"    agent: coder",
				"    scope: readonly",
				"    dependencies: []",
				"  - kind: agent",
				"    id: hand",
				"    agent: scout",
				"    target: sdk",
				"    scope: readonly",
				"    dependencies: [look]",
				"maxWorkers: 1",
				"onFailure: stop",
				"---",
				"",
				"Inspect the project.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(project, ".clio-coder", "playbooks", "commands.yaml"),
			"version: 1\ncommands:\n  noop:\n    argv: [node, -e, '0']\n",
		);
		// Version 5 enforces write boundaries, which compare a git checkout.
		execFileSync("git", ["init", "-q"], { cwd: project });
		await installGate(scratch, project);
		const run = await runCli(["fleet", "run", "probe"], { env: scratch.env, cwd: project, timeoutMs: 90_000 });
		ok(run.code !== 0, `the run passed preflight: ${run.stdout}`);
		ok(
			/route preflight failed: .*claude-sdk runtime cannot carry extension tool hooks.*desk_guard/u.test(run.stderr),
			run.stderr,
		);
		ok(
			fixture.requests.every((request) => request.stream === false),
			"an earlier step reached the model before preflight refused",
		);
	});
});

describe("context generation worker extension hooks", () => {
	const fixtures: OpenAICompatFixture[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	async function contextProject(
		prefix: string,
		options: Parameters<typeof startOpenAICompatFixture>[1] = {},
	): Promise<{ scratch: HeadlessScratch; fixture: OpenAICompatFixture; project: string }> {
		const scratch = headlessScratch(prefix);
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture("done", options);
		fixtures.push(fixture);
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
		seedOpenAICompatFleetDefault(scratch.configDir);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		writeFileSync(join(project, "README.md"), "# fixture\n");
		writeFileSync(join(project, "input.txt"), "secret fixture\n");
		execFileSync("git", ["init", "-q"], { cwd: project });
		return { scratch, fixture, project };
	}

	it("runs the wiki and bootstrap workers' reads through the command's extension host", {
		timeout: 180_000,
	}, async () => {
		const { scratch, fixture, project } = await contextProject("clio-coder-context-hook-host-", {
			toolCall: (request) => (hasToolExchange(request) ? null : { name: "read", arguments: { path: "input.txt" } }),
		});
		await installGate(scratch, project);
		for (const argv of [
			["context", "wiki"],
			["context", "init", "--yes"],
		]) {
			const before = fixture.requests.length;
			const run = await runCli(argv, { env: scratch.env, cwd: project, timeoutMs: 90_000 });
			const answered = fixture.requests
				.slice(before)
				.filter((request) => request.stream !== false && hasToolExchange(request));
			ok(answered.length > 0, `${argv.join(" ")} never returned a tool result (exit ${run.code}): ${run.stderr}`);
			const results = JSON.stringify(answered.map((request) => request.messages));
			ok(results.includes("desk gate closed"), `${argv.join(" ")}: the gate's verdict never reached the worker`);
			ok(!results.includes("secret fixture"), `${argv.join(" ")}: the worker read the file past the gate`);
		}
	});

	it("refuses the wiki and bootstrap workers when the extension host fails under a blocking hook", {
		timeout: 120_000,
	}, async () => {
		const { scratch, fixture, project } = await contextProject("clio-coder-context-hook-refusal-");
		await installGate(scratch, project, `throw new Error("desk guard cannot start");\n`);
		const refused = /extension host failed to start .*so the blocking tool hooks of desk_guard cannot run/u;
		const wiki = await runCli(["context", "wiki"], { env: scratch.env, cwd: project, timeoutMs: 90_000 });
		ok(wiki.code !== 0, `the wiki ran past the failed host: ${wiki.stdout}`);
		ok(refused.test(wiki.stderr), wiki.stderr);
		const init = await runCli(["context", "init", "--yes"], { env: scratch.env, cwd: project, timeoutMs: 90_000 });
		ok(refused.test(init.stderr), init.stderr);
		ok(
			fixture.requests.every((request) => request.stream === false),
			"a context worker reached the model past the failed host",
		);
	});
});
