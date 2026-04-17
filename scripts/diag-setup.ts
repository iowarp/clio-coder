import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readSettings } from "../src/core/config.js";
import { resetXdgCache } from "../src/core/xdg.js";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");

interface SettingsYamlShape {
	provider?: {
		active?: string;
		model?: string;
	};
	orchestrator?: {
		provider?: string;
		endpoint?: string;
		model?: string;
	};
	workers?: {
		default?: {
			provider?: string;
			endpoint?: string;
			model?: string;
		};
	};
	providers?: {
		llamacpp?: {
			endpoints?: {
				mini?: {
					url?: string;
					default_model?: string;
				};
			};
		};
		lmstudio?: {
			endpoints?: {
				dynamo?: {
					url?: string;
					default_model?: string;
				};
			};
		};
	};
	runtimes?: {
		enabled?: string[];
	};
}

function log(message: string): void {
	process.stdout.write(`[diag-setup] ${message}\n`);
}

function fail(message: string, detail?: string): never {
	process.stderr.write(`[diag-setup] FAIL: ${message}\n`);
	if (detail) process.stderr.write(`${detail}\n`);
	process.exit(1);
}

function ensureBuilt(): void {
	if (existsSync(cliPath)) return;
	const result = spawnSync("npm", ["run", "build"], {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0) fail("npm run build failed before diag-setup");
}

async function runCli(
	args: string[],
	env: NodeJS.ProcessEnv,
	input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn(process.execPath, [cliPath, ...args], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	if (input !== undefined) child.stdin.end(input);
	else child.stdin.end();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
	return { stdout, stderr, exitCode };
}

async function runInteractiveCli(
	args: string[],
	env: NodeJS.ProcessEnv,
	steps: ReadonlyArray<{ when: string; answer: string }>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn(process.execPath, [cliPath, ...args], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let stepIndex = 0;
	let stdinClosed = false;

	const flush = (): void => {
		while (stepIndex < steps.length && stdout.includes(steps[stepIndex]?.when ?? "")) {
			child.stdin.write(`${steps[stepIndex]?.answer ?? ""}\n`);
			stepIndex += 1;
		}
		if (!stdinClosed && stepIndex >= steps.length) {
			child.stdin.end();
			stdinClosed = true;
		}
	};

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		flush();
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});

	return { stdout, stderr, exitCode };
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

function routeLlamacpp(req: IncomingMessage, res: ServerResponse): void {
	if (req.url === "/health") {
		json(res, 200, { status: "ok" });
		return;
	}
	if (req.url === "/v1/models") {
		json(res, 200, {
			data: [
				{ id: "mini-qwen", status: { value: "loaded" } },
				{ id: "mini-backup", status: { value: "loaded" } },
			],
		});
		return;
	}
	json(res, 404, { error: "not found" });
}

function routeLmstudio(req: IncomingMessage, res: ServerResponse): void {
	if (req.url === "/api/v0/models") {
		json(res, 200, {
			data: [
				{ id: "dynamo-qwen", type: "llm", state: "loaded" },
				{ id: "dynamo-backup", type: "llm", state: "loaded" },
			],
		});
		return;
	}
	if (req.url === "/v1/models") {
		json(res, 200, {
			data: [{ id: "dynamo-qwen" }, { id: "dynamo-backup" }],
		});
		return;
	}
	json(res, 404, { error: "not found" });
}

async function assertReachable(label: string, url: string, path: string): Promise<void> {
	const res = await fetch(`${url}${path}`);
	if (!res.ok) {
		fail(`${label} test server did not answer ${path}`, `HTTP ${res.status}`);
	}
}

async function startServer(route: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	url: string;
	close(): Promise<void>;
}> {
	const server = createServer(route);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo | null;
	if (!address) fail("test server did not expose an address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

function readSettingsYaml(home: string): SettingsYamlShape {
	const raw = readFileSync(join(home, "settings.yaml"), "utf8");
	const parsed = parseYaml(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		fail("settings.yaml did not parse into an object", raw);
	}
	return parsed as SettingsYamlShape;
}

function assert(condition: unknown, message: string, detail?: string): void {
	if (condition) return;
	fail(message, detail);
}

function checkDeepMerge(home: string): void {
	const prevHome = process.env.CLIO_HOME;
	process.env.CLIO_HOME = home;
	resetXdgCache();
	writeFileSync(join(home, "settings.yaml"), "version: 1\norchestrator:\n  provider: llamacpp\n", "utf8");
	const merged = readSettings();
	assert(merged.budget.sessionCeilingUsd === 5, "deep merge lost budget defaults");
	assert(typeof merged.workers.default === "object", "deep merge lost workers.default");
	assert(typeof merged.providers.lmstudio.endpoints === "object", "deep merge lost nested provider defaults");
	assert(merged.orchestrator.provider === "llamacpp", "deep merge did not keep the partial override");
	if (prevHome === undefined) process.env.CLIO_HOME = undefined;
	else process.env.CLIO_HOME = prevHome;
	resetXdgCache();
	log("deep merge readSettings() check OK");
}

function assertTarget(
	snapshot: SettingsYamlShape,
	expected: { provider: string; endpoint: string; model: string },
): void {
	assert(snapshot.provider?.active === expected.provider, "provider.active mismatch");
	assert(snapshot.provider?.model === expected.model, "provider.model mismatch");
	assert(snapshot.orchestrator?.provider === expected.provider, "orchestrator.provider mismatch");
	assert(snapshot.orchestrator?.endpoint === expected.endpoint, "orchestrator.endpoint mismatch");
	assert(snapshot.orchestrator?.model === expected.model, "orchestrator.model mismatch");
	assert(snapshot.workers?.default?.provider === expected.provider, "workers.default.provider mismatch");
	assert(snapshot.workers?.default?.endpoint === expected.endpoint, "workers.default.endpoint mismatch");
	assert(snapshot.workers?.default?.model === expected.model, "workers.default.model mismatch");
}

function assertProvidersJson(stdout: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		fail("clio providers --json did not return JSON", err instanceof Error ? err.message : String(err));
	}
	assert(Array.isArray(parsed), "clio providers --json did not return an array");
	const entries = parsed as Array<{ id?: string; endpoints?: Array<{ name?: string; probe?: { ok?: boolean } }> }>;
	const mini = entries.find((entry) => entry.id === "llamacpp");
	const dynamo = entries.find((entry) => entry.id === "lmstudio");
	assert(
		mini?.endpoints?.some((ep) => ep.name === "mini" && ep.probe?.ok === true),
		"llamacpp mini probe did not succeed",
	);
	assert(
		dynamo?.endpoints?.some((ep) => ep.name === "dynamo" && ep.probe?.ok === true),
		"lmstudio dynamo probe did not succeed",
	);
}

async function main(): Promise<void> {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-diag-setup-"));
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	const llama = await startServer(routeLlamacpp);
	const lmstudio = await startServer(routeLmstudio);

	try {
		await assertReachable("llamacpp", llama.url, "/health");
		await assertReachable("lmstudio", lmstudio.url, "/api/v0/models");

		const install = await runCli(["install"], env);
		if (install.exitCode !== 0) {
			fail("clio install failed", `${install.stdout}\n${install.stderr}`);
		}

		checkDeepMerge(home);

		const setupMini = await runInteractiveCli(["setup", "mini"], env, [
			{ when: "Endpoint URL", answer: llama.url },
			{ when: "Model id", answer: "mini-qwen" },
		]);
		if (setupMini.exitCode !== 0) {
			fail("clio setup mini failed", `${setupMini.stdout}\n${setupMini.stderr}`);
		}
		assert(
			setupMini.stdout.includes("saved llamacpp/mini/mini-qwen"),
			"clio setup mini did not save the probed model",
			setupMini.stdout,
		);
		assert(
			setupMini.stdout.includes("switch later with: clio setup dynamo"),
			"clio setup mini did not print the dynamo switch hint",
			setupMini.stdout,
		);

		const afterMini = readSettingsYaml(home);
		assertTarget(afterMini, { provider: "llamacpp", endpoint: "mini", model: "mini-qwen" });
		assert(
			afterMini.providers?.llamacpp?.endpoints?.mini?.url === llama.url,
			"llamacpp mini URL was not written correctly",
		);
		assert(
			afterMini.providers?.lmstudio?.endpoints?.dynamo?.url === "http://127.0.0.1:1234",
			"mini setup did not seed the later dynamo preset",
		);
		assert(
			Array.isArray(afterMini.runtimes?.enabled) && afterMini.runtimes.enabled.includes("llamacpp"),
			"mini setup did not enable the llamacpp runtime",
		);

		const setupDynamo = await runInteractiveCli(["setup", "dynamo"], env, [
			{ when: "Endpoint URL", answer: lmstudio.url },
			{ when: "Model id", answer: "dynamo-qwen" },
		]);
		if (setupDynamo.exitCode !== 0) {
			fail("clio setup dynamo failed", `${setupDynamo.stdout}\n${setupDynamo.stderr}`);
		}
		assert(
			setupDynamo.stdout.includes("saved lmstudio/dynamo/dynamo-qwen"),
			"clio setup dynamo did not save the probed model",
			setupDynamo.stdout,
		);

		const afterDynamo = readSettingsYaml(home);
		assertTarget(afterDynamo, { provider: "lmstudio", endpoint: "dynamo", model: "dynamo-qwen" });
		assert(
			afterDynamo.providers?.llamacpp?.endpoints?.mini?.default_model === "mini-qwen",
			"dynamo switch did not preserve the previous mini endpoint",
		);
		assert(
			afterDynamo.providers?.lmstudio?.endpoints?.dynamo?.url === lmstudio.url,
			"dynamo switch did not update the LM Studio URL",
		);
		assert(
			Array.isArray(afterDynamo.runtimes?.enabled) &&
				afterDynamo.runtimes.enabled.includes("llamacpp") &&
				afterDynamo.runtimes.enabled.includes("lmstudio"),
			"dynamo switch did not keep both local runtimes enabled",
		);

		const providers = await runCli(["providers", "--json"], env);
		if (providers.exitCode !== 0) {
			fail("clio providers --json failed after setup", `${providers.stdout}\n${providers.stderr}`);
		}
		assertProvidersJson(providers.stdout);
		log("guided mini -> dynamo setup flow OK");

		rmSync(home, { recursive: true, force: true });
		await llama.close();
		await lmstudio.close();
		process.exit(0);
	} catch (err) {
		process.stderr.write(`[diag-setup] keeping CLIO_HOME for post-mortem: ${home}\n`);
		try {
			await llama.close();
		} catch {}
		try {
			await lmstudio.close();
		} catch {}
		throw err;
	}
}

main().catch((err) => {
	fail("unexpected error", err instanceof Error ? err.stack : String(err));
});
