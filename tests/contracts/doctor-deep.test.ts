import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { contractDryRunFindings } from "../../src/cli/doctor-deep.js";
import { TOOL_PROBE_TOOL_NAME } from "../../src/domains/providers/probe/tool-call.js";
import { closeServer, readRequestBody, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "src", "cli", "index.ts");
// The CLI runs from a workspace outside the repository, so tsx is named by
// its resolved loader rather than by a bare specifier that cwd would resolve.
const TSX = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function workspaceWithContract(validators: string[]): string {
	const workspace = scratch("clio-doctor-deep-ws-");
	mkdirSync(join(workspace, ".clio-coder"));
	writeFileSync(
		join(workspace, ".clio-coder", "validation.yaml"),
		["version: 1", "validators:", ...validators.map((command) => `  - ${JSON.stringify(command)}`)].join("\n"),
	);
	return workspace;
}

describe("doctor --deep validation contract dry run", () => {
	it("resolves each validator program and reports the policy engine's verdict at the given autonomy", () => {
		const bin = scratch("clio-doctor-deep-bin-");
		const marker = join(bin, "ran");
		const tool = join(bin, "mytool");
		writeFileSync(tool, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		chmodSync(tool, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${savedPath ?? ""}`;
		cleanups.push(() => {
			process.env.PATH = savedPath;
		});
		const workspace = workspaceWithContract(["git status", "CI=1 mytool --check", "nosuchtool --x", "rm -rf /"]);

		const autoEdit = contractDryRunFindings({ workspaceRoot: workspace, autonomy: "default" });
		deepStrictEqual(
			autoEdit.map((f) => [f.name, f.level]),
			[
				["validator 1", "ok"],
				["validator 2", "warn"],
				["validator 3", "warn"],
				["validator 4", "warn"],
			],
		);
		match(autoEdit[0]?.detail ?? "", /^`git status`: git is \/\S+\/git; runs without approval at default$/);
		strictEqual(
			autoEdit[1]?.detail,
			`\`CI=1 mytool --check\`: mytool is ${tool}; asks for approval at default and runs at yolo; declare it in .clio-coder/safety.yaml to run it unattended`,
		);
		match(autoEdit[2]?.detail ?? "", /^`nosuchtool --x`: nosuchtool not found; /);
		match(autoEdit[3]?.detail ?? "", /; blocked by the safety policy \(damage-control:/);
		ok(autoEdit.every((f) => f.ok));

		const fullAuto = contractDryRunFindings({ workspaceRoot: workspace, autonomy: "yolo" });
		strictEqual(fullAuto[1]?.level, "ok");
		match(fullAuto[1]?.detail ?? "", /; runs without approval at yolo$/);
		match(fullAuto[3]?.detail ?? "", /; blocked by the safety policy/);

		// A dry run: the program resolved, and nothing executed it.
		strictEqual(existsSync(marker), false);
	});

	it("evaluates each validator with the session posture, as tool admission does", () => {
		const workspace = workspaceWithContract(["git log -n 1 $(git rev-parse HEAD)", "truncate -s 0 build.log"]);

		const atDefault = contractDryRunFindings({ workspaceRoot: workspace, autonomy: "default" });
		strictEqual(atDefault[0]?.level, "warn");
		match(
			atDefault[0]?.detail ?? "",
			/; asks for approval at default and runs at yolo \(bash-command-substitution\)$/,
			"an ordinary rail asks at default only",
		);
		strictEqual(atDefault[1]?.level, "warn");
		match(
			atDefault[1]?.detail ?? "",
			/; asks for confirmation at default and yolo \(damage-control:truncate-size-zero\)$/,
			"a damage-control confirmation asks at both levels",
		);

		const atYolo = contractDryRunFindings({ workspaceRoot: workspace, autonomy: "yolo" });
		strictEqual(atYolo[0]?.level, "ok", atYolo[0]?.detail);
		match(atYolo[0]?.detail ?? "", /; runs without approval at yolo$/);
		strictEqual(atYolo[1]?.level, "warn");
		match(atYolo[1]?.detail ?? "", /; asks for confirmation at default and yolo \(damage-control:truncate-size-zero\)$/);
		ok([...atDefault, ...atYolo].every((f) => !/every autonomy level/.test(f.detail)));
	});

	it("adds no rows without a parsed contract", () => {
		strictEqual(
			contractDryRunFindings({ workspaceRoot: scratch("clio-doctor-deep-empty-"), autonomy: "default" }).length,
			0,
		);
	});
});

interface DoctorJson {
	deep: boolean;
	findings: Array<{ ok: boolean; name: string; level?: string; detail: string }>;
}

async function runDoctor(target: Record<string, unknown>, args: string[], cwd: string): Promise<DoctorJson> {
	const root = scratch("clio-doctor-deep-home-");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: join(root, "config"),
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
	};
	mkdirSync(join(root, "config"), { recursive: true });
	writeFileSync(join(root, "config", "settings.yaml"), JSON.stringify({ targets: [target] }));
	// Doctor exits 1 on this minimal home (it was never initialized with
	// --fix); the report on stdout is what these tests read.
	const result = await execFileAsync(process.execPath, ["--import", TSX, CLI, "doctor", ...args], { cwd, env }).catch(
		(error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
	);
	return JSON.parse(result.stdout) as DoctorJson;
}

const OLLAMA_MODEL = "fixture:latest";

/** An Ollama server that loads a model on chat, streams one tool call, and records releases. */
async function ollamaServer() {
	const resident = new Set<string>();
	const releases: string[] = [];
	const server = createServer(async (req, res) => {
		const raw = req.method === "POST" ? await readRequestBody(req) : "";
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") {
			res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
		} else if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ model: OLLAMA_MODEL, name: OLLAMA_MODEL }] }));
		} else if (req.url === "/api/version") {
			res.end(JSON.stringify({ version: "0.34.0" }));
		} else if (req.url === "/api/show") {
			res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: {} }));
		} else if (req.url === "/api/generate") {
			const body = JSON.parse(raw) as { model: string; keep_alive: unknown };
			if (body.keep_alive === 0) {
				releases.push(body.model);
				resident.delete(body.model);
			}
			res.end(JSON.stringify({ done: true }));
		} else if (req.url === "/api/chat") {
			const body = JSON.parse(raw) as { model: string; tools?: unknown[]; stream?: boolean };
			resident.add(body.model);
			const base = { model: body.model, created_at: "2026-09-18T00:00:00Z" };
			const message = Array.isArray(body.tools)
				? {
						role: "assistant",
						content: "",
						tool_calls: [{ function: { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 } } }],
					}
				: { role: "assistant", content: "4" };
			if (body.stream === false) {
				res.end(JSON.stringify({ ...base, message, done: true, done_reason: "stop" }));
				return;
			}
			res.setHeader("content-type", "application/x-ndjson");
			res.write(`${JSON.stringify({ ...base, message, done: false })}\n`);
			res.end(
				`${JSON.stringify({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
			);
		} else {
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => closeServer(server));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { target: { id: "local-ollama", runtime: "ollama", url, defaultModel: OLLAMA_MODEL }, resident, releases };
}

describe("doctor --deep", () => {
	it("verifies a streamed tool call on an OpenAI-compatible target and dry-runs the contract, in --json", async () => {
		const server = await startOpenAICompatFixture("4", {
			toolCall: (request) =>
				Array.isArray(request.tools) ? { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 } } : null,
		});
		cleanups.push(() => closeServer(server.server));
		const workspace = workspaceWithContract(["git status"]);
		const target = { id: "compat", runtime: "openai-compat", url: server.url, defaultModel: "mock-model" };

		const report = await runDoctor(target, ["--deep", "--json", "--tools-timeout", "30"], workspace);

		strictEqual(report.deep, true);
		const tools = report.findings.find((f) => f.name === "tools compat");
		strictEqual(tools?.level, "ok");
		match(tools?.detail ?? "", /^mock-model streamed a valid tool call in \d+ms$/);
		strictEqual(server.requests.filter((request) => Array.isArray(request.tools)).length, 1);
		const validator = report.findings.find((f) => f.name === "validator 1");
		match(validator?.detail ?? "", /^`git status`: git is \S+; runs without approval at default$/);
		ok(report.findings.some((f) => f.name === "toolchain cc"));
	});

	it("probes an Ollama target and releases the model it loaded", async () => {
		const ollama = await ollamaServer();

		const report = await runDoctor(ollama.target, ["--deep", "--json"], scratch("clio-doctor-deep-plain-"));

		const tools = report.findings.find((f) => f.name === "tools local-ollama");
		strictEqual(tools?.level, "ok", tools?.detail);
		deepStrictEqual(ollama.releases, [OLLAMA_MODEL]);
		strictEqual(ollama.resident.size, 0);
		strictEqual(
			report.findings.some((f) => f.name.startsWith("validator ")),
			false,
		);
	});

	it("leaves the live probe out of plain doctor and rejects --tools-timeout without --deep", async () => {
		const server = await startOpenAICompatFixture("4");
		cleanups.push(() => closeServer(server.server));
		const target = { id: "compat", runtime: "openai-compat", url: server.url, defaultModel: "mock-model" };

		const report = await runDoctor(target, ["--json"], scratch("clio-doctor-deep-plain-"));

		strictEqual(report.deep, false);
		strictEqual(
			report.findings.some((f) => f.name.startsWith("tools ")),
			false,
		);
		strictEqual(
			server.requests.some((request) => Array.isArray(request.tools)),
			false,
		);
		const home = scratch("clio-doctor-deep-usage-");
		const usage = await execFileAsync(process.execPath, ["--import", TSX, CLI, "doctor", "--tools-timeout", "5"], {
			cwd: ROOT,
			env: { ...process.env, CLIO_CODER_HOME: home, CLIO_CODER_REQUIRE_HOME_PREFIX: "1" },
		}).catch((error: { code?: number; stderr?: string }) => error);
		strictEqual((usage as { code?: number }).code, 2);
		match((usage as { stderr?: string }).stderr ?? "", /--tools-timeout requires --deep/);
	});
});
