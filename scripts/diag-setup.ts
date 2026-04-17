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
		active?: string | null;
		model?: string | null;
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
			endpoints?: Record<string, { url?: string; default_model?: string }>;
		};
		lmstudio?: {
			endpoints?: Record<string, { url?: string; default_model?: string }>;
		};
		ollama?: {
			endpoints?: Record<string, { url?: string; default_model?: string }>;
		};
		"openai-compat"?: {
			endpoints?: Record<string, { url?: string; default_model?: string }>;
		};
	};
	runtimes?: {
		enabled?: string[];
	};
	budget?: {
		sessionCeilingUsd?: number;
		concurrency?: string | number;
	};
	safetyLevel?: string;
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

function assertContains(stdout: string, expected: string, message: string): void {
	assert(stdout.includes(expected), message, stdout);
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

		const firstRun = await runInteractiveCli(["setup"], env, [
			{ when: "Local engines", answer: "1" },
			{ when: "Selection", answer: "2" },
			{ when: "Endpoint name", answer: "" },
			{ when: "Endpoint URL", answer: llama.url },
			{ when: "Detected models", answer: "1" },
			{ when: "use for chat target?", answer: "" },
			{ when: "use for worker target?", answer: "" },
			{ when: "what do you want to do?", answer: "8" },
		]);
		if (firstRun.exitCode !== 0) {
			fail("first-run clio setup failed", `${firstRun.stdout}\n${firstRun.stderr}`);
		}
		assertContains(firstRun.stdout, "Local engines", "first-run auto-advance did not reach add-or-edit");
		const afterFirstRun = readSettingsYaml(home);
		assertTarget(afterFirstRun, { provider: "llamacpp", endpoint: "mini", model: "mini-qwen" });
		assert(
			afterFirstRun.providers?.llamacpp?.endpoints?.mini?.url === llama.url,
			"llamacpp endpoint URL was not written",
		);
		log("first-run auto-advance and action 1 OK");

		const interactive = await runInteractiveCli(["setup"], env, [
			{ when: "what do you want to do?", answer: "3" },
			{ when: "what do you want to do?", answer: "2" },
			{ when: "Selection for chat", answer: "1" },
			{ when: "Selection", answer: "0" },
			{ when: "what do you want to do?", answer: "4" },
			{ when: "Selection", answer: "3" },
			{ when: "what do you want to do?", answer: "5" },
			{ when: "sessionCeilingUsd", answer: "7.5" },
			{ when: "concurrency", answer: "auto" },
			{ when: "what do you want to do?", answer: "7" },
			{ when: 'type "reset" to confirm', answer: "reset" },
			{ when: "what do you want to do?", answer: "8" },
		]);
		if (interactive.exitCode !== 0) {
			fail("existing-config clio setup flow failed", `${interactive.stdout}\n${interactive.stderr}`);
		}
		assertContains(interactive.stdout, "Probing all configured endpoints", "probe-all action not executed");
		assertContains(interactive.stdout, "settings reset", "reset flow did not report backup");
		assertContains(interactive.stdout, "no changes", "done-with-no-changes path not reached");
		const afterReset = readSettingsYaml(home);
		assert(
			afterReset.provider?.active === null ||
				afterReset.provider?.active === undefined ||
				afterReset.provider?.active === null,
			"reset did not clear active provider",
		);

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
