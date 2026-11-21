import { match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLayeredSettings, readStrictLayeredSettings } from "../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { bootAuthStatus } from "../../src/domains/providers/auth/boot-status.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import { type RuntimeAuthMetadata, resolveAuthTarget } from "../../src/domains/providers/auth/storage.js";
import { runCli } from "../harness/headless-run.js";
import { closeServer } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a trusted project's loopback target keeps the operator's key unless its runtime needs none", async (t) => {
	const home = await isolateClioEnv("clio-project-loopback-key-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		[
			"targets:",
			"  - id: openai",
			"    runtime: openai",
			"    url: http://127.0.0.1:31337/v1",
			"  - id: homeollama",
			"    runtime: ollama",
			"    url: http://127.0.0.1:11434",
			"",
		].join("\n"),
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const targets = readLayeredSettings(workspace).settings.targets;
	const openaiTarget = targets.find((target) => target.id === "openai");
	const ollamaTarget = targets.find((target) => target.id === "homeollama");
	ok(openaiTarget && ollamaTarget);
	const openai: RuntimeAuthMetadata = {
		id: "openai",
		tier: "cloud",
		auth: "api-key",
		credentialsEnvVar: "OPENAI_API_KEY",
	};
	const ollama: RuntimeAuthMetadata = { id: "ollama", tier: "local-native", auth: "none" };
	match(resolveAuthTarget(openaiTarget, openai).credentialRefusal ?? "", /at http:\/\/127\.0\.0\.1:31337\/v1/);
	strictEqual(bootAuthStatus(openaiTarget, openai).available, false);
	strictEqual(resolveAuthTarget(ollamaTarget, ollama).credentialRefusal, undefined);
	strictEqual(bootAuthStatus(ollamaTarget, ollama).available, true);
});

test("a project targets list that drops a user-only target warns against the project file instead of refusing boot", async (t) => {
	const home = await isolateClioEnv("clio-project-drops-target-");
	t.after(() => home.restore());
	const configDir = process.env.CLIO_CODER_CONFIG_DIR;
	ok(configDir);
	mkdirSync(configDir, { recursive: true });
	const userTargets = [
		"targets:",
		"  - id: copilot",
		"    runtime: github-copilot",
		"  - id: litellm",
		"    runtime: openai-compat",
		"    url: http://127.0.0.1:9/v1",
	];
	const rosters = ["fleet:", "  rosters:", "    senior:", "      members:"];
	for (const label of ["one", "two"]) rosters.push(`        - label: ${label}`, "          target: litellm");
	writeFileSync(
		join(configDir, "settings.yaml"),
		[...userTargets, ...rosters, "safety:", "  judge:", "    target: litellm", "    model: dummy", ""].join("\n"),
	);
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	const localFile = join(workspace, ".clio-coder", "settings.local.yaml");
	writeFileSync(
		localFile,
		"targets:\n  - id: copilot\n    runtime: github-copilot\n  - id: copilot-long\n    runtime: github-copilot\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);

	const layered = readStrictLayeredSettings(workspace);
	strictEqual(
		layered.settings.targets.some((target) => target.id === "litellm"),
		false,
		"no user route merged in",
	);
	strictEqual(layered.settings.safety.judge.target, null);
	strictEqual(layered.settings.safety.judge.model, null);
	strictEqual(layered.settings.fleet.rosters.senior, undefined);
	const dropped = layered.issues.filter((issue) => issue.message.includes("'litellm'"));
	strictEqual(dropped.length, 3);
	ok(dropped.every((issue) => issue.origin === "project.local"));
	strictEqual(layered.layers.find((layer) => layer.origin === "project.local")?.path, localFile);

	// A route naming a target no layer declares is still the user file's error.
	writeFileSync(
		join(configDir, "settings.yaml"),
		[...userTargets, "safety:", "  review:", "    target: ghost", ""].join("\n"),
	);
	throws(() => readStrictLayeredSettings(workspace), /safety\.review\.target: unknown target 'ghost'/);
});

test("a trusted project target that names its key variable is sent that variable and nothing else", async (t) => {
	const home = await isolateClioEnv("clio-project-named-key-");
	const saved = { team: process.env.TEAM_KEY, openai: process.env.OPENAI_API_KEY };
	t.after(() => {
		for (const [name, value] of [
			["TEAM_KEY", saved.team],
			["OPENAI_API_KEY", saved.openai],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		home.restore();
	});
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		"targets:\n  - id: team\n    runtime: openai\n    url: https://llm.team.example.org/v1\n    auth: { apiKeyEnvVar: TEAM_KEY }\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const target = readLayeredSettings(workspace).settings.targets.find((entry) => entry.id === "team");
	ok(target);
	const openai: RuntimeAuthMetadata = {
		id: "openai",
		tier: "cloud",
		auth: "api-key",
		credentialsEnvVar: "OPENAI_API_KEY",
	};
	const authTarget = resolveAuthTarget(target, openai);
	strictEqual(authTarget.credentialRefusal, undefined);
	const auth = openAuthStorage();
	auth.setApiKey("openai", "sk-stored-canary");
	process.env.OPENAI_API_KEY = "sk-env-canary";
	delete process.env.TEAM_KEY;
	// Unset, the operator's own openai key never stands in for the variable the project named.
	const unset = await auth.resolveForTarget(authTarget);
	strictEqual(unset.available, false);
	strictEqual(unset.apiKey, undefined);
	strictEqual(bootAuthStatus(target, openai).available, false);
	process.env.TEAM_KEY = "team-secret";
	const set = await auth.resolveForTarget(authTarget);
	strictEqual(set.apiKey, "team-secret");
	strictEqual(set.detail, "TEAM_KEY");
	strictEqual(auth.statusForTarget(authTarget).available, true);
	strictEqual(bootAuthStatus(target, openai).available, true);
});

// The stub listens on one of this host's non-loopback addresses, the case a loopback-only check would miss.
function hostAddress(): string | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
	}
	return undefined;
}

test("a trusted project's chat target URL never receives the environment API key", { timeout: 60_000 }, async (t) => {
	const address = hostAddress();
	if (!address) return t.skip("this host has no non-loopback IPv4 address");
	const home = await isolateClioEnv("clio-project-key-");
	t.after(() => home.restore());
	const authorization: Array<string | null> = [];
	const server = createServer((request, response) => {
		authorization.push(request.headers.authorization ?? null);
		request.resume();
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "stub", type: "invalid_request_error" } }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, address, resolve);
	});
	t.after(() => closeServer(server));
	const url = `http://${address}:${(server.address() as AddressInfo).port}/v1`;
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		`targets:\n  - id: projremote\n    runtime: openai\n    url: ${url}\n    defaultModel: gpt-stub\nchat:\n  target: projremote\n  model: gpt-stub\n`,
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);

	const env = { ...process.env, NODE_ENV: "test", NO_COLOR: "1", OPENAI_API_KEY: "sk-canary-test" };
	const run = await runCli(["--no-context-files", "run", "say hi"], { env, cwd: workspace });
	strictEqual(
		authorization.filter((header) => header !== null).length,
		0,
		`credential sent: ${authorization.join(",")}`,
	);
	strictEqual(run.code, 1, run.stdout + run.stderr);
	match(run.stdout + run.stderr, /does not send your stored or environment openai credential to a URL a project chose/);
});

test("a trusted project target whose named key is unset is refused before any request, in run and doctor", {
	timeout: 60_000,
}, async (t) => {
	const home = await isolateClioEnv("clio-project-named-key-unset-");
	t.after(() => home.restore());
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		request.resume();
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => closeServer(server));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(
		join(workspace, ".clio-coder", "settings.yaml"),
		`targets:\n  - id: team\n    runtime: openai-compat\n    url: ${url}\n    defaultModel: mock-model\n    auth: { apiKeyEnvVar: TEAM_KEY }\nchat:\n  target: team\n  model: mock-model\n`,
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", NO_COLOR: "1" };
	delete env.TEAM_KEY;
	const named = /target team reads its key from \$TEAM_KEY, which is not set/;

	const run = await runCli(["--no-context-files", "--no-skills", "run", "--no-delegate", "say hi"], {
		env,
		cwd: workspace,
	});
	const runText = run.stdout + run.stderr;
	strictEqual(requests.length, 0, `requests reached the project URL: ${requests.join(", ")}`);
	strictEqual(run.code, 1, runText);
	match(runText, named);
	ok(!runText.includes("auth login"), runText);

	const doctor = await runCli(["doctor"], { env, cwd: workspace });
	const row = (doctor.stdout + doctor.stderr).split("\n").find((line) => /\bconnection team\b/.test(line));
	strictEqual(requests.length, 0, `doctor reached the project URL: ${requests.join(", ")}`);
	ok(row, doctor.stdout + doctor.stderr);
	match(row, named);
});
