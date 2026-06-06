import { match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const PACKAGE_JSON = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};
const VERSION_STDOUT = `Clio Coder ${PACKAGE_JSON.version}\n`;

async function closeServer(server: Server | null): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});
}

async function startOpenAICompatFixture(reply: string): Promise<{
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
}> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		requests.push(JSON.parse(raw) as Record<string, unknown>);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: { content: reply } }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-clio-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${addr.port}`, requests };
}

function seedOpenAICompatOrchestrator(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(
			/^targets:.*$/m,
			[
				"targets:",
				"  - id: mock-chat",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    auth:",
				"      apiKeyEnvVar: CLIO_TEST_OPENAI_KEY",
				"    capabilities:",
				"      vision: true",
				"    wireModels:",
				"      - mock-model",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: mock-chat")
		.replace(/^ {2}model: null$/m, "  model: mock-model");
	writeFileSync(p, patched, "utf8");
}

function writeSkill(dir: string, name: string, description: string, body = "Skill body."): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const file = join(skillDir, "SKILL.md");
	writeFileSync(file, ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n"), "utf8");
	return file;
}

describe("clio cli smoke tests", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("--version exits 0 and prints the Clio Coder version", async () => {
		const result = await runCli(["--version"], { env: scratch.env });
		strictEqual(result.code, 0);
		strictEqual(result.stdout, VERSION_STDOUT);
	});

	it("--help exits 0 and prints usage instructions", async () => {
		const result = await runCli(["--help"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /Usage:/);
		match(result.stdout, /clio doctor/);
		match(result.stdout, /clio run \[flags\] <task>/);
	});

	it("doctor --fix bootstraps the configurations and environment", async () => {
		const result = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(result.code, 0);
		match(result.stdout, /config dir/);
		match(result.stdout, /data dir/);
		match(result.stdout, /cache dir/);
	});

	it("doctor without --fix reports findings and exit code 1", async () => {
		const result = await runCli(["doctor"], { env: scratch.env });
		strictEqual(result.code, 1);
		match(result.stdout, /settings.yaml/);
	});

	it("targets --json returns an object with a targets array", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["targets", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as { targets: unknown[] };
		ok(parsed && typeof parsed === "object");
		ok(Array.isArray(parsed.targets));
	});

	it("agents --json lists built-in recipes", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const result = await runCli(["agents", "--json"], { env: scratch.env });
		strictEqual(result.code, 0);
		const parsed = JSON.parse(result.stdout) as unknown[];
		ok(Array.isArray(parsed) && parsed.length > 0);
	});

	it("skills list, inspect, validate, and create work in a scratch project", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		const skillFile = writeSkill(join(project, ".clio", "skills"), "smoke-skill", "Smoke test skill.");

		const list = await runCli(["skills", "list", "--json", "--all"], { env: scratch.env, cwd: project });
		strictEqual(list.code, 0, `stderr=${list.stderr}`);
		const listed = JSON.parse(list.stdout) as { skills: Array<{ name: string }> };
		ok(listed.skills.some((skill) => skill.name === "smoke-skill"));

		const inspect = await runCli(["skills", "inspect", "smoke-skill", "--json"], { env: scratch.env, cwd: project });
		strictEqual(inspect.code, 0, `stderr=${inspect.stderr}`);
		const inspected = JSON.parse(inspect.stdout) as { skill: { name: string; path: string } };
		strictEqual(inspected.skill.name, "smoke-skill");

		const validate = await runCli(["skills", "validate", skillFile, "--json"], { env: scratch.env, cwd: project });
		strictEqual(validate.code, 0, `stderr=${validate.stderr}`);
		const validated = JSON.parse(validate.stdout) as { ok: boolean };
		strictEqual(validated.ok, true);

		const created = await runCli(["skills", "create", "cli-made"], { env: scratch.env, cwd: project });
		strictEqual(created.code, 0, `stderr=${created.stderr}`);
		ok(existsSync(join(project, ".clio", "skills", "cli-made", "SKILL.md")));
	});

	it("runs non-interactively against a mock provider", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(["--no-context-files", "run", "hello"], {
				env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				timeoutMs: 20_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "mock reply\n");
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("honors explicit --skill paths even with --no-skills", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		const explicitDir = join(scratch.dir, "explicit");
		const skillFile = writeSkill(explicitDir, "explicit-smoke", "Explicit smoke skill.", "Use explicit smoke guidance.");
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(
				["--no-context-files", "run", "--no-skills", "--skill", skillFile, "please use the skill named explicit-smoke"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					cwd: project,
					timeoutMs: 20_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(JSON.stringify(fixture.requests).includes("explicit-smoke"));
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("honors top-level skill flags before run subcommand", async () => {
		await runCli(["doctor", "--fix"], { env: scratch.env });
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		const explicitDir = join(scratch.dir, "explicit");
		const skillFile = writeSkill(
			explicitDir,
			"explicit-smoke-top",
			"Explicit smoke top skill.",
			"Use explicit smoke top guidance.",
		);
		const fixture = await startOpenAICompatFixture("mock reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const result = await runCli(
				["--no-context-files", "--no-skills", "--skill", skillFile, "run", "please use the skill named explicit-smoke-top"],
				{
					env: { ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
					cwd: project,
					timeoutMs: 20_000,
				},
			);
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			ok(JSON.stringify(fixture.requests).includes("explicit-smoke-top"));
		} finally {
			await closeServer(fixture.server);
		}
	});
});
